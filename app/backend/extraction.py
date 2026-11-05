"""AI-assisted full-text data extraction driven by a user-defined template.

Pipeline for one paper:
  1. Describe the template (groups, typed fields, options, units, relationships, instructions)
     and send it with the complete paper text ([[PAGE n]] markers). Long papers are processed
     in page-aligned chunks whose partial extractions are merged by a final call.
  2. Validate the model output against a template-agnostic Pydantic schema, then check every
     record and value against the template (unknown groups/fields are rejected, values are
     coerced to the field type, categorical values are matched to the allowed options).
  3. Verify every quotation against the PDF text with the same matcher used for screening
     evidence. Verified quotes keep the exact PDF text and word geometry; unverifiable quotes
     are kept *unverified* (never highlighted) so the uncertainty stays visible. For numbers,
     the value must also appear in its quoted passage, otherwise the link is flagged.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
import time
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from .ai.base import LLMProvider, ProviderError
from .analysis import page_chunks
from .extraction_templates import field_map, group_map
from .pdftext import DocIndex, document_text_with_markers, norm

log = logging.getLogger(__name__)

EXTRACTION_VERSION = "1"
VALUE_STATUSES = ("reported", "not_reported", "unclear", "not_applicable")


# ---------------------------------------------------------------- schema (template-agnostic)

class QuoteOut(BaseModel):
    quote: str = Field(description="Verbatim contiguous text copied exactly from the paper text (max ~60 words). No ellipses or paraphrase.")
    page: int = Field(description="Page number from the nearest preceding [[PAGE n]] marker.")


class ValueOut(BaseModel):
    field_id: str
    status: Literal["reported", "not_reported", "unclear", "not_applicable"]
    values: list[str] = Field(description="Extracted value(s) as strings; one entry per value. Empty unless status is reported or unclear.")
    unit: str = Field(description="Unit exactly as reported, or empty.")
    context: str = Field(description="Context needed to interpret the value: subgroup, dataset, model, metric, evaluation setting, table row/column, summary statistic. Empty if none.")
    quotes: list[QuoteOut] = Field(description="Passages that report this value. Required when status is reported or unclear.")
    note: str = Field(description="Brief note on ambiguity or why the value is unclear/not reported. Empty if none.")


class RecordOut(BaseModel):
    group_id: str
    record_key: str = Field(description="Short unique key for this record, e.g. datasets_1. Reference fields point to these keys.")
    label: str = Field(description="Human-readable name of the entity, e.g. the dataset or model name.")
    values: list[ValueOut]


class ExtractionOut(BaseModel):
    records: list[RecordOut]
    summary: str = Field(description="One or two sentences on what was extracted and anything notable.")


# ---------------------------------------------------------------- prompts

SYSTEM_PROMPT = """You are an expert research data extractor assisting a human reviewer with systematic-review data extraction from a full-text paper. Your output is a suggestion that the reviewer will verify.

Follow the extraction template exactly: its groups, fields, field types, allowed options, units, relationships and instructions. Do not add fields.

RECORDS
- A single (non-repeatable) group gets exactly one record whose record_key is the group id.
- A repeatable group gets one record per DISTINCT entity reported in the paper (e.g. each dataset, model, population, outcome or result). Never merge distinct entities into one record and never invent entities. If none are reported, return no records for that group.
- Reference fields link records: their values are record_key(s) of records in the target group (create those target records too).
- For every record, return an entry for EVERY field of its group.

VALUES AND STATUS
- reported: the paper explicitly reports the value. unclear: the paper mentions it but it is ambiguous, conflicting or only partially reported (explain in note). not_reported: the paper does not report it. not_applicable: the field does not apply to this study.
- NEVER fabricate, estimate, compute or infer values that are not explicitly reported. Do not convert units. Missing information is not_reported, not a guess.
- categorical: use the allowed option text exactly; if none fits and other values are allowed, give the paper's own wording.
- multi_categorical: one entry in values per applicable option.
- number / integer: the number exactly as written (no units, no thousands separators); put the unit in unit and qualifiers (SD, CI, range, mean vs median, subgroup, dataset, model, metric, split) in context.
- date: ISO format (YYYY, YYYY-MM or YYYY-MM-DD) when the paper gives one.
- boolean: "yes" or "no".

EVIDENCE
- Every reported or unclear value needs at least one quote copied VERBATIM from the paper text: one contiguous span exactly as it appears, with the page of the nearest preceding [[PAGE n]] marker. No paraphrase, no ellipses, no merged sentences. Quotes that cannot be found in the PDF are flagged as unverified.
- The quote must contain the value itself where possible. For numbers taken from tables, quote the table row that contains the number (row label through the value) and name the row and column headings in context.

