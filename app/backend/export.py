"""CSV export of screening results, and JSON backup/restore of reviewer data."""
from __future__ import annotations

import csv
import io
from typing import Any

from .db import Database, dumps, loads, now_iso
from .service import Services

STATUS_LABELS = {
    "met": "Met", "not_met": "Not met", "unclear": "Unclear", "not_applicable": "Not applicable",
    "triggered": "Triggered", "not_triggered": "Confirmed absent", "not_found": "Not found",
}


def _evidence_summary(items: list[dict[str, Any]], limit: int = 4) -> str:
    out = []
    for e in sorted(items, key=lambda e: (e["page"], e["created_at"] or ""))[:limit]:
        q = e["quote"] if len(e["quote"]) <= 240 else e["quote"][:237] + "…"
        tag = {"include": "+", "exclude": "−", "uncertain": "?"}.get(e["polarity"], "")
        src = " [manual]" if e["origin"] == "manual" else ""
        out.append(f"{tag}p.{e['page']}: “{q}”{src}")
    if len(items) > limit:
        out.append(f"(+{len(items) - limit} more)")
    return " | ".join(out)


def export_csv(svc: Services) -> str:
    db = svc.db
    criteria = svc.criteria.get()
    fieldnames = loads(db.get_meta("csv_fieldnames"), []) or ["Paper_ID", "Paper_Title", "DOI", "Link"]
    papers = db.all("SELECT * FROM papers WHERE in_source=1 ORDER BY source_order")
    listing = {p["paper_id"]: p for p in svc.list_papers()}
    inc_ids = [c["id"] for c in criteria["inclusion"]] if criteria else []
    exc_ids = [c["id"] for c in criteria["exclusion"]] if criteria else []
    sub_ids = [s["id"] for c in (criteria["inclusion"] if criteria else []) for s in c.get("sub_requirements", [])]

    extra = [
        "Authors", "Year", "PDF_Available", "PDF_File", "Access_Status", "Manifest_Duplicate_Of",
        "Human_Decision", "Human_Code", "Human_Reason", "Decision_Timestamp",
        "AI_Suggested_Decision", "AI_Suggested_Code", "AI_Recommendation_Reason", "AI_Model_Rationale",
        "AI_Analysis_Status", "AI_Analysis_Outdated_Reason", "AI_Model", "AI_Analyzed_At",
        "AI_Quotes_Verified", "AI_Quotes_Rejected",
        "Inclusion_Summary", "Exclusion_Summary", "Study_Characteristics",
    ]
    for cid in inc_ids + sub_ids + exc_ids:
        extra += [f"{cid}_Status", f"{cid}_Explanation", f"{cid}_Evidence"]
    extra += ["Reviewer_Notes", "Notes_Updated_At"]
    header = list(fieldnames) + [c for c in extra if c not in fieldnames]

    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=header, extrasaction="ignore", quoting=csv.QUOTE_ALL)
    w.writeheader()
    for p in papers:
        pid = p["paper_id"]
        row: dict[str, Any] = dict((loads(p["csv_json"], {}) or {}).get("row", {}))
        det = svc.paper_detail(pid)
        a = det["analysis"]
        d = det["decision"] or {}
        ev_active = [e for e in det["evidence"] if not e["dismissed"]]
        res = (a or {}).get("result", {})
        rec = (a or {}).get("recommendation", {})
        st = res.get("assessments", {})
        characteristics = res.get("study_characteristics", []) or []
        if not characteristics and res.get("input_profile"):
            profile = res["input_profile"]
            characteristics = [
                {"label": key.replace("_", " ").title(), "value": value}
                for key, value in profile.items()
                if value
            ]

        def status(cid: str) -> str:
            return STATUS_LABELS.get(st.get(cid, {}).get("status", ""), "") if a else ""

        row.update({
            "Authors": p["authors"] or "",
            "Year": p["year"] or "",
            "PDF_Available": "Yes" if p["pdf_exists"] else "No",
            "PDF_File": det["paper"]["pdf_relpath"] or "",
            "Access_Status": p["access_status"] or "",
            "Manifest_Duplicate_Of": p["duplicate_of"] or "",
            "Human_Decision": (d.get("decision") or "").upper(),
            "Human_Code": d.get("code") or "",
            "Human_Reason": d.get("reason") or "",
            "Decision_Timestamp": d.get("decided_at") or "",
            "AI_Suggested_Decision": (rec.get("decision") or "").upper(),
            "AI_Suggested_Code": rec.get("code") or "",
            "AI_Recommendation_Reason": rec.get("explanation") or "",
            "AI_Model_Rationale": res.get("model_rationale") or "",
            "AI_Analysis_Status": listing.get(pid, {}).get("analysis_state", ""),
            "AI_Analysis_Outdated_Reason": (a or {}).get("outdated_reason") or "",
            "AI_Model": f"{a['provider']}:{a['model']}" if a else "",
            "AI_Analyzed_At": (a or {}).get("completed_at") or "",
            "AI_Quotes_Verified": (a or {}).get("stats", {}).get("quotes_verified", "") if a else "",
            "AI_Quotes_Rejected": (a or {}).get("stats", {}).get("quotes_rejected", "") if a else "",
            "Inclusion_Summary": "; ".join(f"{c}: {status(c)}" for c in inc_ids) if a else "",
            "Exclusion_Summary": "; ".join(f"{c}: {status(c)}" for c in exc_ids) if a else "",
            "Study_Characteristics": "; ".join(
                f"{item.get('label', '')}: {item.get('value', '')}" for item in characteristics
            ),
            "Reviewer_Notes": (det["notes"] or {}).get("body") or "",
            "Notes_Updated_At": (det["notes"] or {}).get("updated_at") or "",
        })
        for cid in inc_ids + sub_ids + exc_ids:
            row[f"{cid}_Status"] = status(cid)
            row[f"{cid}_Explanation"] = st.get(cid, {}).get("justification", "") if a else ""
            row[f"{cid}_Evidence"] = _evidence_summary([e for e in ev_active if e["criterion_id"] == cid])
        w.writerow(row)
    return "﻿" + buf.getvalue()  # BOM so Excel opens UTF-8 correctly


