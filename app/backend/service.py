"""Application services: criteria state, analysis jobs, and paper/evidence queries."""
from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .ai.base import LLMProvider, ProviderError, get_provider
from .analysis import ANALYSIS_VERSION, analyze_document
from .config import Settings
from .criteria import parse_criteria
from .db import Database, dumps, loads, now_iso
from .papers import pdf_file_path
from .pdftext import get_document, get_index, norm

log = logging.getLogger(__name__)


class CriteriaStore:
    """Parsed criteria, reloaded automatically when the source file changes on disk."""

    def __init__(self, path: Path):
        self.path = path
        self._mtime: float | None = None
        self._data: dict[str, Any] | None = None
        self._error: str | None = None
        self._lock = threading.Lock()

    def get(self) -> dict[str, Any] | None:
        with self._lock:
            try:
                mtime = self.path.stat().st_mtime
            except FileNotFoundError:
                self._data, self._error = None, f"Criteria file not found: {self.path}"
                return None
            if mtime != self._mtime:
                try:
                    self._data = parse_criteria(self.path)
                    self._error = None if self._data["ok"] else "No inclusion and exclusion criteria could be parsed from the criteria file."
                except Exception as e:
                    log.exception("Failed to parse criteria")
                    self._data, self._error = None, f"Failed to parse criteria file: {e}"
                self._mtime = mtime
            return self._data if (self._data and self._data["ok"]) else None

    @property
    def error(self) -> str | None:
        self.get()
        return self._error


