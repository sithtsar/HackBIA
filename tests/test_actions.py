"""Task 3: action push adapters. No network — httpx is monkeypatched."""
import asyncio
import base64

import httpx
import pytest

from backend.app import main
from backend.app.actions import ActionPushError, jira_payload, push_action
from backend.app.events import ActionProposal

JIRA_ENV = {
    "JIRA_BASE_URL": "https://foundry.atlassian.net",
    "JIRA_EMAIL": "bot@foundry.dev",
    "JIRA_API_TOKEN": "tok123",
    "JIRA_PROJECT": "FDRY",
}
ALL_ENV = [*JIRA_ENV, "SLACK_WEBHOOK_URL"]


def _action(id="act_0001", kind="jira"):
    return ActionProposal(
        id=id, kind=kind, title="Ticket spike in last 14 days",
        body="SLA breaches detected; investigate support queue.",
        insight_ref="insight_x", status="approved",
    )


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for k in ALL_ENV:
        monkeypatch.delenv(k, raising=False)
    main._actions.clear()
    main._pending.clear()
    main._insight_nodes.clear()
    main._action_nodes.clear()
    main._produces_edges.clear()
    yield


def _mock_transport(monkeypatch, handler):
    """Force every httpx.AsyncClient onto a MockTransport."""
    real = httpx.AsyncClient

    def fake(*args, **kwargs):
        # keep explicit transports (the tests' own ASGITransport client)
        kwargs.setdefault("transport", httpx.MockTransport(handler))
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", fake)


# --- mock mode -------------------------------------------------------------

def test_mock_mode_returns_deterministic_fake_urls():
    assert asyncio.run(push_action(_action(kind="jira"))) == "https://mock.jira.local/browse/FDRY-0001"
    assert asyncio.run(push_action(_action(id="act_0042", kind="slack"))) == "https://mock.slack.local/msg/0042"


# --- jira payload / auth ----------------------------------------------------

def test_jira_payload_builds_adf_from_title_and_body():
    p = jira_payload(_action(), "FDRY")
    f = p["fields"]
    assert f["project"] == {"key": "FDRY"}
    assert f["summary"] == "Ticket spike in last 14 days"
    assert f["issuetype"] == {"name": "Task"}
    assert f["description"] == {
        "type": "doc", "version": 1,
        "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "SLA breaches detected; investigate support queue."}
        ]}],
    }


def test_jira_push_sends_basic_auth_and_returns_browse_url(monkeypatch):
    for k, v in JIRA_ENV.items():
        monkeypatch.setenv(k, v)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        return httpx.Response(201, json={"id": "1", "key": "FDRY-7"})

    _mock_transport(monkeypatch, handler)
    url = asyncio.run(push_action(_action()))
    assert url == "https://foundry.atlassian.net/browse/FDRY-7"
    assert seen["url"] == "https://foundry.atlassian.net/rest/api/3/issue"
    expected = "Basic " + base64.b64encode(b"bot@foundry.dev:tok123").decode()
    assert seen["auth"] == expected


def test_http_failure_raises_action_push_error(monkeypatch):
    for k, v in JIRA_ENV.items():
        monkeypatch.setenv(k, v)
    _mock_transport(monkeypatch, lambda req: httpx.Response(400, text="bad project"))
    with pytest.raises(ActionPushError, match=r"jira push failed \(400\): bad project"):
        asyncio.run(push_action(_action()))


def test_slack_push_posts_text_to_webhook(monkeypatch):
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T/B/x")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.read().decode()
        return httpx.Response(200, text="ok")

    _mock_transport(monkeypatch, handler)
    url = asyncio.run(push_action(_action(kind="slack")))
    assert seen["url"] == "https://hooks.slack.com/services/T/B/x"
    assert "Ticket spike" in seen["body"]
    assert "hooks.slack.com" not in url  # webhook secret never leaks into events


# --- approval → push wiring (end-to-end over ASGI) ---------------------------

def _propose(action_id="act_0001", kind="jira"):
    main.bus.publish("action_proposed", {"action": _action(action_id, kind).model_dump() | {"status": "proposed"}})
    main.bus.publish("approval_required", {"subject_kind": "action", "subject_id": action_id})


async def _approve_and_collect(action_id, n_events):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as c:
        _propose(action_id)
        q = main.bus.subscribe()
        r = await c.post(f"/api/approvals/{action_id}", json={"decision": "approved"})
        events = [await asyncio.wait_for(q.get(), timeout=2) for _ in range(n_events)]
        main.bus.unsubscribe(q)
        return r, events


def test_approve_action_emits_resolved_then_pushed_and_marks_registry():
    r, (resolved, pushed) = asyncio.run(_approve_and_collect("act_0001", 2))
    assert r.status_code == 200
    assert resolved.type == "approval_resolved"
    assert resolved.payload == {"subject_kind": "action", "subject_id": "act_0001", "decision": "approved"}
    assert pushed.type == "action_pushed"
    assert pushed.payload == {"action_id": "act_0001", "external_url": "https://mock.jira.local/browse/FDRY-0001"}
    assert main._actions["act_0001"]["status"] == "pushed"
    assert "act_0001" not in main._pending


def test_push_error_emits_error_event_not_crash(monkeypatch):
    for k, v in JIRA_ENV.items():
        monkeypatch.setenv(k, v)
    _mock_transport(monkeypatch, lambda req: httpx.Response(500, text="boom"))
    r, (resolved, err) = asyncio.run(_approve_and_collect("act_0009", 2))
    assert r.status_code == 200
    assert resolved.type == "approval_resolved"
    assert err.type == "error"
    assert "jira push failed (500)" in err.payload["message"]
    assert main._actions["act_0009"]["status"] == "approved"  # never marked pushed


def test_approve_unknown_action_emits_error():
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as c:
            q = main.bus.subscribe()
            r = await c.post("/api/approvals/act_ghost", json={"decision": "approved"})
            events = [await asyncio.wait_for(q.get(), timeout=2) for _ in range(2)]
            main.bus.unsubscribe(q)
            return r, events

    r, (resolved, err) = asyncio.run(run())
    assert r.status_code == 200
    assert resolved.type == "approval_resolved"
    assert err.type == "error"
    assert "act_ghost" in err.payload["message"]
