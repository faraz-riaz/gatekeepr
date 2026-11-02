import clsx, { type ClassValue } from "clsx";
import type { Criteria, CriterionInfo, CriterionStatus, Decision, Polarity } from "../types";

export const cx = (...args: ClassValue[]) => clsx(args);

export const DECISION_LABEL: Record<Decision, string> = { include: "Include", exclude: "Exclude", maybe: "Maybe" };

export const decisionTone: Record<Decision, { text: string; bg: string; soft: string; ring: string; dot: string; bar: string }> = {
  include: {
    text: "text-emerald-700 dark:text-emerald-400",
    bg: "bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500",
    soft: "bg-emerald-50 dark:bg-emerald-500/10",
    ring: "ring-emerald-600/25 dark:ring-emerald-400/30",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
  },
  exclude: {
    text: "text-rose-700 dark:text-rose-400",
    bg: "bg-rose-600 hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500",
    soft: "bg-rose-50 dark:bg-rose-500/10",
    ring: "ring-rose-600/25 dark:ring-rose-400/30",
    dot: "bg-rose-500",
    bar: "bg-rose-500",
  },
  maybe: {
    text: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-500 hover:bg-amber-600 dark:bg-amber-500 dark:hover:bg-amber-400",
    soft: "bg-amber-50 dark:bg-amber-500/10",
    ring: "ring-amber-600/25 dark:ring-amber-400/30",
    dot: "bg-amber-500",
    bar: "bg-amber-400",
  },
};

export const STATUS_META: Record<CriterionStatus, { label: string; cls: string }> = {
  met: { label: "Met", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25" },
  not_met: { label: "Not met", cls: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25" },
  unclear: { label: "Unclear", cls: "bg-stone-100 text-stone-600 ring-stone-500/15 dark:bg-white/5 dark:text-stone-300 dark:ring-white/10" },
  not_applicable: { label: "N/A", cls: "bg-transparent text-ink-3 ring-line" },
  triggered: { label: "Triggered", cls: "bg-rose-600 text-white ring-rose-600 dark:bg-rose-500/90" },
  not_triggered: { label: "Confirmed absent", cls: "bg-transparent text-emerald-700 ring-emerald-600/30 dark:text-emerald-300 dark:ring-emerald-400/30" },
  not_found: { label: "Not found", cls: "bg-transparent text-ink-3 ring-line" },
};

export const STATUS_HELP: Record<CriterionStatus, string> = {
  met: "The full text positively establishes this criterion (verified quotation).",
  not_met: "The full text contains verified evidence that this criterion is NOT satisfied.",
  unclear: "Information is missing, ambiguous or conflicting. Absence of evidence is not treated as 'Not met'.",
  not_applicable: "The criterion's own wording limits its scope and this paper falls outside it.",
  triggered: "Verified evidence shows this exclusion criterion applies.",
  not_triggered: "Verified evidence shows this exclusion does not apply (confirmed absent).",
  not_found: "No information either way was found in the document (not the same as confirmed absent).",
};

export const POLARITY_LABEL: Record<Polarity, string> = {
  include: "Supports inclusion",
  exclude: "Supports exclusion",
  uncertain: "Ambiguous",
};

export function flattenCriteria(c: Criteria | undefined): Record<string, CriterionInfo> {
  const out: Record<string, CriterionInfo> = {};
  if (!c) return out;
  for (const kind of ["inclusion", "exclusion"] as const) {
    for (const cr of c[kind]) {
      out[cr.id] = { id: cr.id, kind, name: cr.name, definition: cr.definition, parent: null };
      for (const s of cr.sub_requirements ?? []) {
        out[s.id] = { id: s.id, kind, name: s.text, definition: s.text, parent: cr.id };
      }
    }
  }
  return out;
}

export function firstAuthor(authors: string | null): string {
  if (!authors) return "";
  const list = authors.split(/;\s*/).filter(Boolean);
  const first = list[0]?.trim() ?? "";
  const surname = first.split(/\s+/).slice(-1)[0] ?? first;
  return list.length > 1 ? `${surname} et al.` : surname;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
