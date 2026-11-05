"""Export of extracted data: relational CSV files (ZIP) and a hierarchical JSON document.

Files in the ZIP:
  study_level.csv      one row per paper: single-group fields + counts of repeatable records
  <group>.csv          one row per record of each repeatable group (record_id, paper_id, ...);
                       reference fields hold the referenced record_id(s) plus their labels
  values_long.csv      one row per extracted value with status, unit, context, review state, issues
  evidence.csv         one row per source passage (quote, page, verification) linked to values
  data_dictionary.csv  every field with its type, unit, options and the CSV columns it maps to
  extraction.json      the complete hierarchy (template + papers + records + values + evidence)
  template.json        the extraction template used for the column layout
  README.txt           description of the files
Nothing is dropped: values of fields removed from the template appear in values_long.csv and
extraction.json with in_template = false.
"""
from __future__ import annotations

import csv
import io
import json
import zipfile
from typing import Any

from .db import loads, now_iso
from .extraction_templates import field_map

NUMERIC = ("number", "integer")


def display(v: Any, labels: dict[str, str] | None = None) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, list):
        return " | ".join(display(labels.get(x, x) if labels else x) for x in v)
    return str(v)


def _csv(rows: list[dict[str, Any]], header: list[str]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=header, extrasaction="ignore", quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in header})
    return "﻿" + buf.getvalue()


def collect(xsvc, reviewed_only: bool = False, include_ineligible: bool = False) -> dict[str, Any]:
    """Gather all extraction data as plain dicts (shared by CSV and JSON exports)."""
    tpl = xsvc.active_template()
    if not tpl:
        raise ValueError("No extraction template has been defined")
    listing = {p["paper_id"]: p for p in xsvc.list_papers()["papers"]}
    papers = []
    for pid, summary in listing.items():
        if not summary["eligible"] and not include_ineligible:
            continue
        d = xsvc.paper_detail(pid)
        live_records = [r for r in d["records"] if not r["deleted"]]
        values = []
        for v in d["values"]:
            if v["review_state"] == "rejected" or not v["status"]:
                continue
            if reviewed_only and v["review_state"] not in ("accepted", "edited"):
                continue
            values.append(v)
        papers.append({"summary": summary, "detail": d, "records": live_records, "values": values})
    return {"template": tpl, "papers": papers}


def _record_index(records: list[dict]) -> dict[str, int]:
    idx: dict[str, int] = {}
    counter: dict[tuple[str, str], int] = {}
    for r in sorted(records, key=lambda r: (r["group_id"], r["sort_order"], r["created_at"] or "")):
        k = (r.get("paper_id", ""), r["group_id"])
        counter[k] = counter.get(k, 0) + 1
        idx[r["id"]] = counter[k]
    return idx


