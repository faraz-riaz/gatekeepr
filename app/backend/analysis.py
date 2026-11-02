"""AI-assisted full-text eligibility analysis.

Pipeline for one paper:
  1. Build a prompt with the verbatim criteria document, the list of criterion IDs to assess
     (parsed from that document), and the complete extracted paper text with [[PAGE n]] markers.
     Long documents are split into page-aligned chunks and the results synthesised.
  2. Validate the model's JSON against a Pydantic schema.
  3. Verify every quotation against the PDF text (pdftext.DocIndex.locate). Unverifiable
     quotations are rejected and recorded; accepted evidence stores the exact PDF text and the
     word geometry used for highlighting.
  4. Apply evidence rules to the statuses (e.g. "Met" requires a verified supporting quote;
     "Not met" requires verified contradicting evidence — absence of evidence stays "Unclear"),
     derive compound criteria from their parts, and compute the recommendation with
     deterministic rules. The model's own suggestion is stored alongside for transparency.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from .ai.base import LLMProvider, ProviderError
from .criteria import criterion_ids
from .pdftext import DocIndex, document_text_with_markers, norm

log = logging.getLogger(__name__)

ANALYSIS_VERSION = "2"

INCLUSION_STATUSES = {"met", "not_met", "unclear", "not_applicable"}
EXCLUSION_STATUSES = {"triggered", "not_triggered", "not_found", "unclear"}


# ---------------------------------------------------------------- schema

class EvidenceOut(BaseModel):
    criterion_id: str = Field(description="Exact ID of the criterion or sub-requirement this passage bears on.")
    stance: Literal["supports", "contradicts", "ambiguous"] = Field(
        description="supports: shows an inclusion criterion is satisfied, or that an exclusion criterion applies. "
                    "contradicts: shows an inclusion criterion is NOT satisfied, or that an exclusion criterion does NOT apply. "
                    "ambiguous: relevant but does not settle the criterion.")
    page: int = Field(description="Page number from the nearest preceding [[PAGE n]] marker.")
    quote: str = Field(description="Verbatim contiguous text copied exactly from the paper text (1-3 sentences, at most ~60 words). No ellipses, no paraphrasing.")
    explanation: str = Field(description="One sentence: why this passage is relevant to the criterion.")


class AssessmentOut(BaseModel):
    criterion_id: str
    status: Literal["met", "not_met", "unclear", "not_applicable", "triggered", "not_triggered", "not_found"]
    justification: str = Field(description="At most two sentences.")


class CharacteristicOut(BaseModel):
    label: str = Field(description="Short label for a study characteristic relevant to the eligibility decision.")
    value: str = Field(description="Concise value grounded in the paper, or 'not reported'.")


class AnalysisOut(BaseModel):
    study_summary: str = Field(description="One or two sentences describing the paper and study.")
    assessments: list[AssessmentOut]
    evidence: list[EvidenceOut]
    study_characteristics: list[CharacteristicOut] = Field(
        default_factory=list,
        description="Up to eight concise study characteristics that are material to the supplied criteria.",
    )
    suggested_decision: Literal["include", "exclude", "maybe"]
    suggested_code: str = Field(description="Primary criterion ID for exclude, or unresolved criterion ID(s) for maybe; blank is allowed for include.")
    rationale: str = Field(description="Two or three sentences explaining the suggested decision with reference to criterion IDs.")


# ---------------------------------------------------------------- prompts

SYSTEM_PROMPT = """You are an expert evidence-synthesis methodologist assisting a human reviewer with FULL-TEXT eligibility screening for a literature review. Your output is advisory; the human makes the decision.

Apply ONLY the eligibility criteria in the criteria document provided, exactly as written, including its guidance, examples and "do not exclude solely because" rules. Do not add, relax or invent criteria.

