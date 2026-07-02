import asyncio
import json

from backend.app.events import DATA_DIR, DEMO_EVENTS_FILE, Envelope, EventBus, replay


def test_envelope_round_trip():
    bus = EventBus(jsonl_path=DATA_DIR / "_test_events.jsonl")
    env = bus.publish("status", {"message": "hi"}, run_id="run_x")
    assert env.id == "evt_000001"
    dumped = env.model_dump_json()
    back = Envelope.model_validate_json(dumped)
    assert back == env
    (DATA_DIR / "_test_events.jsonl").unlink(missing_ok=True)


def test_ids_are_monotonic():
    bus = EventBus(jsonl_path=DATA_DIR / "_test_events2.jsonl")
    ids = [bus.publish("status", {"message": str(i)}).id for i in range(5)]
    assert ids == [f"evt_{i:06d}" for i in range(1, 6)]
    (DATA_DIR / "_test_events2.jsonl").unlink(missing_ok=True)


def test_replay_reemits_every_event_onto_bus():
    async def run():
        bus = EventBus(jsonl_path=DATA_DIR / "_test_events3.jsonl")
        q = bus.subscribe()
        n = await replay(bus, file=DEMO_EVENTS_FILE, speed=1000)  # fast for tests
        received = [q.get_nowait() for _ in range(q.qsize())]
        return n, received

    n, received = asyncio.run(run())
    with open(DEMO_EVENTS_FILE) as f:
        expected_count = sum(1 for line in f if line.strip())
    assert n == expected_count
    assert len(received) == expected_count
    # replay assigns fresh sequential ids/ts, but preserves type/run_id/payload
    with open(DEMO_EVENTS_FILE) as f:
        originals = [json.loads(line) for line in f if line.strip()]
    for env, orig in zip(received, originals):
        assert env.type == orig["type"]
        assert env.run_id == orig["run_id"]
        assert env.payload == orig["payload"]
    (DATA_DIR / "_test_events3.jsonl").unlink(missing_ok=True)


def test_publish_appends_jsonl():
    path = DATA_DIR / "_test_events4.jsonl"
    path.unlink(missing_ok=True)
    bus = EventBus(jsonl_path=path)
    bus.publish("status", {"message": "a"})
    bus.publish("status", {"message": "b"})
    lines = path.read_text().strip().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["payload"]["message"] == "a"
    path.unlink(missing_ok=True)
