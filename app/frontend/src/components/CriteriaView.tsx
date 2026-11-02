import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Eye, EyeOff, Info, Plus, Trash, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useCriteria, useInvalidatePaper } from "../hooks";
import { cx, POLARITY_LABEL, STATUS_HELP, STATUS_META } from "../lib/format";
import { useUi } from "../store";
import type { Analysis, Assessment, Criterion, CriterionStatus, Evidence, PaperDetail } from "../types";
import { Tip } from "./ui";

const BAR: Record<Evidence["polarity"], string> = {
  include: "bg-emerald-500",
  exclude: "bg-rose-500",
  uncertain: "bg-amber-400",
};

export function StatusPill({ status, small }: { status: CriterionStatus | null | undefined; small?: boolean }) {
  if (!status) {
    return <span className={cx("inline-flex items-center rounded-full px-2 font-medium text-ink-3 ring-1 ring-inset ring-line", small ? "h-[18px] text-[10.5px]" : "h-5 text-[11px]")}>Not assessed</span>;
  }
  const m = STATUS_META[status];
  return (
    <Tip content={STATUS_HELP[status]}>
      <span
        className={cx(
          "inline-flex shrink-0 cursor-help items-center whitespace-nowrap rounded-full px-2 font-medium ring-1 ring-inset",
          small ? "h-[18px] text-[10.5px]" : "h-5 text-[11px]",
          m.cls,
          status === "not_found" && "border border-dashed border-line-strong ring-0",
        )}
      >
        {m.label}
      </span>
    </Tip>
  );
}