EVIDENCE RULES
1. Every quote must be copied verbatim from the PAPER TEXT: one contiguous span, exactly as it appears (same words, numbers and symbols). Never paraphrase, summarise, correct, translate, merge text from different places, or use ellipses. 1-3 sentences, at most ~60 words. Give the page number of the nearest preceding [[PAGE n]] marker. Quotes that cannot be found verbatim in the PDF are automatically discarded.
2. Prefer decisive passages from methods, experiments and results; use the abstract or introduction only as supporting context. Do not quote the reference list.
3. Provide up to 4 of the most decisive passages per criterion. A passage may be cited for several criteria (repeat it with a different criterion_id).

STATUS RULES
- Criteria listed under INCLUSION and their sub-requirements:
  met = the full text positively establishes it (cite supporting quotes);
  not_met = the full text positively shows it is NOT satisfied (cite contradicting quotes);
  unclear = the information is missing, ambiguous or conflicting. ABSENCE OF INFORMATION IS "unclear", NEVER "not_met".
  not_applicable = only when the supplied criterion explicitly allows it or for an alternative route that does not apply.
- Criteria listed under EXCLUSION:
  triggered = the full text positively shows the exclusion applies (cite quotes);
  not_triggered = the full text positively shows it does not apply (cite a quote, or rely on the evidence cited for the corresponding inclusion criterion);
  not_found = no information either way; unclear = ambiguous.
- A keyword match or label alone is not evidence of eligibility. Apply the complete definition supplied for each criterion.
- Do not infer facts that are not stated in the paper. Record material, review-specific study characteristics when useful.

DECISION RULES
- include: every inclusion criterion is met (all parts of compound requirements, and one applicable route where routes are offered) and no exclusion criterion is triggered.
- exclude: an exclusion criterion is clearly triggered, or an inclusion criterion is clearly not met. Give ONE primary exclusion code: the first applicable code in the document's order.
- maybe (= DISCUSS): essential information is missing, ambiguous or conflicting; name the ambiguous criterion.

