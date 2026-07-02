import json

from backend.app.events import DEMO_EVENTS_FILE, ActionProposal, Envelope, OntologyTerm

TERM_PAYLOAD_TYPES = {"ontology_term_proposed"}
ACTION_PAYLOAD_TYPES = {"action_proposed"}


def _lines():
    with open(DEMO_EVENTS_FILE) as f:
        return [json.loads(line) for line in f if line.strip()]


def test_every_line_parses_as_envelope():
    lines = _lines()
    assert len(lines) == 40
    envelopes = [Envelope.model_validate(line) for line in lines]
    assert all(e.id for e in envelopes)


def test_ids_strictly_increasing_and_well_formed():
    envelopes = [Envelope.model_validate(line) for line in _lines()]
    ids = [int(e.id.removeprefix("evt_")) for e in envelopes]
    assert ids == sorted(ids)
    assert ids == list(range(1, len(ids) + 1))


def test_embedded_ontology_terms_and_actions_validate():
    for line in _lines():
        if line["type"] in TERM_PAYLOAD_TYPES:
            OntologyTerm.model_validate(line["payload"]["term"])
        if line["type"] in ACTION_PAYLOAD_TYPES:
            ActionProposal.model_validate(line["payload"]["action"])


def test_tells_the_three_act_story():
    lines = _lines()
    types = [line["type"] for line in lines]
    run_kinds = {line["payload"]["kind"] for line in lines if line["type"] == "run_started"}
    assert run_kinds == {"draft", "ask", "action"}

    proposed = [line for line in lines if line["type"] == "ontology_term_proposed"]
    joins = [p for p in proposed if p["payload"]["term"]["kind"] == "join"]
    metrics = [p for p in proposed if p["payload"]["term"]["kind"] == "metric"]
    assert len(joins) == 2
    assert len(metrics) == 3

    approvals = [line for line in lines if line["type"] == "approval_required"]
    term_approvals = [a for a in approvals if a["payload"]["subject_kind"] == "ontology_term"]
    action_approvals = [a for a in approvals if a["payload"]["subject_kind"] == "action"]
    assert len(term_approvals) == 2
    assert len(action_approvals) == 1
    # both flagged terms have confidence < 0.9 per the drafter's threshold rule
    flagged_ids = {a["payload"]["subject_id"] for a in term_approvals}
    for p in proposed:
        if p["payload"]["term"]["id"] in flagged_ids:
            assert p["payload"]["term"]["confidence"] < 0.9

    insights = [line for line in lines if line["type"] == "insight"]
    assert len(insights) == 1
    assert insights[0]["payload"]["severity"] == "critical"

    assert "sql_generated" in types
    assert "sql_result" in types
    assert "action_proposed" in types
