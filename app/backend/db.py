"""SQLite persistence for reviewer data, analyses, evidence and extracted PDF text."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS papers (
    paper_id TEXT PRIMARY KEY,
    source_order INTEGER,
    in_source INTEGER NOT NULL DEFAULT 1,
    title TEXT, authors TEXT, year TEXT, doi TEXT, link TEXT, pmid TEXT, pmcid TEXT,
    pdf_path TEXT, pdf_url TEXT, landing_page_url TEXT, source TEXT, access_status TEXT,
    license TEXT, checksum_sha256 TEXT, match_confidence REAL, duplicate_of TEXT, manifest_notes TEXT,
    pdf_exists INTEGER NOT NULL DEFAULT 0, pdf_stat TEXT, pdf_sha256 TEXT, pdf_checksum_ok INTEGER,
    csv_json TEXT, manifest_json TEXT, synced_at TEXT
);

CREATE TABLE IF NOT EXISTS pdf_text (
    sha256 TEXT PRIMARY KEY,
    extractor_version TEXT,
    page_count INTEGER,
    status TEXT,          -- ok | partial | no_text | error
    message TEXT,
    char_count INTEGER,
    pages_json TEXT,
    extracted_at TEXT
);

CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT NOT NULL,
    pdf_sha256 TEXT,
    status TEXT NOT NULL,  -- running | complete | failed
    provider TEXT, model TEXT, criteria_hash TEXT,
    created_at TEXT, completed_at TEXT, error TEXT,
    result_json TEXT, recommendation_json TEXT, rejected_json TEXT, stats_json TEXT,
    is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_analyses_paper ON analyses(paper_id, is_current);

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    analysis_id INTEGER,
    origin TEXT NOT NULL,        -- ai | manual
    criterion_id TEXT NOT NULL,
    stance TEXT NOT NULL,        -- supports | contradicts | ambiguous
    polarity TEXT NOT NULL,      -- include (green) | exclude (red) | uncertain (amber)
    quote TEXT NOT NULL,         -- exact text taken from the PDF
    model_quote TEXT,            -- the quotation as returned by the model (for audit)
    page INTEGER NOT NULL,
    rects_json TEXT NOT NULL,    -- [[page, x0, y0, x1, y1], ...] in PDF user space
    explanation TEXT,
    match_method TEXT, match_score REAL,
    dismissed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_paper ON evidence(paper_id);

CREATE TABLE IF NOT EXISTS decisions (
    paper_id TEXT PRIMARY KEY,
    decision TEXT NOT NULL,      -- include | exclude | maybe
    code TEXT, reason TEXT, decided_at TEXT,
    ai_decision TEXT, ai_code TEXT, analysis_id INTEGER
);

CREATE TABLE IF NOT EXISTS decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT NOT NULL, decision TEXT, code TEXT, reason TEXT, decided_at TEXT,
    ai_decision TEXT, ai_code TEXT
);

CREATE TABLE IF NOT EXISTS notes (
    paper_id TEXT PRIMARY KEY, body TEXT, updated_at TEXT
);

-- ------------------------------------------------------------ data extraction (schema v2)
-- Extraction state is independent of screening decisions: data survives eligibility changes.

CREATE TABLE IF NOT EXISTS extraction_templates (
    version INTEGER PRIMARY KEY,     -- immutable versions; the highest is active
    name TEXT,
    template_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_filename TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS extraction_papers (
    paper_id TEXT PRIMARY KEY,
    notes TEXT,
    completed_at TEXT,               -- set when the reviewer marks extraction complete
    completed_template_version INTEGER,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS extraction_records (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    label TEXT,
    ai_key TEXT,                     -- record key used by the model in the run that created it
    sort_order INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL,            -- ai | manual
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exrec_paper ON extraction_records(paper_id, group_id);

CREATE TABLE IF NOT EXISTS extraction_values (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    field_id TEXT NOT NULL,
    status TEXT,                     -- reported | not_reported | unclear | not_applicable
    value_json TEXT,
    unit TEXT,
    context TEXT,
    note TEXT,
    origin TEXT NOT NULL,            -- ai | manual
    review_state TEXT NOT NULL,      -- pending | accepted | edited | rejected
    issues_json TEXT,
    ai_json TEXT,                    -- the AI suggestion as originally proposed (audit)
    conflict_json TEXT,              -- a newer AI suggestion that differs from a reviewed value
    run_id INTEGER,
    reviewed_at TEXT, created_at TEXT, updated_at TEXT,
    UNIQUE(record_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_exval_paper ON extraction_values(paper_id);

CREATE TABLE IF NOT EXISTS extraction_evidence (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    value_id TEXT NOT NULL,
    origin TEXT NOT NULL,            -- ai | manual
    quote TEXT NOT NULL,             -- exact PDF text when verified, otherwise the model's claim
    model_quote TEXT,
    page INTEGER,
    rects_json TEXT NOT NULL,        -- [] when the quotation could not be verified
    verified INTEGER NOT NULL DEFAULT 0,
    match_method TEXT, match_score REAL,
    value_check TEXT,                -- ok | mismatch | n/a: does the extracted value occur in the passage?
    pdf_sha256 TEXT,
    removed INTEGER NOT NULL DEFAULT 0,
    run_id INTEGER,
    created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exev_value ON extraction_evidence(value_id);
CREATE INDEX IF NOT EXISTS idx_exev_paper ON extraction_evidence(paper_id);

CREATE TABLE IF NOT EXISTS extraction_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT NOT NULL,
    template_version INTEGER,
    pdf_sha256 TEXT,
    status TEXT NOT NULL,            -- running | complete | failed
    provider TEXT, model TEXT,
    created_at TEXT, completed_at TEXT, error TEXT,
    stats_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_exrun_paper ON extraction_runs(paper_id);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)  # additive: new tables are created on existing databases
        self.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
        current = int(self.get_meta("schema_version") or 1)
        if current < SCHEMA_VERSION:
            # v1 -> v2 adds only the extraction tables above; existing screening data is untouched.
            self.set_meta("schema_version", str(SCHEMA_VERSION))

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def execute(self, sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def one(self, sql: str, params: tuple | dict = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, params: tuple | dict = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def get_meta(self, key: str) -> str | None:
        row = self.one("SELECT value FROM meta WHERE key=?", (key,))
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def loads(s: str | None, default: Any = None) -> Any:
    if not s:
        return default
    return json.loads(s)