Be concise and precise. Return only the JSON object."""


def _criteria_listing(criteria: dict[str, Any]) -> str:
    lines = []
    for kind, label in (("inclusion", "INCLUSION"), ("exclusion", "EXCLUSION")):
        lines.append(f"{label} CRITERIA:")
        for c in criteria[kind]:
            flags = []
            if c.get("allow_not_applicable"):
                flags.append("not_applicable allowed")
            if c.get("advisory"):
                flags.append("reviewer judgement; do not auto-exclude")
            suffix = f" [{'; '.join(flags)}]" if flags else ""
            lines.append(f"- {c['id']}: {c['name']} — {c['definition']}{suffix}")
            for s in c.get("sub_requirements", []):
                tag = "route (alternative)" if s["kind"] == "route" else "required part"
                lines.append(f"    - {s['id']} [{tag}]: {s['text']}")
    return "\n".join(lines)


def _all_ids(criteria: dict[str, Any]) -> list[str]:
    out = []
    for kind in ("inclusion", "exclusion"):
        for c in criteria[kind]:
            out.append(c["id"])
            out.extend(s["id"] for s in c.get("sub_requirements", []))
    return out


def build_prompt(criteria: dict[str, Any], paper: dict[str, Any], body: str, part: tuple[int, int, int, int] | None = None) -> str:
    scope = ""
    if part:
        i, n, first, last = part
        scope = (f"\nNOTE: This is part {i} of {n} of the paper (pages {first}-{last}). Other pages are not shown. "
                 "Base statuses only on what is shown here; use unclear / not_found where the information may be elsewhere.\n")
    return (
        "=== ELIGIBILITY CRITERIA DOCUMENT (verbatim text) ===\n"
        f"{criteria['full_text']}\n\n"
        "=== CRITERION IDS TO ASSESS (parsed from the document above) ===\n"
        f"{_criteria_listing(criteria)}\n\n"
        f"Assess every one of these IDs in `assessments`: {', '.join(_all_ids(criteria))}\n\n"
        f"=== PAPER {paper['paper_id']}: {paper.get('title') or ''} ===\n"
        "Text extracted from the full-text PDF. [[PAGE n]] markers give page numbers.\n"
        f"{scope}\n{body}\n\n"
        "=== TASK ===\nAssess the paper against every criterion ID, cite verbatim evidence, record up to eight "
        "study characteristics that matter to these criteria, and suggest a decision following the system rules."
    )


def build_synthesis_prompt(criteria: dict[str, Any], paper: dict[str, Any], parts: list[dict[str, Any]], evidence: list[dict[str, Any]], abstract: str) -> str:
    ev_lines = [f"[{e['criterion_id']} | {e['stance']} | p.{e['page']}] \"{e['quote']}\" — {e['explanation']}" for e in evidence]
    part_lines = []
    for p in parts:
        part_lines.append(f"--- Part {p['index']} (pages {p['first']}-{p['last']}) ---")
        part_lines.append(f"Summary: {p['out'].study_summary}")
        for a in p["out"].assessments:
            part_lines.append(f"{a.criterion_id}: {a.status} — {a.justification}")
    return (
        "=== ELIGIBILITY CRITERIA DOCUMENT (verbatim text) ===\n"
        f"{criteria['full_text']}\n\n"
        "=== CRITERION IDS TO ASSESS ===\n"
        f"{_criteria_listing(criteria)}\n\n"
        f"=== PAPER {paper['paper_id']}: {paper.get('title') or ''} ===\n"
        "The paper was too long for one pass and was assessed in page-aligned parts. Below are the opening pages, "
        "the per-part assessments, and all evidence quotations that were VERIFIED against the PDF.\n\n"
        f"OPENING PAGES:\n{abstract}\n\nPER-PART ASSESSMENTS:\n" + "\n".join(part_lines) +
        "\n\nVERIFIED EVIDENCE:\n" + ("\n".join(ev_lines) or "(none)") +
        "\n\n=== TASK ===\nCombine the parts into one final assessment of the WHOLE paper. A criterion established in any part "
        "counts as established. Return final `assessments` for every ID, material study characteristics, decision and rationale. "
        "In `evidence`, include only additional verbatim quotes from the text shown above if essential (otherwise return an empty list)."
    )


# ---------------------------------------------------------------- chunking

def page_chunks(pages: list[dict[str, Any]], max_chars: int) -> list[tuple[int, int]]:
    """Page ranges (1-based, inclusive) of at most ~max_chars each, overlapping by one page."""
    sizes = [sum(len(w[4]) + 1 for w in p["words"]) for p in pages]
    chunks, start = [], 0
    while start < len(pages):
        total, end = 0, start
        while end < len(pages) and (total + sizes[end] <= max_chars or end == start):
            total += sizes[end]
            end += 1
        chunks.append((start + 1, end))
        if end >= len(pages):
            break
        start = max(end - 1, start + 1)  # one page overlap so passages spanning a page break are not lost
    return chunks


# ---------------------------------------------------------------- verification & rules

def _norm_id(cid: str) -> str:
    cid = (cid or "").strip().upper().replace(" ", "")
    m = re.match(r"^([A-Z]\d+)\((\d)\)$", cid)  # "I5(2)" -> "I5.2"
    if m:
        cid = f"{m.group(1)}.{m.group(2)}"
    return cid


def polarity_for(kind: str, stance: str) -> str:
    if stance == "ambiguous":
        return "uncertain"
    if kind == "inclusion":
        return "include" if stance == "supports" else "exclude"
    return "exclude" if stance == "supports" else "include"


def verify_evidence(raw: list[EvidenceOut], idx: DocIndex, ids: dict[str, dict[str, Any]]) -> tuple[list[dict], list[dict]]:
    accepted: list[dict] = []
    rejected: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for ev in raw:
        cid = _norm_id(ev.criterion_id)
        base = {"criterion_id": cid, "stance": ev.stance, "page": ev.page, "quote": ev.quote, "explanation": ev.explanation}
        if cid not in ids:
            rejected.append({**base, "reason": "Unknown criterion ID"})
            continue
        m = idx.locate(ev.quote, page_hint=ev.page)
        if not m:
            rejected.append({**base, "reason": "Quotation not found in the PDF text"})
            continue
        key = (cid, norm(m["text"]))
        if key in seen:
            continue
        seen.add(key)
        accepted.append({
            "criterion_id": cid,
            "stance": ev.stance,
            "polarity": polarity_for(ids[cid]["kind"], ev.stance),
            "quote": m["text"],
            "model_quote": ev.quote,
            "model_page": ev.page,
            "page": m["page"],
            "rects": m["rects"],
            "explanation": ev.explanation.strip(),
            "match_method": m["method"],
            "match_score": m["score"],
        })
    return accepted, rejected


def _is_scope_limited(definition: str) -> bool:
    # Criteria whose own text begins by limiting the population or situation to which they apply.
    return bool(re.match(r"^\s*For\s+[^,]{3,120},", definition or ""))


def _is_advisory_exclusion(definition: str) -> bool:
    # Exclusions that, per the document, require reviewer action rather than a definitive automated call
    d = (definition or "").lower()
    return "clarification attempts" in d or "refer the case" in d


def apply_rules(out: AnalysisOut, evidence: list[dict], criteria: dict[str, Any]) -> dict[str, dict[str, Any]]:
    ids = criterion_ids(criteria)
    model = {_norm_id(a.criterion_id): a for a in out.assessments}
    by_cid: dict[str, list[dict]] = {}
    for e in evidence:
        by_cid.setdefault(e["criterion_id"], []).append(e)

    def has(cid: str, stance: str, include_children: bool = True) -> bool:
        cids = [cid] + ([k for k, v in ids.items() if v["parent"] == cid] if include_children else [])
        return any(e["stance"] == stance for c in cids for e in by_cid.get(c, []))

    result: dict[str, dict[str, Any]] = {}
    for cid, info in ids.items():
        a = model.get(cid)
        kind = info["kind"]
        valid = INCLUSION_STATUSES if kind == "inclusion" else EXCLUSION_STATUSES
        default = "unclear" if kind == "inclusion" else "not_found"
        status = a.status if a else default
        notes: list[str] = []
        if not a:
            notes.append("Not assessed by the model.")
        elif status not in valid:
            notes.append(f"Model returned an invalid status ('{status}') for this criterion type.")
            status = "unclear"
        downgrade = None
        if kind == "inclusion":
            if status == "met" and not has(cid, "supports"):
                downgrade = "Downgraded from Met: no verified supporting quotation."
            elif status == "not_met" and not has(cid, "contradicts"):
                downgrade = ("Downgraded from Not met: no verified contradicting quotation "
                             "(absence of evidence is not treated as Not met).")
            elif status == "not_applicable":
                allowed = (
                    info.get("allow_not_applicable")
                    or (info["parent"] is None and _is_scope_limited(info["definition"]))
                    or info.get("sub_kind") == "route"
                )
                if not allowed:
                    downgrade = "'Not applicable' is not permitted for this criterion; set to Unclear."
        elif status == "triggered" and not has(cid, "supports"):
            downgrade = "Downgraded from Triggered: no verified supporting quotation."
        if downgrade:
            status = "unclear"
            notes.append(downgrade)
        result[cid] = {
            "status": status,
            "model_status": a.status if a else None,
            "justification": (a.justification.strip() if a else ""),
            "notes": notes,
        }

    # Compound inclusion criteria are derived from the parts enumerated in the criteria document.
    for c in criteria["inclusion"]:
        subs = c.get("sub_requirements") or []
        if not subs:
            continue
        sts = [result[s["id"]]["status"] for s in subs]
        r = result[c["id"]]
        if subs[0]["kind"] == "all_required":
            derived = "met" if all(s == "met" for s in sts) else "not_met" if "not_met" in sts else "unclear"
        else:  # alternative routes: one must be met
            if "met" in sts:
                derived = "met"
                r["route"] = next(s["id"] for s, st in zip(subs, sts) if st == "met")
            elif all(s in ("not_met", "not_applicable") for s in sts) and "not_met" in sts:
                derived = "not_met"
            else:
                derived = "unclear"
        if derived != r["status"]:
            r["notes"].append(f"Status derived from its parts ({', '.join(s['id'] + '=' + st for s, st in zip(subs, sts))}).")
        r["status"] = derived

    # "Not triggered" (confirmed absent) needs positive evidence; otherwise it is "not found".
    for c in criteria["exclusion"]:
        r = result[c["id"]]
        if r["status"] != "not_triggered":
            continue
        partner = c.get("paired_inclusion")
        partner_ok = partner and result[partner]["status"] in ("met", "not_applicable") and (
            result[partner]["status"] == "not_applicable" or has(partner, "supports"))
        if not (has(c["id"], "contradicts") or partner_ok):
            r["status"] = "not_found"
            r["notes"].append("No verified evidence that this exclusion is absent; reported as Not found.")
    return result


def recommend(statuses: dict[str, dict[str, Any]], criteria: dict[str, Any], model_decision: str | None = None,
              model_code: str | None = None) -> dict[str, Any]:
    inc, exc = criteria["inclusion"], criteria["exclusion"]
    names = {c["id"]: c["name"] for c in inc + exc}

    def label(cid: str) -> str:
        return f"{cid} ({names.get(cid, cid)})"

    def why(cid: str) -> str:
        j = statuses[cid].get("justification") or ""
        return f": {j}" if j else ""

    triggered = [c for c in exc if statuses[c["id"]]["status"] == "triggered"]
    definitive = [c for c in triggered if not (c.get("advisory") or _is_advisory_exclusion(c["definition"]))]
    advisory = [c for c in triggered if c.get("advisory") or _is_advisory_exclusion(c["definition"])]
    violated = [c for c in inc if statuses[c["id"]]["status"] == "not_met"]
    satisfied = [c for c in inc if statuses[c["id"]]["status"] in ("met", "not_applicable")]
    unresolved = [c for c in inc if c not in satisfied and c not in violated]

    if definitive:
        first = definitive[0]["id"]
        decision, code = "exclude", first
        text = f"{label(first)} is triggered{why(first)}"
    elif violated:
        first = violated[0]["id"]
        code = violated[0].get("exclusion_code") or first
        decision = "exclude"
        text = f"{label(first)} is clearly not met{why(first)}"
    elif not unresolved and not advisory:
        route = next((statuses[c["id"]].get("route") for c in inc if statuses[c["id"]].get("route")), None)
        decision, code = "include", route or ""
        text = (f"All {len(inc)} inclusion criteria are satisfied" + (f" (route {route})" if route else "") +
                " and no exclusion criterion is triggered.")
    else:
        decision = "maybe"
        code = ", ".join(c["id"] for c in unresolved + advisory)
        parts = []
        if unresolved:
            parts.append(f"{len(satisfied)} of {len(inc)} inclusion criteria are satisfied; unresolved: " +
                         "; ".join(f"{label(c['id'])}{why(c['id'])}" for c in unresolved[:3]))
        if advisory:
            parts.append("requires reviewer judgement: " + "; ".join(f"{label(c['id'])}{why(c['id'])}" for c in advisory))
        text = " ".join(p[0].upper() + p[1:] for p in parts)
    return {
        "decision": decision,
        "code": code,
        "explanation": text,
        "unresolved": [c["id"] for c in unresolved],
        "violated": [c["id"] for c in violated],
        "triggered": [c["id"] for c in triggered],
        "model_decision": model_decision,
        "model_code": model_code,
        "agrees_with_model": (model_decision == decision) if model_decision else None,
    }


# ---------------------------------------------------------------- orchestration

def _call(provider: LLMProvider, prompt: str) -> tuple[AnalysisOut, dict]:
    data = provider.generate_json(system=SYSTEM_PROMPT, prompt=prompt, schema=AnalysisOut)
    usage = data.pop("_usage", {}) or {}
    try:
        return AnalysisOut.model_validate(data), usage
    except ValidationError as e:
        raise ProviderError(f"Model output failed schema validation: {e.errors()[:3]}") from e


def analyze_document(provider: LLMProvider, criteria: dict[str, Any], paper: dict[str, Any], pages: list[dict[str, Any]],
                     idx: DocIndex, max_single_pass_chars: int, chunk_chars: int, progress=lambda s: None) -> dict[str, Any]:
    t0 = time.time()
    ids = criterion_ids(criteria)
    full = document_text_with_markers(pages)
    usage_total: dict[str, int] = {}

    def add_usage(u: dict):
        for k, v in u.items():
            if isinstance(v, int):
                usage_total[k] = usage_total.get(k, 0) + v

    all_accepted: list[dict] = []
    all_rejected: list[dict] = []
    if len(full) <= max_single_pass_chars:
        progress("Analysing full text")
        out, u = _call(provider, build_prompt(criteria, paper, full))
        add_usage(u)
        accepted, rejected = verify_evidence(out.evidence, idx, ids)
        all_accepted, all_rejected = accepted, rejected
        n_chunks = 1
    else:
        ranges = page_chunks(pages, chunk_chars)
        n_chunks = len(ranges)
        parts = []
        for i, (first, last) in enumerate(ranges, 1):
            progress(f"Analysing part {i}/{n_chunks} (pages {first}-{last})")
            body = document_text_with_markers(pages, first, last)
            out_i, u = _call(provider, build_prompt(criteria, paper, body, (i, n_chunks, first, last)))
            add_usage(u)
            acc, rej = verify_evidence(out_i.evidence, idx, ids)
            all_accepted.extend(acc)
            all_rejected.extend(rej)
            parts.append({"index": i, "first": first, "last": last, "out": out_i})
        # de-duplicate evidence found in overlapping pages
        uniq, seen = [], set()
        for e in all_accepted:
            k = (e["criterion_id"], norm(e["quote"]))
            if k not in seen:
                seen.add(k)
                uniq.append(e)
        all_accepted = uniq
        progress("Synthesising parts")
        opening = document_text_with_markers(pages, 1, min(2, len(pages)))
        out, u = _call(provider, build_synthesis_prompt(criteria, paper, parts, all_accepted, opening))
        add_usage(u)
        extra, rej = verify_evidence(out.evidence, idx, ids)
        seen = {(e["criterion_id"], norm(e["quote"])) for e in all_accepted}
        all_accepted.extend(e for e in extra if (e["criterion_id"], norm(e["quote"])) not in seen)
        all_rejected.extend(rej)

    progress("Verifying evidence and applying rules")
    statuses = apply_rules(out, all_accepted, criteria)
    rec = recommend(statuses, criteria, out.suggested_decision, out.suggested_code)
    total_quotes = len(all_accepted) + len(all_rejected)
    return {
        "result": {
            "study_summary": out.study_summary,
            "study_characteristics": [item.model_dump() for item in out.study_characteristics],
            "assessments": statuses,
            "model_rationale": out.rationale,
            "model_decision": out.suggested_decision,
            "model_code": out.suggested_code,
        },
        "recommendation": rec,
        "evidence": all_accepted,
        "rejected": all_rejected,
        "stats": {
            "analysis_version": ANALYSIS_VERSION,
            "chunks": n_chunks,
            "chars": len(full),
            "quotes_total": total_quotes,
            "quotes_verified": len(all_accepted),
            "quotes_rejected": len(all_rejected),
            "fuzzy_matches": sum(1 for e in all_accepted if e["match_method"] != "exact"),
            "duration_s": round(time.time() - t0, 1),
            "usage": usage_total,
        },
    }