export function EvidenceItem({ e, compact, showCriterion }: { e: Evidence; compact?: boolean; showCriterion?: boolean }) {
  const active = useUi((s) => s.activeEvidenceId === e.id);
  const focus = useUi((s) => s.focusEvidence);
  const invalidate = useInvalidatePaper();
  const { map } = useCriteria();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const patch = useMutation({
    mutationFn: (dismissed: boolean) => api.patchEvidence(e.id, { dismissed }),
    onSuccess: (r) => {
      invalidate(e.paper_id);
      toast.success(r.dismissed ? "Highlight dismissed" : "Highlight restored", {
        action: { label: "Undo", onClick: () => api.patchEvidence(e.id, { dismissed: !r.dismissed }).then(() => invalidate(e.paper_id)) },
      });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const del = useMutation({
    mutationFn: () => api.deleteEvidence(e.id),
    onSuccess: () => {
      invalidate(e.paper_id);
      toast.success("Manual evidence deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div
      ref={ref}
      data-evidence-id={e.id}
      onClick={() => focus(e.id)}
      className={cx(
        "group relative cursor-pointer rounded-lg border bg-surface py-2 pl-3.5 pr-2 transition-colors",
        active ? "border-accent/50 bg-accent-soft/60 shadow-sm" : "border-line hover:border-line-strong",
        e.dismissed && "opacity-55",
      )}
    >
      <span className={cx("absolute bottom-2 left-1.5 top-2 w-[3px] rounded-full", e.dismissed ? "bg-stone-300 dark:bg-stone-600" : BAR[e.polarity])} />
      <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
        <span className="rounded bg-surface-3 px-1.5 py-px font-medium tabular-nums text-ink-2">p. {e.page}</span>
        {showCriterion && (
          <Tip content={map[e.criterion_id]?.name}>
            <span className="font-mono font-medium text-ink-2">{e.criterion_id}</span>
          </Tip>
        )}
        <span className={cx(!e.dismissed && (e.polarity === "include" ? "text-emerald-600 dark:text-emerald-400" : e.polarity === "exclude" ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"))}>
          {e.dismissed ? "Dismissed" : POLARITY_LABEL[e.polarity]}
        </span>
        {e.origin === "manual" && (
          <Tip content="Added by the reviewer">
            <span className="inline-flex items-center gap-0.5 text-ink-3">
              <User size={11} /> manual
            </span>
          </Tip>
        )}
        {e.match_method === "fuzzy" && e.match_score != null && (
          <Tip content={`The model's quotation differed slightly from the PDF text; matched at ${Math.round(e.match_score * 100)}% similarity. The PDF text is shown.`}>
            <span className="cursor-help">≈{Math.round(e.match_score * 100)}%</span>
          </Tip>
        )}
        <div className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100">
          <Tip content={e.dismissed ? "Restore highlight" : "Dismiss incorrect highlight"}>
            <button
              className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink"
              onClick={(ev) => {
                ev.stopPropagation();
                patch.mutate(!e.dismissed);
              }}
            >
              {e.dismissed ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          </Tip>
          {e.origin === "manual" && (
            <Tip content="Delete manual evidence">
              <button
                className="rounded p-1 text-ink-3 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                onClick={(ev) => {
                  ev.stopPropagation();
                  del.mutate();
                }}
              >
                <Trash size={13} />
              </button>
            </Tip>
          )}
        </div>
      </div>
      <blockquote
        className={cx("quote mt-1 text-ink", !expanded && (compact ? "line-clamp-3" : "line-clamp-4"))}
        onDoubleClick={(ev) => {
          ev.stopPropagation();
          setExpanded((x) => !x);
        }}
      >
        “{e.quote}”
      </blockquote>
      {e.explanation && <p className="mt-1 text-[12px] leading-snug text-ink-3">{e.explanation}</p>}
    </div>
  );
}

function AddEvidenceButton({ criterionId }: { criterionId: string }) {
  const set = useUi((s) => s.set);
  const pending = useUi((s) => s.pendingSelection);
  return (
    <button
      onClick={(ev) => {
        ev.stopPropagation();
        set({ addEvidenceFor: { criterionId } });
        if (!pending) toast.info(`Select a passage in the PDF to add as evidence for ${criterionId}.`);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-3 hover:bg-surface-3 hover:text-ink"
    >
      <Plus size={12} /> Add evidence
    </button>
  );
}

function evidenceFor(evidence: Evidence[], ids: string[], showDismissed: boolean) {
  return evidence.filter((e) => ids.includes(e.criterion_id) && (showDismissed || !e.dismissed)).sort((a, b) => a.page - b.page);
}

function CriterionCard({
  c,
  analysis,
  evidence,
  expandAll,
}: {
  c: Criterion;
  analysis: Analysis | null;
  evidence: Evidence[];
  expandAll: boolean | null;
}) {
  const showDismissed = useUi((s) => s.showDismissed);
  const activeId = useUi((s) => s.activeEvidenceId);
  const a: Assessment | undefined = analysis?.result.assessments[c.id];
  const own = evidenceFor(evidence, [c.id], showDismissed);
  const subIds = (c.sub_requirements ?? []).map((s) => s.id);
  const allEv = evidenceFor(evidence, [c.id, ...subIds], showDismissed);
  const hasActive = allEv.some((e) => e.id === activeId);
  const status = a?.status;
  const attention = status === "not_met" || status === "triggered" || status === "unclear";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (expandAll !== null) setOpen(expandAll);
  }, [expandAll]);
  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);

  return (
    <div className={cx("rounded-xl border bg-surface transition-colors", status === "triggered" ? "border-rose-300 dark:border-rose-500/40" : "border-line")}>
      <button className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mt-0.5 text-ink-3">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[13px] font-medium leading-snug text-ink">
              <span className="mr-1.5 font-mono text-[12px] text-ink-3">{c.id}</span>
              {c.name}
            </div>
            <StatusPill status={status} />
          </div>
          {a?.justification && <p className={cx("mt-1 text-[12.5px] leading-snug text-ink-2", !open && "line-clamp-2")}>{a.justification}</p>}
          {!open && allEv.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {allEv.slice(0, 8).map((e) => (
                <span key={e.id} className={cx("inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-[10.5px] font-medium tabular-nums", e.dismissed ? "bg-surface-3 text-ink-3" : e.polarity === "include" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : e.polarity === "exclude" ? "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300")}>
                  p.{e.page}
                </span>
              ))}
              {allEv.length > 8 && <span className="text-[10.5px] text-ink-3">+{allEv.length - 8}</span>}
            </div>
          )}
        </div>
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-line px-3 pb-3 pt-2.5">
          <div className="rounded-lg bg-surface-2 px-2.5 py-2">
            <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Criterion (verbatim)</div>
            <p className="text-[12px] leading-relaxed text-ink-2">{c.definition}</p>
          </div>
          {a?.notes && a.notes.length > 0 && (
            <div className="flex gap-1.5 rounded-lg border border-dashed border-line-strong px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-3">
              <Info size={12} className="mt-0.5 shrink-0" />
              <div>
                {a.notes.map((n, i) => (
                  <div key={i}>{n}</div>
                ))}
                {a.model_status && a.model_status !== a.status && <div>Model's original status: {STATUS_META[a.model_status as CriterionStatus]?.label ?? a.model_status}.</div>}
              </div>
            </div>
          )}
          {a?.route && <div className="text-[12px] text-ink-2">Route satisfied: <span className="font-mono font-medium">{a.route}</span></div>}

          {(c.sub_requirements ?? []).length > 0 && (
            <div className="space-y-2">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">
                {c.sub_requirements![0].kind === "route" ? "Routes (one must apply)" : "All parts required"}
              </div>
              {c.sub_requirements!.map((s) => {
                const sa = analysis?.result.assessments[s.id];
                const sev = evidenceFor(evidence, [s.id], showDismissed);
                return (
                  <div key={s.id} className="rounded-lg border border-line px-2.5 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[12.5px] leading-snug text-ink">
                        <span className="mr-1.5 font-mono text-[11.5px] text-ink-3">{s.id}</span>
                        {s.text}
                      </div>
                      <StatusPill status={sa?.status} small />
                    </div>
                    {sa?.justification && <p className="mt-1 text-[12px] leading-snug text-ink-2">{sa.justification}</p>}
                    {sa?.notes?.length ? <p className="mt-1 text-[11px] text-ink-3">{sa.notes.join(" ")}</p> : null}
                    {sev.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {sev.map((e) => (
                          <EvidenceItem key={e.id} e={e} compact />
                        ))}
                      </div>
                    )}
                    <div className="mt-1 flex justify-end">
                      <AddEvidenceButton criterionId={s.id} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {own.length > 0 && (
            <div className="space-y-1.5">
              {own.map((e) => (
                <EvidenceItem key={e.id} e={e} />
              ))}
            </div>
          )}
          {analysis && allEv.length === 0 && (
            <p className="text-[12px] italic text-ink-3">
              {attention ? "No verified passage was found for this criterion." : "No passages cited."} Absence of evidence is not evidence that the criterion is unmet.
            </p>
          )}
          <div className="flex justify-end">
            <AddEvidenceButton criterionId={c.id} />
          </div>
        </div>
      )}
    </div>
  );
}

export function CriteriaSection({ kind, detail, expandAll }: { kind: "inclusion" | "exclusion"; detail: PaperDetail; expandAll: boolean | null }) {
  const { data: criteria } = useCriteria();
  const list = criteria?.[kind] ?? [];
  const a = detail.analysis;
  const summary = useMemo(() => {
    if (!a) return null;
    const counts: Partial<Record<CriterionStatus, number>> = {};
    for (const c of list) {
      const s = a.result.assessments[c.id]?.status;
      if (s) counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [a, list]);

  return (
    <section>
      <div className="flex items-center justify-between px-1 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{kind === "inclusion" ? "Inclusion criteria" : "Exclusion criteria"}</h3>
        {summary && (
          <div className="flex gap-1.5 text-[11px] text-ink-3">
            {Object.entries(summary).map(([s, n]) => (
              <span key={s}>
                {n} {STATUS_META[s as CriterionStatus].label.toLowerCase()}
              </span>
            ))}
          </div>
        )}
      </div>
      {kind === "inclusion" && criteria?.inclusion_rule && <p className="mb-2 px-1 text-[11.5px] leading-snug text-ink-3">{criteria.inclusion_rule}</p>}
      {kind === "exclusion" && criteria?.exclusion_rule && <p className="mb-2 px-1 text-[11.5px] leading-snug text-ink-3">{criteria.exclusion_rule}</p>}
      <div className="space-y-2">
        {list.map((c) => (
          <CriterionCard key={c.id} c={c} analysis={a} evidence={detail.evidence} expandAll={expandAll} />
        ))}
      </div>
    </section>
  );
}

export function EvidenceByPage({ detail }: { detail: PaperDetail }) {
  const showDismissed = useUi((s) => s.showDismissed);
  const set = useUi((s) => s.set);
  const items = detail.evidence.filter((e) => showDismissed || !e.dismissed).sort((a, b) => a.page - b.page || (b.rects[0]?.[4] ?? 0) - (a.rects[0]?.[4] ?? 0));
  const dismissedCount = detail.evidence.filter((e) => e.dismissed).length;
  const groups = new Map<number, Evidence[]>();
  for (const e of items) groups.set(e.page, [...(groups.get(e.page) ?? []), e]);
  return (
    <div className="space-y-3">
      {dismissedCount > 0 && (
        <button className="px-1 text-[11.5px] text-ink-3 hover:text-ink" onClick={() => set({ showDismissed: !showDismissed })}>
          {showDismissed ? "Hide" : "Show"} {dismissedCount} dismissed highlight{dismissedCount > 1 ? "s" : ""}
        </button>
      )}
      {items.length === 0 && <p className="px-1 py-6 text-center text-[12.5px] text-ink-3">No evidence passages yet. Run the AI analysis or select text in the PDF to add evidence manually.</p>}
      {[...groups.entries()].map(([page, list]) => (
        <div key={page}>
          <div className="sticky top-0 z-[1] bg-surface-2/95 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3 backdrop-blur">Page {page}</div>
          <div className="space-y-1.5">
            {list.map((e) => (
              <EvidenceItem key={e.id} e={e} showCriterion />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
