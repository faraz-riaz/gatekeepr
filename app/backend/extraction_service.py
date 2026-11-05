"""Data-extraction services: templates, AI runs, human review, evidence and paper states.

Researcher-control rules implemented here:
  * Only papers whose *current* human screening decision is Include are eligible. Eligibility is
    derived live, so revising a decision never deletes extraction data — it only changes
    availability (data of no-longer-included papers is kept and flagged).
  * AI output is stored as *pending* suggestions. Re-running the AI replaces only pending
    suggestions; accepted/edited values are never overwritten — a differing new suggestion is
    attached as a *conflict* for the reviewer to adopt or dismiss. A rejected suggestion stays
    rejected unless the AI proposes something different.
  * Evidence is verified against the PDF text; unverified quotes are kept but never highlighted.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from .ai.base import ProviderError
from .db import Database, dumps, loads, now_iso
from .extraction import EXTRACTION_VERSION, coerce_value, extract_document, value_in_passage
from .extraction_templates import diff_templates, field_map, group_map, template_hash, validate_template
from .papers import pdf_file_path
from .pdftext import get_document, get_index, norm

log = logging.getLogger(__name__)

REVIEWED = ("accepted", "edited")
OPEN_STATUSES = ("reported", "unclear")


def _same(a: dict[str, Any] | None, b: dict[str, Any] | None) -> bool:
    if not a or not b:
        return False
    key = lambda x: json.dumps([x.get("status"), x.get("value"), (x.get("unit") or "").strip().lower()], sort_keys=True, default=str)  # noqa: E731
    return key(a) == key(b)


class ExtractionService:
    def __init__(self, svc):
        self.svc = svc  # screening Services: shares the database, AI provider, worker pool and text cache
        self.jobs: dict[str, dict[str, Any]] = {}

    @property
    def db(self) -> Database:
        return self.svc.db

    # ------------------------------------------------------------ templates

    def active_template(self) -> dict[str, Any] | None:
        row = self.db.one("SELECT * FROM extraction_templates ORDER BY version DESC LIMIT 1")
        if not row:
            return None
        return {"version": row["version"], "name": row["name"], "template": loads(row["template_json"]),
                "hash": row["content_hash"], "created_at": row["created_at"], "source_filename": row["source_filename"]}

    def template_versions(self) -> list[dict[str, Any]]:
        return self.db.all("SELECT version, name, content_hash, source_filename, created_at FROM extraction_templates ORDER BY version DESC")

    def template_impact(self, new: dict[str, Any]) -> dict[str, Any]:
        """Diff against the active template and count existing data affected by the change."""
        new = validate_template(new)
        cur = self.active_template()
        diff = diff_templates(cur["template"] if cur else None, new)
        removed = [tuple(x.split(".", 1)) for x in diff["removed_fields"]]
        removed_groups = set(diff["removed_groups"])
        changed = [(c["group"], c["field"]) for c in diff["changed_fields"]]
        live = "status IS NOT NULL AND review_state != 'rejected'"

        def count(pairs) -> tuple[int, int]:
            if not pairs:
                return 0, 0
            cond = " OR ".join("(group_id=? AND field_id=?)" for _ in pairs)
            row = self.db.one(f"SELECT COUNT(*) n, COUNT(DISTINCT paper_id) p FROM extraction_values WHERE ({cond}) AND {live}",
                              tuple(x for p in pairs for x in p))
            return row["n"], row["p"]

        rv, rp = count(removed)
        if removed_groups:
            q = ",".join("?" * len(removed_groups))
            row = self.db.one(f"SELECT COUNT(*) n, COUNT(DISTINCT paper_id) p FROM extraction_values WHERE group_id IN ({q}) AND {live}",
                              tuple(removed_groups))
            rv, rp = rv + row["n"], max(rp, row["p"])
        cv, cp = count(changed)
        completed = self.db.one("SELECT COUNT(*) n FROM extraction_papers WHERE completed_at IS NOT NULL")["n"]
        structural = any(diff[k] for k in ("added_groups", "removed_groups", "added_fields", "removed_fields", "changed_fields", "repeatable_changed"))
        return {
            "diff": diff,
            "unchanged": bool(cur) and template_hash(new) == cur["hash"],
            "impact": {
                "values_in_removed_fields": rv, "papers_with_removed_values": rp,
                "values_in_changed_fields": cv, "papers_with_changed_values": cp,
                "completed_papers": completed if structural and cur else 0,
            },
        }

    def save_template(self, new: dict[str, Any], source_filename: str | None = None) -> dict[str, Any]:
        new = validate_template(new)
        cur = self.active_template()
        h = template_hash(new)
        if cur and cur["hash"] == h:
            return cur
        version = (cur["version"] + 1) if cur else 1
        self.db.execute(
            "INSERT INTO extraction_templates(version, name, template_json, content_hash, source_filename, created_at) VALUES(?,?,?,?,?,?)",
            (version, new["title"], dumps(new), h, source_filename, now_iso()),
        )
        return self.active_template()

    # ------------------------------------------------------------ eligibility & states

    def eligible_ids(self) -> set[str]:
        return {r["paper_id"] for r in self.db.all("SELECT paper_id FROM decisions WHERE decision='include'")}

    def _value_rows(self, paper_id: str | None = None) -> list[dict[str, Any]]:
        sql = ("SELECT v.*, r.deleted AS record_deleted FROM extraction_values v JOIN extraction_records r ON r.id=v.record_id"
               + (" WHERE v.paper_id=?" if paper_id else ""))
        return self.db.all(sql, (paper_id,) if paper_id else ())

    def _summarise(self, paper_id: str, values: list[dict], records: list[dict], ev_by_value: dict[str, list[dict]],
                   t: dict[str, Any] | None, active_version: int | None, ep: dict | None, job: dict | None,
                   last_run: dict | None, eligible: bool, pdf_sha: str | None) -> dict[str, Any]:
        fmap = field_map(t) if t else {}
        groups = group_map(t) if t else {}
        live_records = [r for r in records if not r["deleted"] and r["group_id"] in groups]
        live = [v for v in values if not v["record_deleted"] and (v["group_id"], v["field_id"]) in fmap]
        expected = 0
        for gid, g in groups.items():
            n = sum(1 for r in live_records if r["group_id"] == gid)
            expected += len(g["fields"]) * (n if g["repeatable"] else 1)
        pending = sum(1 for v in live if v["review_state"] == "pending" and v["status"])
        reviewed = sum(1 for v in live if v["review_state"] in REVIEWED or v["review_state"] == "rejected")
        resolved = sum(1 for v in live if v["status"] and v["review_state"] != "rejected")
        unverified = sum(
            1 for v in live if v["status"] in OPEN_STATUSES and v["review_state"] != "rejected"
            and not any(e["verified"] and not e["removed"] for e in ev_by_value.get(v["id"], [])))
        conflicts = sum(1 for v in live if v["conflict_json"])
        # required fields that have no usable value
        have = {(v["record_id"], v["field_id"]) for v in live if v["status"] and v["review_state"] != "rejected"}
        required_missing = 0
        for gid, g in groups.items():
            recs = [r for r in live_records if r["group_id"] == gid]
            if not g["repeatable"] and not recs:
                required_missing += sum(1 for f in g["fields"] if f["required"])
            for r in recs:
                required_missing += sum(1 for f in g["fields"] if f["required"] and (r["id"], f["id"]) not in have)
        flags = []
        if not eligible:
            flags.append("not_eligible")
        if ep and ep.get("completed_at") and t and ep.get("completed_template_version") and ep["completed_template_version"] != active_version:
            flags.append("template_changed")
        if pdf_sha and any(e["pdf_sha256"] and e["pdf_sha256"] != pdf_sha and not e["removed"] for evs in ev_by_value.values() for e in evs):
            flags.append("pdf_changed")
        if last_run and last_run["status"] == "failed":
            flags.append("failed")
        if conflicts:
            flags.append("conflicts")
        if job:
            status = job["state"]
        elif ep and ep.get("completed_at"):
            status = "completed"
        elif not values:
            status = "not_started"
        elif pending and not reviewed:
            status = "awaiting_review"
        elif pending:
            status = "in_progress"
        else:
            status = "ready"
        return {
            "status": status,
            "flags": flags,
            "counts": {"expected": expected, "resolved": resolved, "pending": pending, "reviewed": reviewed,
                       "unverified": unverified, "conflicts": conflicts, "required_missing": required_missing,
                       "records": len(live_records)},
        }

    def list_papers(self) -> dict[str, Any]:
        tpl = self.active_template()
        t = tpl["template"] if tpl else None
        eligible = self.eligible_ids()
        papers = {p["paper_id"]: p for p in self.db.all("SELECT * FROM papers WHERE in_source=1 ORDER BY source_order")}
        decisions = {r["paper_id"]: r for r in self.db.all("SELECT paper_id, decision, code FROM decisions")}
        values = self._value_rows()
        by_paper: dict[str, list[dict]] = {}
        for v in values:
            by_paper.setdefault(v["paper_id"], []).append(v)
        records: dict[str, list[dict]] = {}
        for r in self.db.all("SELECT * FROM extraction_records"):
            records.setdefault(r["paper_id"], []).append(r)
        evs: dict[str, list[dict]] = {}
        for e in self.db.all("SELECT id, value_id, verified, removed, pdf_sha256 FROM extraction_evidence"):
            evs.setdefault(e["value_id"], []).append(e)
        eps = {r["paper_id"]: r for r in self.db.all("SELECT * FROM extraction_papers")}
        last_runs = {r["paper_id"]: r for r in self.db.all(
            "SELECT x.* FROM extraction_runs x JOIN (SELECT paper_id, MAX(id) mid FROM extraction_runs GROUP BY paper_id) m ON x.id=m.mid")}
        ids = [pid for pid in papers if pid in eligible or pid in by_paper or pid in records]
        out = []
        for pid in ids:
            p = papers[pid]
            vals = by_paper.get(pid, [])
            s = self._summarise(pid, vals, records.get(pid, []), {v["id"]: evs.get(v["id"], []) for v in vals}, t,
                                tpl["version"] if tpl else None, eps.get(pid),
                                self.jobs.get(pid), last_runs.get(pid), pid in eligible, p["pdf_sha256"])
            d = decisions.get(pid)
            out.append({
                "paper_id": pid, "order": p["source_order"], "title": p["title"], "authors": p["authors"], "year": p["year"],
                "doi": p["doi"], "pdf_available": bool(p["pdf_exists"]), "eligible": pid in eligible,
                "decision": d["decision"] if d else None, "decision_code": d["code"] if d else None,
                "completed_at": (eps.get(pid) or {}).get("completed_at"),
                "has_notes": bool(((eps.get(pid) or {}).get("notes") or "").strip()),
                **s,
            })
        return {"template_version": tpl["version"] if tpl else None, "papers": out}

    # ------------------------------------------------------------ detail

    def _evidence_rows(self, paper_id: str) -> list[dict[str, Any]]:
        rows = self.db.all("SELECT * FROM extraction_evidence WHERE paper_id=? ORDER BY page, created_at", (paper_id,))
        for r in rows:
            r["rects"] = loads(r.pop("rects_json"), [])
            r["verified"] = bool(r["verified"])
            r["removed"] = bool(r["removed"])
        return rows

    def paper_detail(self, paper_id: str) -> dict[str, Any] | None:
        p = self.svc.paper(paper_id)
        if not p:
            return None
        tpl = self.active_template()
        t = tpl["template"] if tpl else None
        fmap = field_map(t) if t else {}
        records = self.db.all("SELECT * FROM extraction_records WHERE paper_id=? ORDER BY group_id, sort_order, created_at", (paper_id,))
        values = self._value_rows(paper_id)
        evidence = self._evidence_rows(paper_id)
        ev_by_value: dict[str, list[dict]] = {}
        for e in evidence:
            ev_by_value.setdefault(e["value_id"], []).append(e)
        ep = self.db.one("SELECT * FROM extraction_papers WHERE paper_id=?", (paper_id,))
        last_run = self.db.one("SELECT * FROM extraction_runs WHERE paper_id=? ORDER BY id DESC LIMIT 1", (paper_id,))
        last_ok = self.db.one("SELECT * FROM extraction_runs WHERE paper_id=? AND status='complete' ORDER BY id DESC LIMIT 1", (paper_id,))
        eligible = paper_id in self.eligible_ids()
        decision = self.db.one("SELECT decision, code, decided_at FROM decisions WHERE paper_id=?", (paper_id,))
        summary = self._summarise(paper_id, values, records, ev_by_value, t, tpl["version"] if tpl else None, ep,
                                  self.jobs.get(paper_id), last_run, eligible, p["pdf_sha256"])
        out_values = []
        for v in values:
            out_values.append({
                "id": v["id"], "record_id": v["record_id"], "group_id": v["group_id"], "field_id": v["field_id"],
                "status": v["status"], "value": loads(v["value_json"]), "unit": v["unit"] or "", "context": v["context"] or "",
                "note": v["note"] or "", "origin": v["origin"], "review_state": v["review_state"],
                "issues": loads(v["issues_json"], []) or [], "ai": loads(v["ai_json"]), "conflict": loads(v["conflict_json"]),
                "reviewed_at": v["reviewed_at"], "updated_at": v["updated_at"],
                "in_template": (v["group_id"], v["field_id"]) in fmap and not v["record_deleted"],
                "evidence": ev_by_value.get(v["id"], []),
            })

        def run_info(r):
            if not r:
                return None
            info = {k: r[k] for k in ("id", "status", "provider", "model", "created_at", "completed_at", "error", "template_version", "pdf_sha256")}
            info["stats"] = loads(r["stats_json"], {}) or {}
            reasons = []
            if r["status"] == "complete":
                if tpl and r["template_version"] != tpl["version"]:
                    reasons.append("the extraction template has changed")
                if r["pdf_sha256"] and p["pdf_sha256"] and r["pdf_sha256"] != p["pdf_sha256"]:
                    reasons.append("the PDF file has changed")
                if self.svc.provider and (r["provider"] != self.svc.provider.name or r["model"] != self.svc.provider.model):
                    reasons.append("the AI provider or model has changed")
                if info["stats"].get("extraction_version") not in (None, EXTRACTION_VERSION):
                    reasons.append("the extraction method has been updated")
            info["outdated_reason"] = ("Potentially outdated: " + " and ".join(reasons) + ".") if reasons else None
            return info

        return {
            "paper": {"paper_id": p["paper_id"], "title": p["title"], "authors": p["authors"], "year": p["year"], "doi": p["doi"],
                      "source": p["source"], "pdf_available": bool(p["pdf_exists"]), "access_status": p["access_status"],
                      "landing_page_url": p["landing_page_url"], "pdf_url": p["pdf_url"], "link": p["link"],
                      "manifest_notes": p["manifest_notes"], "pmcid": p["pmcid"], "duplicate_of": p["duplicate_of"]},
            "decision": decision,
            "eligible": eligible,
            "template_version": tpl["version"] if tpl else None,
            "text": self.svc.text_status(p["pdf_sha256"]),
            "records": [{k: r[k] for k in ("id", "group_id", "label", "origin", "sort_order", "deleted", "created_at")} for r in records],
            "values": out_values,
            "notes": (ep or {}).get("notes") or "",
            "notes_updated_at": (ep or {}).get("updated_at"),
            "completed_at": (ep or {}).get("completed_at"),
            "completed_template_version": (ep or {}).get("completed_template_version"),
            "last_run": run_info(last_run),
            "last_successful_run": run_info(last_ok),
            "job": self.jobs.get(paper_id),
            **summary,
        }

    # ------------------------------------------------------------ AI runs

    def submit(self, paper_id: str) -> tuple[bool, str]:
        svc = self.svc
        if not svc.provider:
            return False, svc.provider_status
        tpl = self.active_template()
        if not tpl:
            return False, "Define an extraction template first"
        p = svc.paper(paper_id)
        if not p:
            return False, "Unknown paper"
        if paper_id not in self.eligible_ids():
            return False, "Only papers with a final Include decision can be extracted"
        if not p["pdf_exists"]:
            return False, "No local PDF for this paper (manual extraction is still possible)"
        if paper_id in self.jobs:
            return False, "Extraction already queued or running"
        self.jobs[paper_id] = {"state": "queued", "stage": "Queued", "queued_at": now_iso()}
        svc._pool.submit(self._run, paper_id)
        return True, "Queued"

    def _set_job(self, paper_id: str, **kw) -> None:
        if paper_id in self.jobs:
            self.jobs[paper_id].update(kw)

    def _run(self, paper_id: str) -> None:
        svc = self.svc
        self._set_job(paper_id, state="running", stage="Extracting text", started_at=now_iso())
        run_id = None
        try:
            p = svc.paper(paper_id)
            tpl = self.active_template()
            path = pdf_file_path(p)
            doc = get_document(self.db, p["pdf_sha256"], path)
            if doc["status"] in ("no_text", "error"):
                raise ProviderError(doc["message"] or "No extractable text")
            idx = get_index(self.db, p["pdf_sha256"], path)
            run_id = self.db.execute(
                "INSERT INTO extraction_runs(paper_id, template_version, pdf_sha256, status, provider, model, created_at) VALUES(?,?,?,?,?,?,?)",
                (paper_id, tpl["version"], p["pdf_sha256"], "running", svc.provider.name, svc.provider.model, now_iso()),
            ).lastrowid
            result = extract_document(svc.provider, tpl["template"], p, doc["pages"], idx, svc.settings.max_single_pass_chars,
                                      svc.settings.chunk_chars, progress=lambda s: self._set_job(paper_id, stage=s))
            self.persist_run(paper_id, run_id, result, tpl["template"], p["pdf_sha256"])
        except Exception as e:
            msg = str(e) if isinstance(e, ProviderError) else f"{type(e).__name__}: {e}"
            if isinstance(e, ProviderError):
                log.warning("Extraction failed for %s: %s", paper_id, msg)
            else:
                log.exception("Extraction failed for %s", paper_id)
            if run_id is None:
                p = svc.paper(paper_id) or {}
                tpl = self.active_template()
                self.db.execute(
                    "INSERT INTO extraction_runs(paper_id, template_version, pdf_sha256, status, provider, model, created_at, completed_at, error) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (paper_id, tpl["version"] if tpl else None, p.get("pdf_sha256"), "failed", getattr(svc.provider, "name", None),
                     getattr(svc.provider, "model", None), now_iso(), now_iso(), msg))
            else:
                self.db.execute("UPDATE extraction_runs SET status='failed', error=?, completed_at=? WHERE id=?", (msg, now_iso(), run_id))
        finally:
            self.jobs.pop(paper_id, None)

    def persist_run(self, paper_id: str, run_id: int, result: dict[str, Any], t: dict[str, Any], pdf_sha: str | None) -> None:
        groups = group_map(t)
        fmap = field_map(t)
        ts = now_iso()
        with self.db.tx() as conn:
            # deleted: 0 = live, 1 = removed by the reviewer (stays removed), 2 = no longer reported by the AI (may return)
            existing = [dict(r) for r in conn.execute(
                "SELECT * FROM extraction_records WHERE paper_id=? AND deleted IN (0, 2) ORDER BY deleted, sort_order, created_at", (paper_id,))]
            reviewer_removed = {norm(r["label"] or ""): r["id"] for r in conn.execute(
                "SELECT id, label FROM extraction_records WHERE paper_id=? AND deleted=1", (paper_id,)) if r["label"]}
            reviewed_records = {r["record_id"] for r in conn.execute(
                "SELECT DISTINCT record_id FROM extraction_values WHERE paper_id=? AND review_state IN ('accepted','edited','rejected')", (paper_id,))}
            used: set[str] = set()
            key_to_id: dict[str, str] = {}
            skipped_keys: set[str] = set()
            next_order = {g: 1 + max([r["sort_order"] for r in existing if r["group_id"] == g] or [0]) for g in groups}

            for rec in result["records"]:
                gid = rec["group_id"]
                if groups[gid]["repeatable"] and norm(rec["label"]) in reviewer_removed:
                    skipped_keys.add(rec["key"])  # the reviewer deleted this entity; do not resurrect it
                    continue
                target = None
                candidates = [r for r in existing if r["group_id"] == gid and r["id"] not in used]
                if not groups[gid]["repeatable"]:
                    target = candidates[0] if candidates else None
                else:
                    lab = norm(rec["label"])
                    target = next((r for r in candidates if lab and norm(r["label"] or "") == lab), None)
                    if target is None:
                        target = next((r for r in candidates if r["ai_key"] == rec["key"] and r["id"] not in reviewed_records
                                       and r["origin"] == "ai"), None)
                if target is None:
                    rid = uuid.uuid4().hex
                    conn.execute("INSERT INTO extraction_records(id, paper_id, group_id, label, ai_key, sort_order, origin, created_at, updated_at) "
                                 "VALUES(?,?,?,?,?,?,?,?,?)", (rid, paper_id, gid, rec["label"], rec["key"], next_order[gid], "ai", ts, ts))
                    next_order[gid] += 1
                    target = {"id": rid, "label": rec["label"], "group_id": gid, "origin": "ai", "ai_key": rec["key"]}
                    existing.append({**target, "sort_order": next_order[gid] - 1, "deleted": 0})
                elif target["origin"] == "ai" and target["id"] not in reviewed_records:
                    conn.execute("UPDATE extraction_records SET ai_key=?, label=COALESCE(NULLIF(?, ''), label), deleted=0, updated_at=? WHERE id=?",
                                 (rec["key"], rec["label"], ts, target["id"]))
                elif target.get("deleted"):
                    conn.execute("UPDATE extraction_records SET deleted=0, updated_at=? WHERE id=?", (ts, target["id"]))
                used.add(target["id"])
                key_to_id[rec["key"]] = target["id"]

            # AI records from earlier runs that the model no longer reports: drop them only if nobody reviewed them.
            for r in existing:
                if (r["id"] not in used and not r["deleted"] and r["origin"] == "ai" and r["id"] not in reviewed_records
                        and groups.get(r["group_id"], {}).get("repeatable")):
                    conn.execute("UPDATE extraction_records SET deleted=2, updated_at=? WHERE id=?", (ts, r["id"]))

            for rec in result["records"]:
                if rec["key"] in skipped_keys:
                    continue
                rid = key_to_id[rec["key"]]
                for fid, v in rec["values"].items():
                    f = fmap[(rec["group_id"], fid)]
                    value = v["value"]
                    if f["type"] == "reference" and value:
                        value = [key_to_id[k] for k in value if k in key_to_id] or None
                    suggestion = {"status": v["status"], "value": value, "unit": v["unit"], "context": v["context"], "note": v["note"],
                                  "issues": v["issues"], "raw": v["raw"], "run_id": run_id,
                                  "evidence": [{k: e[k] for k in ("verified", "quote", "page", "value_check")} for e in v["evidence"]]}
                    row = conn.execute("SELECT * FROM extraction_values WHERE record_id=? AND field_id=?", (rid, fid)).fetchone()
                    row = dict(row) if row else None
                    replace = row is None or row["review_state"] == "pending" or (
                        row["review_state"] == "rejected" and not _same(loads(row["ai_json"]), suggestion))
                    if replace:
                        removed_quotes = set()
                        if row:
                            removed_quotes = {norm(e["quote"]) for e in conn.execute(
                                "SELECT quote FROM extraction_evidence WHERE value_id=? AND origin='ai' AND removed=1", (row["id"],))}
                            conn.execute("DELETE FROM extraction_evidence WHERE value_id=? AND origin='ai'", (row["id"],))
                            vid = row["id"]
                            conn.execute(
                                "UPDATE extraction_values SET status=?, value_json=?, unit=?, context=?, note=?, origin='ai', review_state='pending', "
                                "issues_json=?, ai_json=?, conflict_json=NULL, run_id=?, reviewed_at=NULL, updated_at=? WHERE id=?",
                                (v["status"], dumps(value), v["unit"], v["context"], v["note"], dumps(v["issues"]), dumps(suggestion), run_id, ts, vid))
                        else:
                            vid = uuid.uuid4().hex
                            conn.execute(
                                "INSERT INTO extraction_values(id, paper_id, record_id, group_id, field_id, status, value_json, unit, context, note, origin, "
                                "review_state, issues_json, ai_json, run_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (vid, paper_id, rid, rec["group_id"], fid, v["status"], dumps(value), v["unit"], v["context"], v["note"], "ai",
                                 "pending", dumps(v["issues"]), dumps(suggestion), run_id, ts, ts))
                        for e in v["evidence"]:
                            self._insert_evidence(conn, paper_id, vid, "ai", e, pdf_sha, run_id, removed=norm(e["quote"]) in removed_quotes)
                    elif row["review_state"] in REVIEWED:
                        current = {"status": row["status"], "value": loads(row["value_json"]), "unit": row["unit"]}
                        conflict = None if _same(current, suggestion) else suggestion
                        conn.execute("UPDATE extraction_values SET conflict_json=?, updated_at=? WHERE id=?",
                                     (dumps(conflict) if conflict else None, ts, row["id"]))
            stats = dict(result["stats"])
            stats["rejected"] = result["rejected"]
            stats["summary"] = result.get("summary", "")
            conn.execute("UPDATE extraction_runs SET status='complete', completed_at=?, stats_json=? WHERE id=?", (ts, dumps(stats), run_id))
            conn.execute("INSERT INTO extraction_papers(paper_id, updated_at) VALUES(?,?) ON CONFLICT(paper_id) DO NOTHING", (paper_id, ts))

    def _insert_evidence(self, conn, paper_id: str, value_id: str, origin: str, e: dict[str, Any], pdf_sha: str | None,
                         run_id: int | None, removed: bool = False) -> str:
        eid = uuid.uuid4().hex
        ts = now_iso()
        conn.execute(
            "INSERT INTO extraction_evidence(id, paper_id, value_id, origin, quote, model_quote, page, rects_json, verified, match_method, "
            "match_score, value_check, pdf_sha256, removed, run_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (eid, paper_id, value_id, origin, e["quote"], e.get("model_quote"), e.get("page"), dumps(e.get("rects") or []),
             int(bool(e.get("verified"))), e.get("match_method"), e.get("match_score"), e.get("value_check") or "n/a", pdf_sha,
             int(removed), run_id, ts, ts))
        return eid

    # ------------------------------------------------------------ review: values

    def _field(self, group_id: str, field_id: str) -> dict[str, Any]:
        tpl = self.active_template()
        f = field_map(tpl["template"]).get((group_id, field_id)) if tpl else None
        if not f:
            raise ValueError(f"Field {group_id}.{field_id} is not in the active template")
        return f

    def validate_manual_value(self, paper_id: str, f: dict[str, Any], value: Any) -> tuple[Any, list[str]]:
        if value is None or value == "" or value == []:
            return None, []
        if f["type"] == "reference":
            ids = value if isinstance(value, list) else [value]
            valid = {r["id"] for r in self.db.all("SELECT id FROM extraction_records WHERE paper_id=? AND group_id=? AND deleted=0",
                                                  (paper_id, f["target_group"]))}
            bad = [i for i in ids if i not in valid]
            if bad:
                raise ValueError(f"Unknown {f['target_group']} record(s): {', '.join(bad)}")
            return (ids if f["multiple"] else ids[:1]), []
        raw = [str(x) for x in value] if isinstance(value, list) else (
            ["yes" if value else "no"] if isinstance(value, bool) else [str(value)])
        typed, issues, _ = coerce_value(f, raw)
        hard = [i for i in issues if "not a number" in i or "not a whole number" in i or "not yes/no" in i or "not an ISO date" in i
                or ("not one of the allowed options" in i)]
        if hard:
            raise ValueError(hard[0])
        return typed, issues

    def ensure_value(self, paper_id: str, record_id: str, field_id: str) -> dict[str, Any]:
        rec = self.db.one("SELECT * FROM extraction_records WHERE id=? AND paper_id=?", (record_id, paper_id))
        if not rec:
            raise LookupError("Unknown record")
        row = self.db.one("SELECT * FROM extraction_values WHERE record_id=? AND field_id=?", (record_id, field_id))
        if row:
            return row
        self._field(rec["group_id"], field_id)
        vid, ts = uuid.uuid4().hex, now_iso()
        self.db.execute(
            "INSERT INTO extraction_values(id, paper_id, record_id, group_id, field_id, status, origin, review_state, created_at, updated_at) "
            "VALUES(?,?,?,?,?,NULL,'manual','edited',?,?)", (vid, paper_id, record_id, rec["group_id"], field_id, ts, ts))
        return self.db.one("SELECT * FROM extraction_values WHERE id=?", (vid,))

    def upsert_value(self, paper_id: str, group_id: str, record_id: str | None, field_id: str, action: str, data: dict[str, Any]) -> str:
        """Edit a field that may not have a record (single groups) or a value row yet."""
        if not record_id:
            record_id = self.add_record(paper_id, group_id)["id"]
        row = self.ensure_value(paper_id, record_id, field_id)
        self.update_value(row["id"], action, data)
        return row["id"]

    def update_value(self, value_id: str, action: str, data: dict[str, Any]) -> None:
        row = self.db.one("SELECT * FROM extraction_values WHERE id=?", (value_id,))
        if not row:
            raise LookupError("Unknown value")
        ts = now_iso()
        fields: dict[str, Any] = {}
        if action == "accept":
            if not row["status"]:
                raise ValueError("Nothing to accept: set a value or status first")
            fields = {"review_state": "accepted", "reviewed_at": ts}
        elif action == "reject":
            fields = {"review_state": "rejected", "reviewed_at": ts}
        elif action == "edit":
            f = self._field(row["group_id"], row["field_id"])
            status = data.get("status", row["status"])
            if status not in (None, *("reported", "not_reported", "unclear", "not_applicable")):
                raise ValueError(f"Invalid status {status}")
            if "value" in data:
                typed, issues = self.validate_manual_value(row["paper_id"], f, data["value"])
            else:
                typed, issues = loads(row["value_json"]), loads(row["issues_json"], []) or []
            if status in ("not_reported", "not_applicable"):
                typed, issues = None, []
            elif status in OPEN_STATUSES and typed is None and "value" in data:
                raise ValueError("Enter a value, or mark the field Not reported / Unclear / Not applicable")
            if status is None and typed is not None:
                status = "reported"
            fields = {"status": status, "value_json": dumps(typed), "issues_json": dumps(issues), "review_state": "edited", "reviewed_at": ts}
            for k in ("unit", "context", "note"):
                if k in data:
                    fields[k] = (data[k] or "").strip()
        elif action == "note":
            fields = {"note": (data.get("note") or "").strip()}
        elif action == "reset":
            ai = loads(row["ai_json"])
            if not ai:
                raise ValueError("There is no AI suggestion to restore")
            fields = {"status": ai["status"], "value_json": dumps(ai["value"]), "unit": ai.get("unit"), "context": ai.get("context"),
                      "issues_json": dumps(ai.get("issues") or []), "review_state": "pending", "reviewed_at": None}
        elif action == "use_conflict":
            c = loads(row["conflict_json"])
            if not c:
                raise ValueError("There is no newer AI suggestion")
            fields = {"status": c["status"], "value_json": dumps(c["value"]), "unit": c.get("unit"), "context": c.get("context"),
                      "issues_json": dumps(c.get("issues") or []), "ai_json": dumps(c), "conflict_json": None,
                      "origin": "ai", "review_state": "pending", "reviewed_at": None, "run_id": c.get("run_id")}
            self._replace_ai_evidence_from_suggestion(row, c)
        elif action == "dismiss_conflict":
            fields = {"conflict_json": None}
        else:
            raise ValueError(f"Unknown action {action}")
        fields["updated_at"] = ts
        sets = ", ".join(f"{k}=?" for k in fields)
        self.db.execute(f"UPDATE extraction_values SET {sets} WHERE id=?", tuple(fields.values()) + (value_id,))
        self._touch(row["paper_id"])

    def _replace_ai_evidence_from_suggestion(self, row: dict[str, Any], suggestion: dict[str, Any]) -> None:
        p = self.svc.paper(row["paper_id"])
        path = pdf_file_path(p) if p else None
        idx = get_index(self.db, p["pdf_sha256"], path) if path else None
        f = self._field(row["group_id"], row["field_id"])
        with self.db.tx() as conn:
            conn.execute("DELETE FROM extraction_evidence WHERE value_id=? AND origin='ai'", (row["id"],))
            for e in suggestion.get("evidence") or []:
                m = idx.locate(e["quote"], page_hint=e.get("page")) if idx else None
                ev = ({"verified": True, "quote": m["text"], "model_quote": e["quote"], "page": m["page"], "rects": m["rects"],
                       "match_method": m["method"], "match_score": m["score"],
                       "value_check": value_in_passage(f, suggestion.get("raw") or [], m["text"])} if m else
                      {"verified": False, "quote": e["quote"], "model_quote": e["quote"], "page": e.get("page"), "rects": []})
                self._insert_evidence(conn, row["paper_id"], row["id"], "ai", ev, p["pdf_sha256"] if p else None, suggestion.get("run_id"))

    def accept_verified(self, paper_id: str) -> int:
        """Accept every pending reported value whose evidence is verified, consistent and issue-free."""
        n = 0
        evs: dict[str, list[dict]] = {}
        for e in self._evidence_rows(paper_id):
            evs.setdefault(e["value_id"], []).append(e)
        tpl = self.active_template()
        fmap = field_map(tpl["template"]) if tpl else {}
        ts = now_iso()
        for v in self._value_rows(paper_id):
            if v["review_state"] != "pending" or v["status"] != "reported" or v["record_deleted"] or (v["group_id"], v["field_id"]) not in fmap:
                continue
            if loads(v["issues_json"], []):
                continue
            live = [e for e in evs.get(v["id"], []) if not e["removed"]]
            if live and all(e["verified"] for e in live) and not any(e["value_check"] == "mismatch" for e in live):
                self.db.execute("UPDATE extraction_values SET review_state='accepted', reviewed_at=?, updated_at=? WHERE id=?", (ts, ts, v["id"]))
                n += 1
        if n:
            self._touch(paper_id)
        return n

    def accept_all(self, paper_id: str) -> list[str]:
        """Accept every pending AI suggestion of the paper (live records, fields in the template).

        Unlike accept_verified this includes suggestions with unverified or mismatched evidence; the
        reviewer confirms that explicitly in the UI. Returns the accepted value ids so it can be undone.
        """
        tpl = self.active_template()
        fmap = field_map(tpl["template"]) if tpl else {}
        ids = [v["id"] for v in self._value_rows(paper_id)
               if v["review_state"] == "pending" and v["status"] and not v["record_deleted"] and (v["group_id"], v["field_id"]) in fmap]
        if ids:
            ts = now_iso()
            with self.db.tx() as conn:
                conn.executemany("UPDATE extraction_values SET review_state='accepted', reviewed_at=?, updated_at=? WHERE id=?",
                                 [(ts, ts, i) for i in ids])
            self._touch(paper_id)
        return ids

    def undo_accept(self, paper_id: str, value_ids: list[str]) -> int:
        """Return values accepted in bulk to pending, unless the reviewer has changed them since."""
        if not value_ids:
            return 0
        ts = now_iso()
        q = ",".join("?" * len(value_ids))
        n = self.db.execute(
            f"UPDATE extraction_values SET review_state='pending', reviewed_at=NULL, updated_at=? "
            f"WHERE paper_id=? AND review_state='accepted' AND id IN ({q})", (ts, paper_id, *value_ids)).rowcount
        if n:
            self._touch(paper_id)
        return n

    # ------------------------------------------------------------ review: records

    def add_record(self, paper_id: str, group_id: str, label: str = "") -> dict[str, Any]:
        tpl = self.active_template()
        g = group_map(tpl["template"]).get(group_id) if tpl else None
        if not g:
            raise ValueError(f"Group {group_id} is not in the active template")
        if not g["repeatable"]:
            row = self.db.one("SELECT * FROM extraction_records WHERE paper_id=? AND group_id=? AND deleted=0", (paper_id, group_id))
            if row:
                return row
        order = (self.db.one("SELECT MAX(sort_order) m FROM extraction_records WHERE paper_id=? AND group_id=?", (paper_id, group_id))["m"] or 0) + 1
        rid, ts = uuid.uuid4().hex, now_iso()
        self.db.execute("INSERT INTO extraction_records(id, paper_id, group_id, label, sort_order, origin, created_at, updated_at) "
                        "VALUES(?,?,?,?,?,'manual',?,?)", (rid, paper_id, group_id, label.strip() or None, order, ts, ts))
        self.db.execute("INSERT INTO extraction_papers(paper_id, updated_at) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET updated_at=excluded.updated_at",
                        (paper_id, ts))
        return self.db.one("SELECT * FROM extraction_records WHERE id=?", (rid,))

    def update_record(self, record_id: str, label: str | None = None, deleted: bool | None = None, sort_order: int | None = None) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM extraction_records WHERE id=?", (record_id,))
        if not row:
            raise LookupError("Unknown record")
        fields: dict[str, Any] = {"updated_at": now_iso()}
        if label is not None:
            fields["label"] = label.strip() or None
        if deleted is not None:
            fields["deleted"] = 1 if deleted else 0
        if sort_order is not None:
            fields["sort_order"] = sort_order
        sets = ", ".join(f"{k}=?" for k in fields)
        self.db.execute(f"UPDATE extraction_records SET {sets} WHERE id=?", tuple(fields.values()) + (record_id,))
        self._touch(row["paper_id"])
        return self.db.one("SELECT * FROM extraction_records WHERE id=?", (record_id,))

    # ------------------------------------------------------------ review: evidence

    def add_evidence(self, value_id: str, quote: str, page: int, selection_rects: list[list[float]] | None) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM extraction_values WHERE id=?", (value_id,))
        if not row:
            raise LookupError("Unknown value")
        p = self.svc.paper(row["paper_id"])
        path = pdf_file_path(p)
        if not path:
            raise ValueError("No local PDF")
        idx = get_index(self.db, p["pdf_sha256"], path)
        m = idx.locate(quote, page_hint=page, hint_rects=selection_rects, min_len=3, fuzzy=True)
        f = field_map(self.active_template()["template"]).get((row["group_id"], row["field_id"]), {"type": "text"})
        raw = loads(row["value_json"])
        raw = [str(raw)] if raw is not None and not isinstance(raw, list) else [str(x) for x in (raw or [])]
        if m:
            ev = {"verified": True, "quote": m["text"], "page": m["page"], "rects": m["rects"], "match_method": m["method"],
                  "match_score": m["score"], "value_check": value_in_passage(f, raw, m["text"])}
        elif selection_rects:
            rects = [r for r in selection_rects if len(r) == 5]
            if not rects:
                raise ValueError("Invalid selection geometry")
            ev = {"verified": True, "quote": " ".join(quote.split()), "page": page, "rects": rects, "match_method": "selection",
                  "match_score": None, "value_check": value_in_passage(f, raw, quote)}
        else:
            raise ValueError("The selected text could not be located in the PDF text layer.")
        with self.db.tx() as conn:
            eid = self._insert_evidence(conn, row["paper_id"], value_id, "manual", ev, p["pdf_sha256"], None)
        self._touch(row["paper_id"])
        return next(e for e in self._evidence_rows(row["paper_id"]) if e["id"] == eid)

    def update_evidence(self, evidence_id: str, removed: bool) -> dict[str, Any]:
        e = self.db.one("SELECT * FROM extraction_evidence WHERE id=?", (evidence_id,))
        if not e:
            raise LookupError("Unknown evidence")
        self.db.execute("UPDATE extraction_evidence SET removed=?, updated_at=? WHERE id=?", (int(removed), now_iso(), evidence_id))
        self._touch(e["paper_id"])
        return next(x for x in self._evidence_rows(e["paper_id"]) if x["id"] == evidence_id)

    def delete_evidence(self, evidence_id: str) -> None:
        e = self.db.one("SELECT * FROM extraction_evidence WHERE id=?", (evidence_id,))
        if not e:
            raise LookupError("Unknown evidence")
        if e["origin"] != "manual":
            raise ValueError("AI evidence can be removed but not deleted")
        self.db.execute("DELETE FROM extraction_evidence WHERE id=?", (evidence_id,))
        self._touch(e["paper_id"])

    def reverify_evidence(self, paper_id: str) -> dict[str, int]:
        """Re-anchor every quotation against the current PDF (after the file was replaced)."""
        p = self.svc.paper(paper_id)
        path = pdf_file_path(p) if p else None
        if not path:
            raise ValueError("No local PDF")
        idx = get_index(self.db, p["pdf_sha256"], path)
        counts = {"verified": 0, "unverified": 0}
        ts = now_iso()
        for e in self._evidence_rows(paper_id):
            q = e["model_quote"] or e["quote"]
            m = idx.locate(q, page_hint=e["page"], min_len=3)
            if m:
                counts["verified"] += 1
                self.db.execute("UPDATE extraction_evidence SET verified=1, quote=?, page=?, rects_json=?, match_method=?, match_score=?, "
                                "pdf_sha256=?, updated_at=? WHERE id=?",
                                (m["text"], m["page"], dumps(m["rects"]), m["method"], m["score"], p["pdf_sha256"], ts, e["id"]))
            else:
                counts["unverified"] += 1
                self.db.execute("UPDATE extraction_evidence SET verified=0, rects_json='[]', pdf_sha256=?, updated_at=? WHERE id=?",
                                (p["pdf_sha256"], ts, e["id"]))
        return counts

    # ------------------------------------------------------------ paper-level

    def _touch(self, paper_id: str) -> None:
        self.db.execute("INSERT INTO extraction_papers(paper_id, updated_at) VALUES(?,?) ON CONFLICT(paper_id) DO UPDATE SET updated_at=excluded.updated_at",
                        (paper_id, now_iso()))

    def set_notes(self, paper_id: str, body: str) -> str:
        ts = now_iso()
        self.db.execute("INSERT INTO extraction_papers(paper_id, notes, updated_at) VALUES(?,?,?) ON CONFLICT(paper_id) DO UPDATE SET "
                        "notes=excluded.notes, updated_at=excluded.updated_at", (paper_id, body, ts))
        return ts

    def set_completed(self, paper_id: str, completed: bool, force: bool = False) -> dict[str, Any]:
        if completed:
            d = self.paper_detail(paper_id)
            c = d["counts"]
            warnings = []
            if c["pending"]:
                warnings.append(f"{c['pending']} AI suggestion(s) are not reviewed yet")
            if c["required_missing"]:
                warnings.append(f"{c['required_missing']} required field(s) have no value or status")
            if c["conflicts"]:
                warnings.append(f"{c['conflicts']} value(s) have an unresolved newer AI suggestion")
            if warnings and not force:
                return {"completed": False, "warnings": warnings}
            ts = now_iso()
            self.db.execute("INSERT INTO extraction_papers(paper_id, completed_at, completed_template_version, updated_at) VALUES(?,?,?,?) "
                            "ON CONFLICT(paper_id) DO UPDATE SET completed_at=excluded.completed_at, "
                            "completed_template_version=excluded.completed_template_version, updated_at=excluded.updated_at",
                            (paper_id, ts, d["template_version"], ts))
            return {"completed": True, "warnings": warnings}
        self.db.execute("UPDATE extraction_papers SET completed_at=NULL, completed_template_version=NULL, updated_at=? WHERE paper_id=?",
                        (now_iso(), paper_id))
        return {"completed": False, "warnings": []}