def build_zip(xsvc, reviewed_only: bool = False, include_ineligible: bool = False) -> bytes:
    data = collect(xsvc, reviewed_only, include_ineligible)
    t = data["template"]["template"]
    fmap = field_map(t)
    single = [g for g in t["groups"] if not g["repeatable"]]
    repeat = [g for g in t["groups"] if g["repeatable"]]
    files: dict[str, str] = {}

    # ---- study level
    header = ["paper_id", "title", "authors", "year", "doi", "screening_decision", "screening_code", "currently_included",
              "extraction_status", "completed_at", "template_version"]
    for g in single:
        for f in g["fields"]:
            base = f"{g['id']}__{f['id']}"
            header += [base, f"{base}__status"] + ([f"{base}__unit", f"{base}__context"] if f["type"] in NUMERIC else [])
    header += [f"n_{g['id']}" for g in repeat] + ["extraction_notes"]
    study_rows, group_rows = [], {g["id"]: [] for g in repeat}
    long_rows, ev_rows, json_papers = [], [], []
    for p in data["papers"]:
        d, s = p["detail"], p["summary"]
        meta = d["paper"]
        records = p["records"]
        labels = {r["id"]: r["label"] or "" for r in records}
        ridx = _record_index([{**r, "paper_id": meta["paper_id"]} for r in records])
        vals_by_rec: dict[str, dict[str, dict]] = {}
        for v in p["values"]:
            vals_by_rec.setdefault(v["record_id"], {})[v["field_id"]] = v
        row = {"paper_id": meta["paper_id"], "title": meta["title"], "authors": meta["authors"], "year": meta["year"], "doi": meta["doi"],
               "screening_decision": (d["decision"] or {}).get("decision"), "screening_code": (d["decision"] or {}).get("code"),
               "currently_included": "yes" if d["eligible"] else "no", "extraction_status": s["status"], "completed_at": d["completed_at"],
               "template_version": data["template"]["version"], "extraction_notes": d["notes"]}
        for g in single:
            rec = next((r for r in records if r["group_id"] == g["id"]), None)
            vals = vals_by_rec.get(rec["id"], {}) if rec else {}
            for f in g["fields"]:
                base, v = f"{g['id']}__{f['id']}", vals.get(f["id"])
                row[base] = display(v["value"], labels) if v else ""
                row[f"{base}__status"] = v["status"] if v else ""
                if f["type"] in NUMERIC:
                    row[f"{base}__unit"] = (v or {}).get("unit", "")
                    row[f"{base}__context"] = (v or {}).get("context", "")
        for g in repeat:
            recs = [r for r in records if r["group_id"] == g["id"]]
            row[f"n_{g['id']}"] = len(recs)
            for r in recs:
                gr = {"record_id": r["id"], "paper_id": meta["paper_id"], "record_label": r["label"] or "", "record_index": ridx[r["id"]]}
                vals = vals_by_rec.get(r["id"], {})
                for f in g["fields"]:
                    v = vals.get(f["id"])
                    gr[f["id"]] = display(v["value"]) if v else ""
                    gr[f"{f['id']}__status"] = v["status"] if v else ""
                    if f["type"] in NUMERIC:
                        gr[f"{f['id']}__unit"] = (v or {}).get("unit", "")
                        gr[f"{f['id']}__context"] = (v or {}).get("context", "")
                    if f["type"] == "reference":
                        gr[f"{f['id']}__label"] = display(v["value"], labels) if v else ""
                group_rows[g["id"]].append(gr)
        study_rows.append(row)

        # ---- long format + evidence (includes archived values)
        rec_by_id = {r["id"]: r for r in d["records"]}
        for v in p["values"]:
            f = fmap.get((v["group_id"], v["field_id"]))
            r = rec_by_id.get(v["record_id"], {})
            if r.get("deleted"):
                continue
            live_ev = [e for e in v["evidence"] if not e["removed"]]
            long_rows.append({
                "value_id": v["id"], "paper_id": meta["paper_id"], "group_id": v["group_id"], "record_id": v["record_id"],
                "record_label": r.get("label") or "", "record_index": ridx.get(v["record_id"], ""), "field_id": v["field_id"],
                "field_label": f["label"] if f else "", "field_type": f["type"] if f else "", "in_template": "yes" if v["in_template"] else "no",
                "status": v["status"], "value": display(v["value"], labels if f and f["type"] == "reference" else None),
                "value_json": json.dumps(v["value"], ensure_ascii=False), "unit": v["unit"], "context": v["context"],
                "origin": v["origin"], "review_state": v["review_state"], "issues": " | ".join(v["issues"]), "note": v["note"],
                "evidence_count": len(live_ev), "verified_evidence_count": sum(1 for e in live_ev if e["verified"]),
                "ai_suggested_value": display((v["ai"] or {}).get("value"), labels) if v["ai"] else "",
                "ai_suggested_status": (v["ai"] or {}).get("status", "") if v["ai"] else "",
                "reviewed_at": v["reviewed_at"], "updated_at": v["updated_at"],
            })
            for e in live_ev:
                ev_rows.append({
                    "evidence_id": e["id"], "value_id": v["id"], "paper_id": meta["paper_id"], "group_id": v["group_id"],
                    "record_id": v["record_id"], "record_label": r.get("label") or "", "field_id": v["field_id"],
                    "value": display(v["value"], labels if f and f["type"] == "reference" else None), "page": e["page"],
                    "quote": e["quote"], "verified": "yes" if e["verified"] else "no", "match_method": e["match_method"] or "",
                    "match_score": e["match_score"] if e["match_score"] is not None else "", "value_in_passage": e["value_check"] or "",
                    "origin": e["origin"], "model_quote": e["model_quote"] or "",
                })

        # ---- JSON hierarchy
        jgroups: dict[str, list] = {}
        for r in records:
            vals = vals_by_rec.get(r["id"], {})
            jgroups.setdefault(r["group_id"], []).append({
                "record_id": r["id"], "label": r["label"], "origin": r["origin"], "index": ridx[r["id"]],
                "values": {fid: {k: v[k] for k in ("status", "value", "unit", "context", "note", "origin", "review_state", "issues", "in_template")}
                           | {"evidence": [{k: e[k] for k in ("page", "quote", "verified", "match_method", "value_check", "origin")}
                                           for e in v["evidence"] if not e["removed"]]}
                           for fid, v in vals.items()},
            })
        json_papers.append({"paper_id": meta["paper_id"], "title": meta["title"], "doi": meta["doi"], "year": meta["year"],
                            "screening_decision": (d["decision"] or {}).get("decision"), "currently_included": d["eligible"],
                            "extraction_status": s["status"], "completed_at": d["completed_at"], "notes": d["notes"], "groups": jgroups})

    files["study_level.csv"] = _csv(study_rows, header)
    for g in repeat:
        gh = ["record_id", "paper_id", "record_label", "record_index"]
        for f in g["fields"]:
            gh += [f["id"], f"{f['id']}__status"] + ([f"{f['id']}__unit", f"{f['id']}__context"] if f["type"] in NUMERIC else []) + (
                [f"{f['id']}__label"] if f["type"] == "reference" else [])
        files[f"{g['id']}.csv"] = _csv(group_rows[g["id"]], gh)
    files["values_long.csv"] = _csv(long_rows, ["value_id", "paper_id", "group_id", "record_id", "record_label", "record_index", "field_id",
                                                "field_label", "field_type", "in_template", "status", "value", "value_json", "unit", "context",
                                                "origin", "review_state", "issues", "note", "evidence_count", "verified_evidence_count",
                                                "ai_suggested_value", "ai_suggested_status", "reviewed_at", "updated_at"])
    files["evidence.csv"] = _csv(ev_rows, ["evidence_id", "value_id", "paper_id", "group_id", "record_id", "record_label", "field_id", "value",
                                           "page", "quote", "verified", "match_method", "match_score", "value_in_passage", "origin", "model_quote"])
    dict_rows = []
    for g in t["groups"]:
        for f in g["fields"]:
            if g["repeatable"]:
                cols = [f"{g['id']}.csv:{f['id']}"]
            else:
                cols = [f"study_level.csv:{g['id']}__{f['id']}"]
            dict_rows.append({"group_id": g["id"], "group_label": g["label"], "repeatable": "yes" if g["repeatable"] else "no",
                              "field_id": f["id"], "field_label": f["label"], "type": f["type"], "required": "yes" if f["required"] else "no",
                              "unit": f["unit"], "options": " | ".join(f["options"]), "references": f["target_group"],
                              "description": f["description"], "instructions": f["instructions"], "columns": "; ".join(cols)})
    files["data_dictionary.csv"] = _csv(dict_rows, ["group_id", "group_label", "repeatable", "field_id", "field_label", "type", "required",
                                                    "unit", "options", "references", "description", "instructions", "columns"])
    doc = {"format": "gatekeepr-extraction", "version": 1, "exported_at": now_iso(),
           "options": {"reviewed_only": reviewed_only, "include_ineligible": include_ineligible},
           "template_version": data["template"]["version"], "template": t, "papers": json_papers}
    files["extraction.json"] = json.dumps(doc, ensure_ascii=False, indent=2, default=str)
    files["template.json"] = json.dumps(t, ensure_ascii=False, indent=2)
    files["README.txt"] = README.format(
        version=data["template"]["version"], when=doc["exported_at"],
        scope="reviewer-confirmed values only" if reviewed_only else "all non-rejected values (see review_state)",
        papers="included and previously included papers" if include_ineligible else "papers currently marked Include",
        groups="\n".join(f"  {g['id']}.csv  ({g['label']}; one row per {g['record_label'] or 'record'})" for g in repeat) or "  (none)")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    return buf.getvalue()