Be precise and complete. Return only the JSON object."""


def describe_template(t: dict[str, Any]) -> str:
    lines = [f"TEMPLATE: {t['title']}"]
    if t.get("description"):
        lines.append(t["description"])
    if t.get("instructions"):
        lines.append(f"General instructions: {t['instructions']}")
    for g in t["groups"]:
        kind = (f"REPEATABLE — one record per distinct {g['record_label'] or 'entity'}; record keys like {g['id']}_1, {g['id']}_2"
                if g["repeatable"] else f"SINGLE — exactly one record with record_key \"{g['id']}\"")
        lines.append("")
        lines.append(f"GROUP {g['id']} — \"{g['label']}\" ({kind})")
        if g.get("description"):
            lines.append(f"  {g['description']}")
        if g.get("instructions"):
            lines.append(f"  Instructions: {g['instructions']}")
        lines.append("  Fields:")
        for f in g["fields"]:
            spec = f["type"]
            if f["type"] in ("categorical", "multi_categorical") and f["options"]:
                spec += "; options: " + " | ".join(f["options"])
                if f["allow_other"]:
                    spec += " (other values allowed)"
            if f["type"] == "reference":
                spec += f" → record_key(s) of group '{f['target_group']}'" + (" (one or more)" if f["multiple"] else " (one)")
            if f.get("unit"):
                spec += f"; expected unit: {f['unit']}"
            req = ", REQUIRED" if f["required"] else ""
            line = f"  - {f['id']} ({spec}{req}): {f['label']}"
            if f.get("description"):
                line += f" — {f['description']}"
            if f.get("instructions"):
                line += f" Instructions: {f['instructions']}"
            if f.get("examples"):
                line += f" Examples: {', '.join(f['examples'])}"
            lines.append(line)
    return "\n".join(lines)


def build_prompt(t: dict[str, Any], paper: dict[str, Any], body: str, part: tuple[int, int, int, int] | None = None) -> str:
    scope = ""
    if part:
        i, n, first, last = part
        scope = (f"\nNOTE: This is part {i} of {n} of the paper (pages {first}-{last}). Other pages are not shown. "
                 "Extract what these pages report; use not_reported where the information may be elsewhere.\n")
    return (
        "=== EXTRACTION TEMPLATE ===\n"
        f"{describe_template(t)}\n\n"
        f"=== PAPER {paper['paper_id']}: {paper.get('title') or ''} ===\n"
        "Text extracted from the full-text PDF. [[PAGE n]] markers give page numbers.\n"
        f"{scope}\n{body}\n\n"
        "=== TASK ===\nExtract the data defined by the template from this paper, following the system rules."
    )


def build_merge_prompt(t: dict[str, Any], paper: dict[str, Any], parts: list[dict[str, Any]]) -> str:
    return (
        "=== EXTRACTION TEMPLATE ===\n"
        f"{describe_template(t)}\n\n"
        f"=== PAPER {paper['paper_id']}: {paper.get('title') or ''} ===\n"
        "The paper was too long for one pass and was extracted in page-aligned parts. The partial extractions are below as JSON.\n\n"
        + "\n\n".join(f"--- Part {p['index']} (pages {p['first']}-{p['last']}) ---\n{json.dumps(p['out'], ensure_ascii=False)}" for p in parts)
        + "\n\n=== TASK ===\nMerge the parts into ONE extraction for the whole paper. Combine records that describe the same entity and keep "
        "distinct entities separate. For each field prefer an explicitly reported value over not_reported. Copy quotes exactly as they "
        "appear in the parts — do not write new quotes. Re-number record keys consistently and keep reference fields pointing to the right records."
    )


# ---------------------------------------------------------------- value coercion

_NUM_RE = re.compile(r"[-−–]?\d[\d,\s]*(?:\.\d+)?|[-−–]?\.\d+")


def _parse_number(s: str) -> float | None:
    s = s.strip().replace("−", "-").replace("–", "-")
    m = _NUM_RE.search(s)
    if not m:
        return None
    txt = re.sub(r"[,\s]", "", m.group(0)).replace("−", "-").replace("–", "-")
    try:
        return float(txt)
    except ValueError:
        return None


def _match_option(v: str, options: list[str]) -> str | None:
    key = norm(v)
    for o in options:
        if norm(o) == key:
            return o
    return None


def coerce_value(f: dict[str, Any], raw: list[str]) -> tuple[Any, list[str], str]:
    """Return (typed value, issues, unit_from_value)."""
    vals = [str(v).strip() for v in raw if str(v).strip()]
    issues: list[str] = []
    unit = ""
    if not vals:
        return None, issues, unit
    t = f["type"]
    if t in ("text", "long_text"):
        return "; ".join(vals), issues, unit
    if t in ("number", "integer"):
        if len(vals) > 1:
            issues.append("Several numbers were given; only the first was kept (see AI suggestion).")
        n = _parse_number(vals[0])
        if n is None:
            issues.append(f"'{vals[0]}' is not a number.")
            return vals[0], issues, unit
        if vals[0].strip().endswith("%"):
            unit = "%"
        if t == "integer":
            if n != int(n):
                issues.append(f"{vals[0]} is not a whole number.")
                return n, issues, unit
            return int(n), issues, unit
        return (int(n) if n == int(n) and "." not in vals[0] else n), issues, unit
    if t == "categorical":
        if len(vals) > 1:
            issues.append("Several categories were given for a single-choice field.")
        m = _match_option(vals[0], f["options"])
        if m:
            return m, issues, unit
        if not f["allow_other"]:
            issues.append(f"'{vals[0]}' is not one of the allowed options.")
        return vals[0], issues, unit
    if t == "multi_categorical":
        out = []
        for v in vals:
            m = _match_option(v, f["options"])
            if not m and not f["allow_other"]:
                issues.append(f"'{v}' is not one of the allowed options.")
            out.append(m or v)
        return list(dict.fromkeys(out)), issues, unit
    if t == "boolean":
        s = vals[0].lower()
        if s in {"yes", "y", "true", "1"}:
            return True, issues, unit
        if s in {"no", "n", "false", "0"}:
            return False, issues, unit
        issues.append(f"'{vals[0]}' is not yes/no.")
        return vals[0], issues, unit
    if t == "date":
        v = vals[0]
        if re.fullmatch(r"\d{4}(-\d{2}(-\d{2})?)?", v):
            try:
                if len(v) == 10:
                    date.fromisoformat(v)
                return v, issues, unit
            except ValueError:
                pass
        issues.append(f"'{v}' is not an ISO date (YYYY, YYYY-MM or YYYY-MM-DD).")
        return v, issues, unit
    if t == "reference":
        return vals if f["multiple"] else vals[:1], issues, unit  # record keys; resolved on persistence
    return "; ".join(vals), issues, unit


def value_in_passage(f: dict[str, Any], raw: list[str], quote: str) -> str:
    """'ok' | 'mismatch' | 'n/a' — does a numeric value literally occur in the quoted passage?"""
    if f["type"] not in ("number", "integer") or not raw:
        return "n/a"
    target = _parse_number(str(raw[0]))
    if target is None:
        return "n/a"
    # Compare whole numeric tokens (so "45" never matches inside "450"), tolerating ".954" vs
    # "0.954", thousands separators ("1,234"), decimal commas ("0,954") and unicode minus signs.
    text = unicodedata.normalize("NFKC", quote).replace("−", "-").replace("–", "-")
    for m in _TOKEN_RE.finditer(text):
        tok = m.group(0)
        for cand in {tok.replace(",", ""), tok.replace(",", ".") if re.fullmatch(r"-?\d+,\d+", tok) else None} - {None}:
            try:
                if abs(abs(float(cand)) - abs(target)) < 1e-9:
                    return "ok"
            except ValueError:
                continue
    return "mismatch"


_TOKEN_RE = re.compile(r"-?(?:\d[\d,]*(?:\.\d+)?|\.\d+)")


# ---------------------------------------------------------------- normalisation & verification

def normalise_output(out: ExtractionOut, t: dict[str, Any], idx: DocIndex) -> dict[str, Any]:
    groups = group_map(t)
    fields = field_map(t)
    records: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    stats = {"quotes_total": 0, "quotes_verified": 0, "quotes_unverified": 0, "value_mismatch": 0, "fields_missing": 0}
    seen_keys: set[str] = set()
    single_seen: set[str] = set()
    for rec in out.records:
        gid = rec.group_id.strip()
        g = groups.get(gid)
        if not g:
            rejected.append({"group_id": gid, "record_key": rec.record_key, "reason": "Unknown group"})
            continue
        if not g["repeatable"]:
            if gid in single_seen:
                rejected.append({"group_id": gid, "record_key": rec.record_key, "reason": "Extra record for a single group"})
                continue
            single_seen.add(gid)
        key = (rec.record_key or "").strip() or f"{gid}_{len(records) + 1}"
        while key in seen_keys:
            key += "_dup"
        seen_keys.add(key)
        values: dict[str, dict[str, Any]] = {}
        for v in rec.values:
            fid = v.field_id.strip()
            f = fields.get((gid, fid))
            if not f:
                rejected.append({"group_id": gid, "record_key": key, "field_id": fid, "reason": "Unknown field"})
                continue
            if fid in values:
                continue
            status = v.status
            raw = [s for s in v.values if str(s).strip()] if status in ("reported", "unclear") else []
            typed, issues, unit_from_value = coerce_value(f, raw)
            if status == "reported" and typed is None:
                status = "unclear"
                issues.append("Reported without a value; set to Unclear.")
            evidence = []
            for q in v.quotes:
                if not q.quote.strip():
                    continue
                stats["quotes_total"] += 1
                m = idx.locate(q.quote, page_hint=q.page)
                if m:
                    stats["quotes_verified"] += 1
                    check = value_in_passage(f, raw, m["text"])
                    if check == "mismatch":
                        stats["value_mismatch"] += 1
                    evidence.append({"verified": True, "quote": m["text"], "model_quote": q.quote, "page": m["page"],
                                     "rects": m["rects"], "match_method": m["method"], "match_score": m["score"],
                                     "value_check": check})
                else:
                    stats["quotes_unverified"] += 1
                    evidence.append({"verified": False, "quote": q.quote, "model_quote": q.quote, "page": q.page,
                                     "rects": [], "match_method": None, "match_score": None, "value_check": "n/a"})
            if status in ("reported", "unclear"):
                if not evidence:
                    issues.append("No source passage was cited.")
                elif not any(e["verified"] for e in evidence):
                    issues.append("The cited passage could not be found in the PDF (unverified).")
                elif any(e["value_check"] == "mismatch" for e in evidence if e["verified"]) and not any(
                        e["value_check"] == "ok" for e in evidence if e["verified"]):
                    issues.append("The value does not appear in its cited passage — check the evidence.")
            values[fid] = {
                "status": status,
                "value": typed if status in ("reported", "unclear") else None,
                "raw": raw,
                "unit": (v.unit.strip() or unit_from_value) if status in ("reported", "unclear") else "",
                "context": v.context.strip(),
                "note": v.note.strip(),
                "issues": issues,
                "evidence": evidence,
            }
        stats["fields_missing"] += sum(1 for f in g["fields"] if f["id"] not in values)
        label = rec.label.strip()
        if not label and g["repeatable"]:
            name_field = next((f["id"] for f in g["fields"] if f["type"] == "text"), None)
            label = str((values.get(name_field) or {}).get("value") or "") if name_field else ""
        records.append({"group_id": gid, "key": key, "label": label or (g["label"] if not g["repeatable"] else ""), "values": values})
    # reference integrity (resolved to record ids on persistence)
    keys_by_group: dict[str, set[str]] = {}
    for r in records:
        keys_by_group.setdefault(r["group_id"], set()).add(r["key"])
    for r in records:
        for fid, v in r["values"].items():
            f = fields[(r["group_id"], fid)]
            if f["type"] == "reference" and v["value"]:
                missing = [k for k in v["value"] if k not in keys_by_group.get(f["target_group"], set())]
                if missing:
                    v["issues"].append(f"References unknown {f['target_group']} record(s): {', '.join(missing)}.")
    return {"records": records, "rejected": rejected, "stats": stats}


def _call(provider: LLMProvider, prompt: str) -> tuple[ExtractionOut, dict]:
    data = provider.generate_json(system=SYSTEM_PROMPT, prompt=prompt, schema=ExtractionOut, max_output_tokens=65536)
    usage = data.pop("_usage", {}) or {}
    try:
        return ExtractionOut.model_validate(data), usage
    except ValidationError as e:
        raise ProviderError(f"Model output failed schema validation: {e.errors()[:3]}") from e


def extract_document(provider: LLMProvider, t: dict[str, Any], paper: dict[str, Any], pages: list[dict[str, Any]],
                     idx: DocIndex, max_single_pass_chars: int, chunk_chars: int, progress=lambda s: None) -> dict[str, Any]:
    t0 = time.time()
    full = document_text_with_markers(pages)
    usage: dict[str, int] = {}

    def add(u: dict):
        for k, v in u.items():
            if isinstance(v, int):
                usage[k] = usage.get(k, 0) + v

    if len(full) <= max_single_pass_chars:
        progress("Extracting from full text")
        out, u = _call(provider, build_prompt(t, paper, full))
        add(u)
        n_chunks = 1
    else:
        ranges = page_chunks(pages, chunk_chars)
        n_chunks = len(ranges)
        parts = []
        for i, (first, last) in enumerate(ranges, 1):
            progress(f"Extracting part {i}/{n_chunks} (pages {first}-{last})")
            o, u = _call(provider, build_prompt(t, paper, document_text_with_markers(pages, first, last), (i, n_chunks, first, last)))
            add(u)
            parts.append({"index": i, "first": first, "last": last, "out": o.model_dump()})
        progress("Merging parts")
        out, u = _call(provider, build_merge_prompt(t, paper, parts))
        add(u)
    progress("Verifying evidence")
    result = normalise_output(out, t, idx)
    result["summary"] = out.summary
    result["stats"].update({"extraction_version": EXTRACTION_VERSION, "chunks": n_chunks, "chars": len(full),
                            "records": len(result["records"]), "duration_s": round(time.time() - t0, 1), "usage": usage})
    return result