class Services:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.criteria = CriteriaStore(settings.criteria_file)
        self.provider: LLMProvider | None
        self.provider, self.provider_status = get_provider(settings)
        self.provider_check: dict[str, Any] | None = None  # result of the last live connectivity test
        self.jobs: dict[str, dict[str, Any]] = {}
        self._jobs_lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=settings.ai_concurrency, thread_name_prefix="analysis")
        self._extract_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="extract")

    # ------------------------------------------------------------ provider check

    def check_provider(self) -> dict[str, Any]:
        """Send a tiny structured request to the provider and cache the outcome."""
        from pydantic import BaseModel

        class Ping(BaseModel):
            ok: bool

        if not self.provider:
            result = {"ok": False, "message": self.provider_status}
        else:
            try:
                self.provider.generate_json(system="Reply with JSON.", prompt='Return {"ok": true}.', schema=Ping, max_output_tokens=256)
                result = {"ok": True, "message": f"Connected to {self.provider.describe()}"}
            except ProviderError as e:
                result = {"ok": False, "message": str(e)}
            except Exception as e:
                result = {"ok": False, "message": f"{type(e).__name__}: {e}"}
        result["at"] = now_iso()
        self.provider_check = result
        log.info("AI provider check: %s", result["message"][:200])
        return result

    def check_provider_async(self) -> None:
        if self.provider:
            threading.Thread(target=self.check_provider, daemon=True, name="provider-check").start()

    # ------------------------------------------------------------ helpers

    def paper(self, paper_id: str) -> dict[str, Any] | None:
        return self.db.one("SELECT * FROM papers WHERE paper_id=?", (paper_id,))

    def criteria_hash(self) -> str | None:
        c = self.criteria.get()
        return c["content_hash"] if c else None

    def prefetch_text(self) -> None:
        """Extract text for all local PDFs in the background (cached by content hash)."""
        def run():
            for p in self.db.all("SELECT * FROM papers WHERE in_source=1 AND pdf_exists=1 ORDER BY source_order"):
                path = pdf_file_path(p)
                if path:
                    try:
                        get_document(self.db, p["pdf_sha256"], path)
                    except Exception:
                        log.exception("Prefetch failed for %s", p["paper_id"])
        self._extract_pool.submit(run)

    def text_status(self, sha: str | None) -> dict[str, Any] | None:
        if not sha:
            return None
        return self.db.one("SELECT status, message, page_count, char_count FROM pdf_text WHERE sha256=?", (sha,))

    # ------------------------------------------------------------ jobs

    def job_snapshot(self) -> dict[str, dict[str, Any]]:
        with self._jobs_lock:
            return {k: dict(v) for k, v in self.jobs.items()}

    def submit_analysis(self, paper_id: str, force: bool = False) -> tuple[bool, str]:
        if not self.provider:
            return False, self.provider_status
        if not self.criteria.get():
            return False, self.criteria.error or "Criteria unavailable"
        p = self.paper(paper_id)
        if not p:
            return False, "Unknown paper"
        if not p["pdf_exists"]:
            return False, "No local PDF for this paper"
        with self._jobs_lock:
            if paper_id in self.jobs:
                return False, "Analysis already queued or running"
            if not force:
                cur = self.current_analysis(paper_id)
                if cur and not self._outdated_reason(cur, p):
                    return False, "Analysis is up to date (use re-analyse to force)"
            self.jobs[paper_id] = {"state": "queued", "stage": "Queued", "queued_at": now_iso()}
        self._pool.submit(self._run, paper_id)
        return True, "Queued"

    def _set_job(self, paper_id: str, **kw) -> None:
        with self._jobs_lock:
            if paper_id in self.jobs:
                self.jobs[paper_id].update(kw)

    def _run(self, paper_id: str) -> None:
        self._set_job(paper_id, state="running", stage="Extracting text", started_at=now_iso())
        aid = None
        try:
            p = self.paper(paper_id)
            criteria = self.criteria.get()
            if not criteria:
                raise ProviderError(self.criteria.error or "Criteria unavailable")
            path = pdf_file_path(p)
            doc = get_document(self.db, p["pdf_sha256"], path)
            if doc["status"] in ("no_text", "error"):
                raise ProviderError(doc["message"] or "No extractable text")
            idx = get_index(self.db, p["pdf_sha256"], path)
            cur = self.db.execute(
                "INSERT INTO analyses(paper_id, pdf_sha256, status, provider, model, criteria_hash, created_at, is_current) "
                "VALUES(?,?,?,?,?,?,?,0)",
                (paper_id, p["pdf_sha256"], "running", self.provider.name, self.provider.model, criteria["content_hash"], now_iso()),
            )
            aid = cur.lastrowid
            out = analyze_document(
                self.provider, criteria, p, doc["pages"], idx,
                self.settings.max_single_pass_chars, self.settings.chunk_chars,
                progress=lambda s: self._set_job(paper_id, stage=s),
            )
            self._persist(paper_id, aid, out)
            log.info("Analysis complete for %s: %s (%d verified / %d rejected quotes)", paper_id,
                     out["recommendation"]["decision"], out["stats"]["quotes_verified"], out["stats"]["quotes_rejected"])
        except Exception as e:
            msg = str(e) if isinstance(e, ProviderError) else f"{type(e).__name__}: {e}"
            if not isinstance(e, ProviderError):
                log.exception("Analysis failed for %s", paper_id)
            else:
                log.warning("Analysis failed for %s: %s", paper_id, msg)
            if aid is None:
                p = self.paper(paper_id) or {}
                self.db.execute(
                    "INSERT INTO analyses(paper_id, pdf_sha256, status, provider, model, criteria_hash, created_at, completed_at, error, is_current) "
                    "VALUES(?,?,?,?,?,?,?,?,?,0)",
                    (paper_id, p.get("pdf_sha256"), "failed", getattr(self.provider, "name", None),
                     getattr(self.provider, "model", None), self.criteria_hash(), now_iso(), now_iso(), msg),
                )
            else:
                self.db.execute("UPDATE analyses SET status='failed', error=?, completed_at=? WHERE id=?", (msg, now_iso(), aid))
        finally:
            with self._jobs_lock:
                self.jobs.pop(paper_id, None)

    def _persist(self, paper_id: str, aid: int, out: dict[str, Any]) -> None:
        ts = now_iso()
        with self.db.tx() as conn:
            # Reviewer dismissals survive re-analysis when the same passage is proposed again.
            dismissed = {
                (r["criterion_id"], norm(r["quote"]))
                for r in conn.execute("SELECT criterion_id, quote FROM evidence WHERE paper_id=? AND origin='ai' AND dismissed=1", (paper_id,))
            }
            conn.execute("DELETE FROM evidence WHERE paper_id=? AND origin='ai'", (paper_id,))
            for e in out["evidence"]:
                conn.execute(
                    "INSERT INTO evidence(id, paper_id, analysis_id, origin, criterion_id, stance, polarity, quote, model_quote, page, "
                    "rects_json, explanation, match_method, match_score, dismissed, created_at, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (uuid.uuid4().hex, paper_id, aid, "ai", e["criterion_id"], e["stance"], e["polarity"], e["quote"],
                     e["model_quote"], e["page"], dumps(e["rects"]), e["explanation"], e["match_method"], e["match_score"],
                     int((e["criterion_id"], norm(e["quote"])) in dismissed), ts, ts),
                )
            conn.execute("UPDATE analyses SET is_current=0 WHERE paper_id=?", (paper_id,))
            conn.execute(
                "UPDATE analyses SET status='complete', completed_at=?, result_json=?, recommendation_json=?, rejected_json=?, "
                "stats_json=?, is_current=1 WHERE id=?",
                (ts, dumps(out["result"]), dumps(out["recommendation"]), dumps(out["rejected"]), dumps(out["stats"]), aid),
            )

    # ------------------------------------------------------------ queries

    def current_analysis(self, paper_id: str) -> dict[str, Any] | None:
        return self.db.one("SELECT * FROM analyses WHERE paper_id=? AND is_current=1 AND status='complete' ORDER BY id DESC LIMIT 1", (paper_id,))

    def last_attempt(self, paper_id: str) -> dict[str, Any] | None:
        return self.db.one("SELECT * FROM analyses WHERE paper_id=? ORDER BY id DESC LIMIT 1", (paper_id,))

    def _outdated_reason(self, a: dict[str, Any], p: dict[str, Any]) -> str | None:
        reasons = []
        if self.provider and (a.get("provider") != self.provider.name or a.get("model") != self.provider.model):
            reasons.append("the AI provider or model has changed")
        ch = self.criteria_hash()
        if ch and a["criteria_hash"] != ch:
            reasons.append("the eligibility criteria have changed")
        if a["pdf_sha256"] and p.get("pdf_sha256") and a["pdf_sha256"] != p["pdf_sha256"]:
            reasons.append("the PDF file has changed")
        stats = loads(a.get("stats_json"), {}) or {}
        if stats.get("analysis_version") and stats["analysis_version"] != ANALYSIS_VERSION:
            reasons.append("the analysis method has been updated")
        return ("Potentially outdated: " + " and ".join(reasons) + ".") if reasons else None

    def analysis_state(self, p: dict[str, Any], jobs: dict[str, Any], cur: dict[str, Any] | None, last: dict[str, Any] | None) -> str:
        if not p["pdf_exists"]:
            return "no_pdf"
        if p["paper_id"] in jobs:
            return jobs[p["paper_id"]]["state"]
        if cur:
            return "outdated" if self._outdated_reason(cur, p) else "complete"
        if last and last["status"] == "failed":
            return "failed"
        ts = self.text_status(p["pdf_sha256"])
        if ts and ts["status"] in ("no_text", "error"):
            return "no_text"
        return "pending"

    def list_papers(self) -> list[dict[str, Any]]:
        jobs = self.job_snapshot()
        papers = self.db.all("SELECT * FROM papers WHERE in_source=1 ORDER BY source_order")
        decisions = {r["paper_id"]: r for r in self.db.all("SELECT * FROM decisions")}
        current = {r["paper_id"]: r for r in self.db.all("SELECT * FROM analyses WHERE is_current=1 AND status='complete'")}
        last = {r["paper_id"]: r for r in self.db.all(
            "SELECT a.* FROM analyses a JOIN (SELECT paper_id, MAX(id) mid FROM analyses GROUP BY paper_id) m ON a.id=m.mid")}
        counts: dict[str, dict[str, int]] = {}
        for r in self.db.all("SELECT paper_id, polarity, COUNT(*) n FROM evidence WHERE dismissed=0 GROUP BY paper_id, polarity"):
            counts.setdefault(r["paper_id"], {})[r["polarity"]] = r["n"]
        notes = {r["paper_id"] for r in self.db.all("SELECT paper_id FROM notes WHERE TRIM(COALESCE(body,''))<>''")}
        out = []
        for p in papers:
            d = decisions.get(p["paper_id"])
            a = current.get(p["paper_id"])
            rec = loads(a["recommendation_json"], {}) if a else {}
            out.append({
                "paper_id": p["paper_id"],
                "order": p["source_order"],
                "title": p["title"],
                "authors": p["authors"],
                "year": p["year"],
                "doi": p["doi"],
                "pdf_available": bool(p["pdf_exists"]),
                "access_status": p["access_status"],
                "duplicate_of": p["duplicate_of"],
                "decision": d["decision"] if d else None,
                "decision_code": d["code"] if d else None,
                "decided_at": d["decided_at"] if d else None,
                "ai_decision": rec.get("decision"),
                "ai_code": rec.get("code"),
                "analysis_state": self.analysis_state(p, jobs, a, last.get(p["paper_id"])),
                "evidence_counts": counts.get(p["paper_id"], {}),
                "has_notes": p["paper_id"] in notes,
            })
        return out

    def evidence_for(self, paper_id: str) -> list[dict[str, Any]]:
        rows = self.db.all("SELECT * FROM evidence WHERE paper_id=? ORDER BY page, created_at", (paper_id,))
        for r in rows:
            r["rects"] = loads(r.pop("rects_json"), [])
            r["dismissed"] = bool(r["dismissed"])
        return rows

    def paper_detail(self, paper_id: str) -> dict[str, Any] | None:
        p = self.paper(paper_id)
        if not p:
            return None
        jobs = self.job_snapshot()
        cur = self.current_analysis(paper_id)
        last = self.last_attempt(paper_id)
        analysis = None
        if cur:
            analysis = {
                "id": cur["id"],
                "provider": cur["provider"],
                "model": cur["model"],
                "created_at": cur["created_at"],
                "completed_at": cur["completed_at"],
                "result": loads(cur["result_json"], {}),
                "recommendation": loads(cur["recommendation_json"], {}),
                "rejected": loads(cur["rejected_json"], []),
                "stats": loads(cur["stats_json"], {}),
                "outdated_reason": self._outdated_reason(cur, p),
            }
        failed = None
        if last and last["status"] == "failed" and (not cur or last["id"] > cur["id"]):
            failed = {"error": last["error"], "at": last["completed_at"] or last["created_at"]}
        decision = self.db.one("SELECT * FROM decisions WHERE paper_id=?", (paper_id,))
        note = self.db.one("SELECT body, updated_at FROM notes WHERE paper_id=?", (paper_id,))
        history = self.db.all("SELECT decision, code, reason, decided_at, ai_decision FROM decision_log WHERE paper_id=? ORDER BY id DESC LIMIT 20", (paper_id,))
        csv_info = loads(p["csv_json"], {}) or {}
        return {
            "paper": {
                "paper_id": p["paper_id"],
                "order": p["source_order"],
                "title": p["title"],
                "authors": p["authors"],
                "year": p["year"],
                "doi": p["doi"],
                "link": p["link"],
                "pmid": p["pmid"],
                "pmcid": p["pmcid"],
                "pdf_url": p["pdf_url"],
                "landing_page_url": p["landing_page_url"],
                "source": p["source"],
                "access_status": p["access_status"],
                "license": p["license"],
                "duplicate_of": p["duplicate_of"],
                "manifest_notes": p["manifest_notes"],
                "pdf_available": bool(p["pdf_exists"]),
                "pdf_relpath": csv_info.get("rel_pdf"),
                "pdf_checksum_ok": None if p["pdf_checksum_ok"] is None else bool(p["pdf_checksum_ok"]),
                "match_confidence": p["match_confidence"],
            },
            "text": self.text_status(p["pdf_sha256"]),
            "analysis": analysis,
            "analysis_failed": failed,
            "analysis_state": self.analysis_state(p, jobs, cur, last),
            "job": jobs.get(paper_id),
            "evidence": self.evidence_for(paper_id),
            "decision": decision,
            "decision_history": history,
            "notes": note,
        }
