"""Load eligibility criteria from a portable JSON file or a legacy table-based PDF.

JSON is the public, review-agnostic format. The PDF parser is retained for compatibility with
the original project and expects tables headed ``Code`` with IDs prefixed by I and E.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

import pymupdf

CODE_RE = re.compile(r"^[A-Z]\d{1,2}[A-Z]?$")


def _nfkc(s: str) -> str:
    return re.sub(r"[ \t]+", " ", unicodedata.normalize("NFKC", s)).strip()


def _lines(page: pymupdf.Page) -> list[dict[str, Any]]:
    groups: dict[tuple[int, int], list] = {}
    for w in page.get_text("words"):
        groups.setdefault((w[5], w[6]), []).append(w)
    out = []
    for ws in groups.values():
        ws.sort(key=lambda w: w[0])
        out.append({"y0": min(w[1] for w in ws), "y1": max(w[3] for w in ws), "x0": ws[0][0], "words": ws})
    out.sort(key=lambda l: (round(l["y0"], 1), l["x0"]))
    return out


def _parse_tables(page: pymupdf.Page) -> list[dict[str, str]]:
    lines = _lines(page)
    header = next((l for l in lines if l["words"][0][4] == "Code"), None)
    if not header:
        return []
    hy0, hy1 = header["y0"] - 2, header["y1"] + 2
    head_words = sorted((w for l in lines if l["y0"] >= hy0 and l["y1"] <= hy1 for w in l["words"]), key=lambda w: w[0])
    # Column starts: "Code", then the start of each following header phrase (gap > 15pt).
    starts = [head_words[0][0]]
    for prev, w in zip(head_words, head_words[1:]):
        if w[0] - prev[2] > 15:
            starts.append(w[0])
    if len(starts) < 3:
        return []
    c2, c3 = starts[1] - 4, starts[2] - 4
    body = [l for l in lines if l["y0"] > hy1]
    # Cluster lines into table rows by vertical gaps.
    clusters: list[list[dict]] = []
    last_y1 = None
    for l in body:
        if last_y1 is None or l["y0"] - last_y1 > 4.5:
            clusters.append([l])
            last_y1 = l["y1"]
        else:
            clusters[-1].append(l)
            last_y1 = max(last_y1, l["y1"])
    rows = []
    for cl in clusters:
        words = [w for l in cl for w in l["words"]]
        col1 = [w for w in words if w[0] < c2]
        if not col1 or not CODE_RE.match(col1[0][4]):
            break  # end of table
        def col_text(ws):
            ws = sorted(ws, key=lambda w: (round(w[1]), w[0]))
            text, prev_y = "", None
            for w in ws:
                sep = "" if not text else (" " if prev_y is None or abs(w[1] - prev_y) < 2 else "\n")
                text += sep + w[4]
                prev_y = w[1]
            # a hyphen at a line break inside the criteria tables belongs to a compound word
            return _nfkc(re.sub(r"(\w)-\n(?=[a-z])", r"\1-", text).replace("\n", " "))
        rows.append({
            "code": col1[0][4],
            "name": col_text([w for w in words if c2 <= w[0] < c3]),
            "definition": col_text([w for w in words if w[0] >= c3]),
        })
    return rows


def _between(text: str, start: str, end: str) -> str | None:
    m = re.search(re.escape(start) + r"\s*(.*?)\s*" + end, text, re.S)
    return _nfkc(re.sub(r"(\w)-\s*\n(?=[a-z])", r"\1-", m.group(1)).replace("\n", " ")) if m else None


def _sub_requirements(code: str, definition: str) -> list[dict[str, str]]:
    """Split enumerations explicitly written in the definition."""
    routes = re.findall(rf"\b({code}[A-Z]):\s*(.*?)(?=\s*\b{code}[A-Z]:|$)", definition)
    if len(routes) >= 2:
        return [{"id": rid, "text": t.strip().rstrip(";").strip(), "kind": "route"} for rid, t in routes]
    parts = re.split(r"\((\d)\)", definition)
    if len(parts) >= 5:  # prefix, n, text, n, text, ...
        items = []
        nums = parts[1::2]
        texts = parts[2::2]
        for i, (n, t) in enumerate(zip(nums, texts)):
            t = t.strip()
            if i == len(texts) - 1:
                m = re.match(r"(.+?\.)\s+[A-Z]", t)
                t = m.group(1) if m else t
            t = re.sub(r"[;,]?\s*(and|or)?\s*$", "", t).strip().rstrip(";").strip()
            items.append({"id": f"{code}.{n}", "text": t, "kind": "all_required"})
        return items
    return []


def _parse_criteria_pdf(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    doc = pymupdf.open(stream=raw, filetype="pdf")
    try:
        page_texts = [unicodedata.normalize("NFKC", p.get_text()) for p in doc]
        rows = [r for p in doc for r in _parse_tables(p)]
    finally:
        doc.close()
    full = "\n\n".join(f"[[CRITERIA PAGE {i + 1}]]\n{t.strip()}" for i, t in enumerate(page_texts))
    joined = "\n".join(page_texts)

    inclusion, exclusion = [], []
    for r in rows:
        item = {"id": r["code"], "name": r["name"], "definition": r["definition"]}
        if r["code"].startswith("I"):
            subs = _sub_requirements(r["code"], r["definition"])
            if subs:
                item["sub_requirements"] = subs
            inclusion.append(item)
        elif r["code"].startswith("E"):
            exclusion.append(item)

    # Preserve the legacy review's same-number I/E relationships as explicit metadata.
    inc_by_number = {re.sub(r"\D", "", item["id"]): item for item in inclusion}
    exc_by_number = {re.sub(r"\D", "", item["id"]): item for item in exclusion}
    for number, item in inc_by_number.items():
        if number in exc_by_number:
            item["exclusion_code"] = exc_by_number[number]["id"]
            exc_by_number[number]["paired_inclusion"] = item["id"]

    unretrieved = []
    for m in re.finditer(r"\b(U\d)\s*[•·–—-]?\s*(.+?)\s{2,}(.+?)(?=\n\s*\n|\nDo not exclude|\Z)", joined, re.S):
        unretrieved.append({"id": m.group(1), "name": _nfkc(m.group(2)), "definition": _nfkc(m.group(3).replace("\n", " "))})

    title_lines = [l.strip() for l in page_texts[0].splitlines() if l.strip()] if page_texts else []
    result = {
        "source_file": path.name,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "title": " — ".join(title_lines[2:4]) if len(title_lines) >= 4 else path.stem,
        "core_rule": _between(joined, "Core rule", r"\n\s*Inclusion criteria"),
        "inclusion_rule": _between(joined, "Inclusion criteria", r"\n\s*Code\b"),
        "exclusion_rule": _between(joined, "Exclusion criteria", r"\n\s*Code\b"),
        "do_not_exclude": _between(joined, "Do not exclude solely because", r"\n\s*\n|\Z"),
        "if_uncertain": _between(joined, "If uncertain:", r"\Z"),
        "inclusion": inclusion,
        "exclusion": exclusion,
        "unretrieved": unretrieved,
        "page_count": len(page_texts),
        "full_text": full,
    }
    if result["do_not_exclude"]:
        result["do_not_exclude"] = "Do not exclude solely because… " + result["do_not_exclude"].lstrip(".… ")
    result["content_hash"] = hashlib.sha256(json.dumps(
        {k: v for k, v in result.items() if k != "content_hash"}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    result["ok"] = bool(inclusion and exclusion)
    return result


def _criterion_from_json(raw: Any, kind: str, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"{kind}[{index}] must be an object")
    cid = str(raw.get("id") or "").strip().upper()
    name = str(raw.get("name") or "").strip()
    definition = str(raw.get("definition") or "").strip()
    if not cid or not name or not definition:
        raise ValueError(f"{kind}[{index}] requires non-empty id, name, and definition")
    item: dict[str, Any] = {"id": cid, "name": name, "definition": definition}
    if raw.get("allow_not_applicable") is not None:
        item["allow_not_applicable"] = bool(raw["allow_not_applicable"])
    if kind == "inclusion" and raw.get("exclusion_code"):
        item["exclusion_code"] = str(raw["exclusion_code"]).strip().upper()
    if kind == "exclusion":
        if raw.get("advisory") is not None:
            item["advisory"] = bool(raw["advisory"])
        if raw.get("paired_inclusion"):
            item["paired_inclusion"] = str(raw["paired_inclusion"]).strip().upper()

    subs = raw.get("sub_requirements") or []
    if not isinstance(subs, list):
        raise ValueError(f"{cid}.sub_requirements must be an array")
    parsed_subs = []
    for sub_index, sub in enumerate(subs):
        if not isinstance(sub, dict):
            raise ValueError(f"{cid}.sub_requirements[{sub_index}] must be an object")
        sid = str(sub.get("id") or "").strip().upper()
        text = str(sub.get("text") or "").strip()
        sub_kind = str(sub.get("kind") or "all_required").strip().lower()
        if not sid or not text:
            raise ValueError(f"{cid}.sub_requirements[{sub_index}] requires id and text")
        if sub_kind not in {"all_required", "route"}:
            raise ValueError(f"{sid}.kind must be 'all_required' or 'route'")
        parsed_subs.append({"id": sid, "text": text, "kind": sub_kind})
    if parsed_subs:
        if len({sub["kind"] for sub in parsed_subs}) != 1:
            raise ValueError(f"All sub-requirements under {cid} must use the same kind")
        item["sub_requirements"] = parsed_subs
    return item


def _render_full_text(data: dict[str, Any]) -> str:
    lines = [data["title"]]
    for key, heading in (
        ("core_rule", "Core rule"),
        ("inclusion_rule", "Inclusion rule"),
        ("exclusion_rule", "Exclusion rule"),
        ("do_not_exclude", "Additional exclusion guidance"),
        ("if_uncertain", "If uncertain"),
        ("guidance", "Additional guidance"),
    ):
        if data.get(key):
            lines.extend(("", f"{heading}:", str(data[key])))
    for kind, heading in (("inclusion", "Inclusion criteria"), ("exclusion", "Exclusion criteria")):
        lines.extend(("", heading + ":"))
        for criterion in data[kind]:
            lines.append(f"{criterion['id']} — {criterion['name']}: {criterion['definition']}")
            for sub in criterion.get("sub_requirements", []):
                label = "alternative route" if sub["kind"] == "route" else "required part"
                lines.append(f"  {sub['id']} ({label}): {sub['text']}")
    return "\n".join(lines).strip()


def _parse_criteria_json(path: Path) -> dict[str, Any]:
    raw_bytes = path.read_bytes()
    try:
        payload = json.loads(raw_bytes.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid UTF-8 JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("Criteria JSON must contain one object")
    version = payload.get("schema_version", 1)
    if version != 1:
        raise ValueError(f"Unsupported criteria schema_version: {version!r}")

    inclusion_raw = payload.get("inclusion")
    exclusion_raw = payload.get("exclusion")
    if not isinstance(inclusion_raw, list) or not isinstance(exclusion_raw, list):
        raise ValueError("Criteria JSON requires inclusion and exclusion arrays")
    inclusion = [_criterion_from_json(item, "inclusion", i) for i, item in enumerate(inclusion_raw)]
    exclusion = [_criterion_from_json(item, "exclusion", i) for i, item in enumerate(exclusion_raw)]
    if not inclusion or not exclusion:
        raise ValueError("Criteria JSON requires at least one inclusion and one exclusion criterion")

    ids = [c["id"] for c in inclusion + exclusion]
    ids.extend(sub["id"] for c in inclusion + exclusion for sub in c.get("sub_requirements", []))
    duplicates = sorted({cid for cid in ids if ids.count(cid) > 1})
    if duplicates:
        raise ValueError("Criterion IDs must be unique; duplicates: " + ", ".join(duplicates))
    inclusion_ids = {item["id"] for item in inclusion}
    exclusion_ids = {item["id"] for item in exclusion}
    for item in inclusion:
        if item.get("exclusion_code") and item["exclusion_code"] not in exclusion_ids:
            raise ValueError(f"{item['id']}.exclusion_code refers to unknown ID {item['exclusion_code']}")
    for item in exclusion:
        if item.get("paired_inclusion") and item["paired_inclusion"] not in inclusion_ids:
            raise ValueError(f"{item['id']}.paired_inclusion refers to unknown ID {item['paired_inclusion']}")

    unretrieved = []
    for i, item in enumerate(payload.get("unretrieved") or []):
        if not isinstance(item, dict) or not item.get("id"):
            raise ValueError(f"unretrieved[{i}] requires at least an id")
        unretrieved.append({
            "id": str(item["id"]).strip().upper(),
            "name": str(item.get("name") or "Not retrieved").strip(),
            "definition": str(item.get("definition") or "Full text could not be obtained.").strip(),
        })

    result: dict[str, Any] = {
        "schema_version": 1,
        "source_file": path.name,
        "source_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "title": str(payload.get("title") or path.stem).strip(),
        "core_rule": str(payload.get("core_rule") or "").strip() or None,
        "inclusion_rule": str(payload.get("inclusion_rule") or "").strip() or None,
        "exclusion_rule": str(payload.get("exclusion_rule") or "").strip() or None,
        "do_not_exclude": str(payload.get("do_not_exclude") or "").strip() or None,
        "if_uncertain": str(payload.get("if_uncertain") or "").strip() or None,
        "guidance": str(payload.get("guidance") or "").strip() or None,
        "inclusion": inclusion,
        "exclusion": exclusion,
        "unretrieved": unretrieved,
        "page_count": None,
    }
    result["full_text"] = str(payload.get("full_text") or "").strip() or _render_full_text(result)
    result["content_hash"] = hashlib.sha256(json.dumps(
        {k: v for k, v in result.items() if k != "content_hash"},
        sort_keys=True,
        ensure_ascii=False,
    ).encode()).hexdigest()
    result["ok"] = True
    return result


def parse_criteria(path: Path) -> dict[str, Any]:
    """Parse a versioned JSON criteria file or a compatible PDF criteria table."""
    suffix = path.suffix.lower()
    if suffix == ".json":
        return _parse_criteria_json(path)
    if suffix == ".pdf":
        return _parse_criteria_pdf(path)
    raise ValueError("Criteria source must be a .json or .pdf file")


def criterion_ids(criteria: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """All assessable IDs (criteria and their sub-requirements) -> descriptor."""
    out: dict[str, dict[str, Any]] = {}
    for kind in ("inclusion", "exclusion"):
        for c in criteria.get(kind, []):
            out[c["id"]] = {
                "kind": kind,
                "name": c["name"],
                "definition": c["definition"],
                "parent": None,
                "allow_not_applicable": bool(c.get("allow_not_applicable")),
                "advisory": bool(c.get("advisory")),
            }
            for s in c.get("sub_requirements", []):
                out[s["id"]] = {"kind": kind, "name": s["text"], "definition": s["text"], "parent": c["id"], "sub_kind": s["kind"]}
    return out
