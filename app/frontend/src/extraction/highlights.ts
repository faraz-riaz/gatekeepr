import type { ViewerHighlight } from "../components/PdfViewer";
import { displayValue, recordName, REVIEW } from "./format";
import type { ExtractionDetail, ExtractionTemplate } from "./types";

export interface ExtractionHighlights {
  highlights: ViewerHighlight[];
  /** evidence id -> id of the merged passage highlight it belongs to */
  primaryOf: Record<string, string>;
  /** passage highlight id -> value ids linked to it (first one "owns" the passage in the panel) */
  valuesOf: Record<string, string[]>;
}

/**
 * Verified, non-removed passages of live values become PDF highlights.
 *
 * Several values often cite the same sentence or table row (e.g. a dataset size and a sample
 * size). Stacking one translucent layer per value makes the text unreadable, so identical
 * passages are merged into a single highlight whose tooltip lists every linked value. When a
 * field is selected, passages that do not belong to it are faded (or hidden in focus mode).
 */
export function buildExtractionHighlights(
  detail: ExtractionDetail,
  template: ExtractionTemplate,
  activeValueId: string | null,
  focusOnly: boolean,
): ExtractionHighlights {
  const groups = new Map(template.groups.map((g) => [g.id, g]));
  const live = detail.records.filter((r) => !r.deleted);
  const names: Record<string, string> = {};
  for (const g of template.groups) live.filter((r) => r.group_id === g.id).forEach((r, i) => (names[r.id] = recordName(r, g, i + 1)));

  type Entry = { evidenceId: string; valueId: string; line: string; mismatch: boolean; manual: boolean; context: string; kicker: string; title: string; review: string };
  const passages = new Map<string, { page: number; rects: ViewerHighlight["rects"]; entries: Entry[] }>();

  for (const v of detail.values) {
    if (!v.in_template || v.review_state === "rejected" || !names[v.record_id]) continue;
    const g = groups.get(v.group_id);
    const f = g?.fields.find((x) => x.id === v.field_id);
    if (!g || !f) continue;
    const shown =
      v.status === "reported" || v.status === "unclear" ? `${displayValue(f, v.value, names)}${v.unit ? ` ${v.unit}` : ""}` : (v.status ?? "").replace("_", " ");
    const where = g.repeatable ? `${g.label} · ${names[v.record_id]}` : g.label;
    for (const e of v.evidence) {
      if (!e.verified || e.removed || !e.rects.length) continue;
      const key = e.rects.map((r) => r.map((x) => Math.round(x)).join(",")).join("|");
      const p = passages.get(key) ?? { page: e.page ?? e.rects[0][0], rects: e.rects, entries: [] };
      p.entries.push({
        evidenceId: e.id,
        valueId: v.id,
        line: `${f.label}${g.repeatable ? ` (${names[v.record_id]})` : ""}: ${shown || "—"}`,
        mismatch: e.value_check === "mismatch",
        manual: e.origin === "manual",
        context: v.context,
        kicker: where,
        title: `${f.label}: ${shown || "—"}`,
        review: REVIEW[v.review_state].label,
      });
      passages.set(key, p);
    }
  }

  const highlights: ViewerHighlight[] = [];
  const primaryOf: Record<string, string> = {};
  const valuesOf: Record<string, string[]> = {};
  for (const p of passages.values()) {
    const id = p.entries[0].evidenceId;
    const valueIds = [...new Set(p.entries.map((x) => x.valueId))];
    for (const x of p.entries) primaryOf[x.evidenceId] = id;
    valuesOf[id] = valueIds;
    const linked = !!activeValueId && valueIds.includes(activeValueId);
    if (focusOnly && activeValueId && !linked) continue;
    const single = p.entries.length === 1;
    // the selected field decides the tone of a shared passage; otherwise it is a mismatch only if every link is
    const focused = linked ? p.entries.filter((x) => x.valueId === activeValueId) : [];
    const allMismatch = focused.length ? focused.every((x) => x.mismatch) : p.entries.every((x) => x.mismatch);
    const someMismatch = p.entries.some((x) => x.mismatch);
    highlights.push({
      id,
      page: p.page,
      rects: p.rects,
      tone: allMismatch ? "mismatch" : "extract",
      dismissed: false,
      faint: !!activeValueId && !linked,
      manual: p.entries.every((x) => x.manual),
      kicker: allMismatch ? "Value not found in this passage" : single ? p.entries[0].kicker : `Source of ${p.entries.length} values`,
      title: single ? p.entries[0].title : p.entries.map((x) => x.line).join("\n"),
      detail: single ? p.entries[0].context || null : null,
      body: someMismatch ? "A linked value does not occur in this passage. Check the row, column and subgroup." : null,
      meta: [`p. ${p.page}`, p.entries.every((x) => x.manual) ? "Added by reviewer" : "Verified in PDF", single ? p.entries[0].review : ""].filter(Boolean).join(" · "),
    });
  }
  return { highlights, primaryOf, valuesOf };
}
