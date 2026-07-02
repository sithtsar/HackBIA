"""CSV upload -> duckdb ingest (Task 7).

POST /api/data/upload (main.py) lets a user bring their own CSV: sanitize a
table name, save the raw file under data/uploads/, load it into
foundry.duckdb with a short-lived read-write connection (ask flows only ever
open read-only, per docs/contracts.md concurrency note), and register the
table in ontology.yaml `sources:` so the next ontology draft picks it up.

Module-level DB_PATH/UPLOADS_DIR are read fresh inside ingest_csv (not baked
into a default-arg) so tests can monkeypatch them for tmp-dir isolation, same
trick ontology.py's `path: Path = ONTOLOGY_PATH` doesn't need because callers
there always pass tmp_path explicitly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import duckdb

from . import ontology as onto_mod

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "foundry.duckdb"
UPLOADS_DIR = DATA_DIR / "uploads"

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB; tests shrink this to hit 413 without a real 20MB fixture
RESERVED_NAMES = {"main"}  # duckdb's default schema name, not a valid table
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


class IngestError(Exception):
    """Carries the HTTP status the route should respond with."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


def sanitize_name(raw: str) -> str:
    """Lowercase, coerce dashes/spaces to '_', strip anything else.
    Raises IngestError(400) if empty, malformed, or reserved."""
    stem = Path(raw or "").stem.lower()
    stem = re.sub(r"[-\s]+", "_", stem)
    stem = re.sub(r"[^a-z0-9_]", "", stem)
    if not stem or not _NAME_RE.match(stem):
        raise IngestError(400, f"invalid table name derived from {raw!r}")
    if stem in RESERVED_NAMES:
        raise IngestError(400, f"table name {stem!r} is reserved")
    return stem


@dataclass
class IngestResult:
    table: str
    rows: int
    columns: list[dict[str, str]]


def ingest_csv(content: bytes, filename: str, table: str | None) -> IngestResult:
    """Validate, save, load into duckdb, register in ontology.yaml.
    Raises IngestError for any 4xx condition; leaves no partial state on
    failure (no raw file kept, no yaml edit) other than a table left behind
    by a duckdb CREATE OR REPLACE that partially ran (duckdb is transactional
    per-statement, so that doesn't happen in practice)."""
    if len(content) > MAX_UPLOAD_BYTES:
        raise IngestError(413, f"file exceeds {MAX_UPLOAD_BYTES} byte cap")

    name = sanitize_name(table or filename)

    uploads_dir = UPLOADS_DIR
    uploads_dir.mkdir(parents=True, exist_ok=True)
    csv_path = uploads_dir / f"{name}.csv"
    csv_path.write_bytes(content)

    try:
        con = duckdb.connect(str(DB_PATH))
        try:
            con.execute(f'CREATE OR REPLACE TABLE "{name}" AS SELECT * FROM read_csv_auto(\'{csv_path}\')')
            rows = con.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            columns = [{"name": r[0], "type": r[1]} for r in con.execute(f'DESCRIBE "{name}"').fetchall()]
        finally:
            con.close()
    except duckdb.Error as exc:
        csv_path.unlink(missing_ok=True)
        raise IngestError(400, str(exc)) from exc

    onto_path = onto_mod.ONTOLOGY_PATH
    onto = onto_mod.load_ontology(onto_path)
    if not any(s.get("table") == name for s in onto.get("sources", [])):
        onto.setdefault("sources", []).append({"table": name})
        onto_mod.save_ontology(onto, onto_path)

    return IngestResult(table=name, rows=rows, columns=columns)
