"""Action push adapters (Jira Cloud / Slack webhook) per plan.md Task 3.

Missing env for a kind → clearly-labeled MOCK MODE: log one line, return a
deterministic fake external_url. The demo never blocks on missing creds.
HTTP failure → ActionPushError with the response detail; caller handles it.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from .events import ActionProposal

log = logging.getLogger("foundry.actions")


class ActionPushError(Exception):
    """A push attempt reached the network and failed."""


def jira_payload(action: ActionProposal, project: str) -> dict[str, Any]:
    """Jira Cloud REST v3 create-issue body: summary=title, description=body
    as a single ADF paragraph, issuetype Task."""
    return {
        "fields": {
            "project": {"key": project},
            "summary": action.title,
            "description": {
                "type": "doc",
                "version": 1,
                "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": action.body}]}
                ],
            },
            "issuetype": {"name": "Task"},
        }
    }


def _mock_url(action: ActionProposal) -> str:
    # ponytail: <n> = the action id suffix ("act_0001" -> "0001") —
    # deterministic per action, no counter state.
    n = action.id.removeprefix("act_")
    if action.kind == "jira":
        return f"https://mock.jira.local/browse/FDRY-{n}"
    return f"https://mock.slack.local/msg/{n}"


async def push_action(action: ActionProposal) -> str:
    """Push an approved action to its external system; return external_url."""
    if action.kind == "jira":
        base = os.getenv("JIRA_BASE_URL", "").rstrip("/")
        email = os.getenv("JIRA_EMAIL", "")
        token = os.getenv("JIRA_API_TOKEN", "")
        project = os.getenv("JIRA_PROJECT", "")
        if not (base and email and token and project):
            url = _mock_url(action)
            log.warning("MOCK MODE (jira env missing): not pushing %s, returning %s", action.id, url)
            return url
        async with httpx.AsyncClient(timeout=10, auth=(email, token)) as client:
            r = await client.post(f"{base}/rest/api/3/issue", json=jira_payload(action, project))
            if r.status_code >= 400:
                raise ActionPushError(f"jira push failed ({r.status_code}): {r.text[:300]}")
            return f"{base}/browse/{r.json()['key']}"

    # slack
    webhook = os.getenv("SLACK_WEBHOOK_URL", "")
    if not webhook:
        url = _mock_url(action)
        log.warning("MOCK MODE (slack env missing): not pushing %s, returning %s", action.id, url)
        return url
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(webhook, json={"text": f"*{action.title}*\n{action.body}"})
        if r.status_code >= 400:
            raise ActionPushError(f"slack push failed ({r.status_code}): {r.text[:300]}")
    # ponytail: incoming webhooks return no message URL, and the webhook URL
    # itself is a secret we must not leak into events.jsonl.
    return "https://slack.local/webhook-delivered"
