import asyncio

import duckdb
import httpx
import pytest

from backend.app import ingest
from backend.app import main
from backend.app import ontology as onto_mod

_ORIGINAL_ONTOLOGY_YAML = onto_mod.ONTOLOGY_PATH.read_text()

SMALL_CSV = b"id,name,amount\n1,alice,10.5\n2,bob,20\n3,carol,30\n"
BAD_CSV = b"\x00\x01\x02\x03\xff\xfe not,really,,,csv\x00\x00"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Redirect ingest's duckdb/uploads dir and ontology.yaml to tmp_path so
    tests never touch backend/data/foundry.duckdb or ontology.yaml. Both
    ingest.py and main.py's route resolve these module attributes fresh at
    call time (not baked into a default arg), so monkeypatching here is
    enough to isolate the whole HTTP route."""
    db_path = tmp_path / "foundry.duckdb"
    uploads_dir = tmp_path / "uploads"
    onto_path = tmp_path / "ontology.yaml"
    onto_path.write_text(_ORIGINAL_ONTOLOGY_YAML)

    monkeypatch.setattr(ingest, "DB_PATH", db_path)
    monkeypatch.setattr(ingest, "UPLOADS_DIR", uploads_dir)
    monkeypatch.setattr(onto_mod, "ONTOLOGY_PATH", onto_path)

    yield db_path, uploads_dir, onto_path


def _client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


def test_happy_path_upload_ingests_table_updates_yaml_emits_status(_isolate):
    db_path, _uploads_dir, onto_path = _isolate

    async def run():
        async with _client() as c:
            q = main.bus.subscribe()
            files = {"file": ("widgets.csv", SMALL_CSV, "text/csv")}
            r = await c.post("/api/data/upload", files=files)
            env = await asyncio.wait_for(q.get(), timeout=1)
            main.bus.unsubscribe(q)
            return r, env

    r, env = asyncio.run(run())

    assert r.status_code == 200
    body = r.json()
    assert body["table"] == "widgets"
    assert body["rows"] == 3
    assert {c["name"] for c in body["columns"]} == {"id", "name", "amount"}

    assert env.type == "status"
    assert env.run_id == ""
    assert env.payload == {"message": "ingested table widgets: 3 rows, 3 columns"}

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        assert con.execute("SELECT count(*) FROM widgets").fetchone()[0] == 3
    finally:
        con.close()

    onto = onto_mod.load_ontology(onto_path)
    assert any(s["table"] == "widgets" for s in onto["sources"])
    # baseline 3 sources untouched, new one appended
    assert len(onto["sources"]) == 4


def test_name_sanitized_from_filename(_isolate):
    async def run():
        async with _client() as c:
            files = {"file": ("My Data-2026.csv", SMALL_CSV, "text/csv")}
            return await c.post("/api/data/upload", files=files)

    r = asyncio.run(run())
    assert r.status_code == 200
    assert r.json()["table"] == "my_data_2026"


def test_table_form_field_overrides_filename(_isolate):
    async def run():
        async with _client() as c:
            files = {"file": ("ignored.csv", SMALL_CSV, "text/csv")}
            return await c.post("/api/data/upload", files=files, data={"table": "custom_name"})

    r = asyncio.run(run())
    assert r.status_code == 200
    assert r.json()["table"] == "custom_name"


def test_reserved_table_name_rejected(_isolate):
    async def run():
        async with _client() as c:
            files = {"file": ("data.csv", SMALL_CSV, "text/csv")}
            return await c.post("/api/data/upload", files=files, data={"table": "main"})

    r = asyncio.run(run())
    assert r.status_code == 400


def test_replace_on_reupload(_isolate):
    _db_path, _uploads_dir, onto_path = _isolate
    csv2 = b"id,name,amount\n1,x,1\n"

    async def run():
        async with _client() as c:
            r1 = await c.post("/api/data/upload", files={"file": ("t.csv", SMALL_CSV, "text/csv")})
            r2 = await c.post("/api/data/upload", files={"file": ("t.csv", csv2, "text/csv")})
            return r1, r2

    r1, r2 = asyncio.run(run())
    assert r1.status_code == 200 and r1.json()["rows"] == 3
    assert r2.status_code == 200 and r2.json()["rows"] == 1

    onto = onto_mod.load_ontology(onto_path)
    assert sum(1 for s in onto["sources"] if s["table"] == "t") == 1


def test_bad_csv_returns_400_and_yaml_unchanged(_isolate):
    _db_path, _uploads_dir, onto_path = _isolate
    before = onto_path.read_text()

    async def run():
        async with _client() as c:
            files = {"file": ("bad.csv", BAD_CSV, "text/csv")}
            return await c.post("/api/data/upload", files=files)

    r = asyncio.run(run())
    assert r.status_code == 400
    assert "detail" in r.json()
    assert onto_path.read_text() == before


def test_oversize_returns_413(_isolate, monkeypatch):
    monkeypatch.setattr(ingest, "MAX_UPLOAD_BYTES", 10)

    async def run():
        async with _client() as c:
            files = {"file": ("t.csv", SMALL_CSV, "text/csv")}
            return await c.post("/api/data/upload", files=files)

    r = asyncio.run(run())
    assert r.status_code == 413