def build_json(xsvc, reviewed_only: bool = False, include_ineligible: bool = False) -> str:
    with zipfile.ZipFile(io.BytesIO(build_zip(xsvc, reviewed_only, include_ineligible))) as z:
        return z.read("extraction.json").decode("utf-8")


README = """GateKeepr data extraction export
Template version: {version}
Exported: {when}
Values: {scope}
Papers: {papers}

study_level.csv      One row per paper. Single-group fields as <group>__<field>, with __status
                     (reported / not_reported / unclear / not_applicable) and, for numbers,
                     __unit and __context. n_<group> counts the records of each repeatable group.
Repeatable groups (one row per record, linked to papers by paper_id):
{groups}
                     Reference fields contain referenced record_id(s) (" | " separated) and
                     <field>__label the referenced records' labels.
values_long.csv      One row per extracted value with every attribute, including review state,
                     the original AI suggestion and values of fields no longer in the template
                     (in_template = no).
evidence.csv         Source passages for each value: exact PDF text, page, whether the passage
                     was verified in the PDF, and whether a numeric value occurs in the passage.
data_dictionary.csv  Field definitions and the columns they map to.
extraction.json      Complete hierarchical export (papers > groups > records > values > evidence).
template.json        The extraction template.

Empty cells mean that no value was recorded. A value marked not_reported means the reviewer (or
the AI, if not yet reviewed) found that the paper does not report it.
"""