# ---------------------------------------------------------------- backup / restore

BACKUP_TABLES = ("decisions", "decision_log", "notes", "evidence", "analyses",
                 "extraction_templates", "extraction_papers", "extraction_records", "extraction_values",
                 "extraction_evidence", "extraction_runs")
# Extraction rows are merged by primary key; the newer updated_at wins.
EXTRACTION_MERGE_KEYS = {"extraction_papers": "paper_id", "extraction_records": "id",
                         "extraction_values": "id", "extraction_evidence": "id"}


def backup(db: Database) -> dict[str, Any]:
    return {
        "format": "screening-backup",
        "version": 2,  # v2 adds extraction tables; v1 backups remain restorable
        "created_at": now_iso(),
        "tables": {t: db.all(f"SELECT * FROM {t}") for t in BACKUP_TABLES},
    }


def restore(db: Database, data: dict[str, Any], mode: str = "merge") -> dict[str, int]:
    """Restore reviewer data. mode='merge' keeps newer local decisions/notes; 'replace' overwrites everything."""
    if data.get("format") != "screening-backup":
        raise ValueError("Not a screening backup file")
    if data.get("version", 1) not in (1, 2):
        raise ValueError(f"Unsupported backup version {data.get('version')}")
    tables = data.get("tables", {})
    counts: dict[str, int] = {}
    with db.tx() as conn:
        if mode == "replace":
            for t in BACKUP_TABLES:
                if t.startswith("extraction_") and t not in tables:
                    continue  # a v1 backup has no extraction data: keep the local extraction work
                conn.execute(f"DELETE FROM {t}")
        for t in BACKUP_TABLES:
            if t not in tables:
                continue
            rows = tables.get(t, [])
            cols_avail = {r[1] for r in conn.execute(f"PRAGMA table_info({t})")}
            n = 0
            for r in rows:
                r = {k: v for k, v in r.items() if k in cols_avail}
                if not r:
                    continue
                if mode == "merge" and t in ("decisions", "notes"):
                    ts_col = "decided_at" if t == "decisions" else "updated_at"
                    cur = conn.execute(f"SELECT {ts_col} FROM {t} WHERE paper_id=?", (r["paper_id"],)).fetchone()
                    if cur and (cur[0] or "") >= (r.get(ts_col) or ""):
                        continue
                if mode == "merge" and t == "evidence" and r.get("origin") == "ai":
                    # AI evidence belongs to a specific analysis; in merge mode only carry over dismissals.
                    conn.execute("UPDATE evidence SET dismissed=? WHERE id=?", (r.get("dismissed", 0), r.get("id")))
                    continue
                if mode == "merge" and t in EXTRACTION_MERGE_KEYS:
                    key = EXTRACTION_MERGE_KEYS[t]
                    cur = conn.execute(f"SELECT updated_at FROM {t} WHERE {key}=?", (r.get(key),)).fetchone()
                    if cur and (cur[0] or "") >= (r.get("updated_at") or ""):
                        continue
                if mode == "merge" and t == "extraction_templates":
                    if conn.execute("SELECT 1 FROM extraction_templates WHERE version=?", (r.get("version"),)).fetchone():
                        continue  # template versions are immutable; never overwrite a local version
                if mode == "merge" and t == "extraction_runs":
                    continue  # run history is restored only in replace mode
                if mode == "merge" and t in ("decision_log", "analyses"):
                    r.pop("id", None)
                    if t == "decision_log":
                        dup = conn.execute("SELECT 1 FROM decision_log WHERE paper_id=? AND decided_at=? AND decision=?",
                                           (r.get("paper_id"), r.get("decided_at"), r.get("decision"))).fetchone()
                        if dup:
                            continue
                    if t == "analyses":
                        continue  # analyses are restored only in replace mode (ids are referenced by evidence)
                cols = ", ".join(r)
                ph = ", ".join("?" * len(r))
                conn.execute(f"INSERT OR REPLACE INTO {t}({cols}) VALUES({ph})", tuple(r.values()))
                n += 1
            counts[t] = n
    return counts
