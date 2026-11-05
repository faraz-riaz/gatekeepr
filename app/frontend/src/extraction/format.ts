import type {
  ExtractionRecord,
  ExtractionStatus,
  ExtractionValue,
  FieldType,
  ReviewState,
  TemplateField,
  TemplateGroup,
  ValueStatus,
} from "./types";

export const X_STATUS: Record<ExtractionStatus, { label: string; cls: string; dot: string }> = {
  not_started: { label: "To extract", cls: "text-ink-3 ring-line", dot: "bg-stone-300 dark:bg-stone-600" },
  queued: { label: "Queued", cls: "text-accent ring-accent/30", dot: "bg-accent" },
  running: { label: "Extracting…", cls: "text-accent ring-accent/30", dot: "bg-accent" },
  awaiting_review: { label: "Awaiting review", cls: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300", dot: "bg-violet-500" },
  in_progress: { label: "In review", cls: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300", dot: "bg-amber-500" },
  ready: { label: "Reviewed", cls: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300", dot: "bg-sky-500" },
  completed: { label: "Completed", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300", dot: "bg-emerald-500" },
};

export const REVIEW: Record<ReviewState, { label: string; cls: string; help: string }> = {
  pending: {
    label: "AI suggestion",
    cls: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/25",
    help: "Suggested by the AI and not yet reviewed.",
  },
  accepted: {
    label: "Confirmed",
    cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25",
    help: "Confirmed by the reviewer.",
  },
  edited: {
    label: "Reviewer",
    cls: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/25",
    help: "Entered or corrected by the reviewer.",
  },
  rejected: {
    label: "Rejected",
    cls: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25",
    help: "The AI suggestion was rejected; the field has no value.",
  },
};

export const VALUE_STATUS: Record<ValueStatus, string> = {
  reported: "Reported",
  not_reported: "Not reported",
  unclear: "Unclear",
  not_applicable: "Not applicable",
};

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Text",
  long_text: "Long text",
  number: "Number",
  integer: "Whole number",
  categorical: "Single choice",
  multi_categorical: "Multiple choice",
  date: "Date",
  boolean: "Yes / no",
  reference: "Link to record",
};

export function recordName(r: ExtractionRecord | undefined, g: TemplateGroup | undefined, index: number): string {
  if (r?.label) return r.label;
  return `${g?.record_label || g?.label || "Record"} ${index}`;
}

export function displayValue(f: TemplateField | undefined, v: unknown, recordLabels: Record<string, string> = {}): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    return v.map((x) => (f?.type === "reference" ? recordLabels[String(x)] ?? "(removed record)" : String(x))).join(", ");
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  return String(v);
}

export type EvidenceState = "verified" | "mismatch" | "unverified" | "none";

export function evidenceState(v: ExtractionValue | undefined): EvidenceState {
  const live = (v?.evidence ?? []).filter((e) => !e.removed);
  if (!live.length) return "none";
  const verified = live.filter((e) => e.verified);
  if (!verified.length) return "unverified";
  if (verified.some((e) => e.value_check === "ok" || e.value_check === "n/a" || !e.value_check)) return "verified";
  return "mismatch";
}

/** Fields that need the reviewer's attention (used for the "needs attention" filter). */
export function needsAttention(v: ExtractionValue | undefined, f: TemplateField): boolean {
  if (!v || !v.status || v.review_state === "rejected") return f.required;
  if (v.review_state === "pending" || v.conflict || v.issues.length) return true;
  const ev = evidenceState(v);
  return (v.status === "reported" || v.status === "unclear") && ev !== "verified";
}
