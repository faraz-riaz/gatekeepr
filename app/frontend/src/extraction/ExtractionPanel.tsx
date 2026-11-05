import { useMutation } from "@tanstack/react-query";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  ExternalLink,
  FileCog,
  Info,
  PanelRightClose,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Trash,
  TriangleAlert,
  Undo2,
  Unplug,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AutosaveNotes } from "../components/AutosaveNotes";
import { Button, IconButton, Kbd, Segmented, Spinner, Tip } from "../components/ui";
import { useStatus } from "../hooks";
import { cx, fmtDateTime, relTime } from "../lib/format";
import { useUi } from "../store";
import { xapi } from "./api";
import { XStatusBadge } from "./ExtractionNavigator";
import { FieldRow, visibleIssues, type FieldContext } from "./FieldRow";
import { displayValue, evidenceState, recordName } from "./format";
import { buildExtractionHighlights } from "./highlights";
import { useTemplate, useXInvalidate, useXPaper } from "./hooks";
import type { ExtractionDetail, ExtractionRecord, ExtractionTemplate, ExtractionValue, TemplateField, TemplateGroup } from "./types";

/** Registered by the mounted panel so the global "Y" shortcut can accept the active value. */
export const extractionControls: { acceptActive?: () => void } = {};

export function ExtractionPanel({ onOpenTemplate }: { onOpenTemplate: () => void }) {
  const selected = useUi((s) => s.xSelectedId);
  const set = useUi((s) => s.set);
  const { data: tpl } = useTemplate();
  const { data: detail, isLoading, error } = useXPaper(selected);
  const template = tpl?.active?.template;

  return (
    <div className="flex h-full flex-col bg-surface-2">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-surface px-3">
        <h2 className="text-[13px] font-semibold">Data extraction</h2>
        <div className="flex items-center gap-0.5">
          <IconButton label="Extraction template" className="h-7 w-7" onClick={onOpenTemplate}>
            <FileCog size={15} />
          </IconButton>
          <IconButton label="Collapse panel" kbd="]" className="-mr-1.5 h-7 w-7" onClick={() => set({ rightOpen: false })}>
            <PanelRightClose size={16} />
          </IconButton>
        </div>
      </div>
      {!template && tpl && <TemplateMissing onOpenTemplate={onOpenTemplate} />}
      {template && !selected && <div className="p-6 text-center text-[13px] text-ink-3">Select an included paper to begin.</div>}
      {template && selected && isLoading && (
        <div className="flex items-center justify-center gap-2 p-10 text-ink-3">
          <Spinner /> Loading…
        </div>
      )}
      {error && <div className="m-3 rounded-lg bg-rose-50 p-3 text-[12.5px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{(error as Error).message}</div>}
      {template && detail && detail.paper.paper_id === selected && <PaperExtraction key={detail.paper.paper_id} detail={detail} template={template} />}
    </div>
  );
}

function TemplateMissing({ onOpenTemplate }: { onOpenTemplate: () => void }) {
  return (
    <div className="m-3 rounded-xl border border-dashed border-line-strong bg-surface p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <FileCog size={18} />
      </div>
      <h3 className="mt-3 text-[14px] font-semibold">Define what to extract</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        Import your extraction form (JSON, Excel or CSV), start from the example, or build it field by field. Groups can be single (one record per paper) or
        repeatable (e.g. several datasets, models or outcomes per paper), and records can link to each other.
      </p>
      <Button size="sm" variant="primary" className="mt-3" onClick={onOpenTemplate}>
        <FileCog size={13} /> Set up extraction template
      </Button>
    </div>
  );
}

function PaperExtraction({ detail, template }: { detail: ExtractionDetail; template: ExtractionTemplate }) {
  const id = detail.paper.paper_id;
  const set = useUi((s) => s.set);
  const focusEvidence = useUi((s) => s.focusEvidence);
  const filter = useUi((s) => s.xFieldFilter);
  const invalidate = useXInvalidate();
  const scrollRef = useRef<HTMLDivElement>(null);

  const live = useMemo(() => detail.records.filter((r) => !r.deleted), [detail.records]);
  const valuesByKey = useMemo(() => {
    const m = new Map<string, ExtractionValue>();
    for (const v of detail.values) m.set(`${v.record_id}:${v.field_id}`, v);
    return m;
  }, [detail.values]);
  const recordLabels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const g of template.groups) {
      live.filter((r) => r.group_id === g.id).forEach((r, i) => (out[r.id] = recordName(r, g, i + 1)));
    }
    return out;
  }, [live, template.groups]);
  const recordsByGroup = useMemo(() => {
    const out: Record<string, { id: string; name: string }[]> = {};
    for (const r of live) (out[r.group_id] ??= []).push({ id: r.id, name: recordLabels[r.id] });
    return out;
  }, [live, recordLabels]);
  const { primaryOf, valuesOf } = useMemo(() => buildExtractionHighlights(detail, template, null, false), [detail, template]);

  // display order of values, used by "accept and go to next"
  const ordered = useMemo(() => {
    const out: ExtractionValue[] = [];
    for (const g of template.groups) {
      for (const r of live.filter((x) => x.group_id === g.id)) {
        for (const f of g.fields) {
          const v = valuesByKey.get(`${r.id}:${f.id}`);
          if (v) out.push(v);
        }
      }
    }
    return out;
  }, [template.groups, live, valuesByKey]);

  // per-group tallies drive the summary, the group navigator and the filters
  const tallies = useMemo(() => {
    const byGroup: Record<string, Tally> = {};
    const total: Tally = { fields: 0, reviewed: 0, review: 0, issues: 0 };
    for (const g of template.groups) {
      const t: Tally = { fields: 0, reviewed: 0, review: 0, issues: 0 };
      const recs = live.filter((r) => r.group_id === g.id);
      const slots: (ExtractionRecord | null)[] = g.repeatable ? recs : [recs[0] ?? null];
      for (const r of slots) {
        for (const f of g.fields) {
          const v = r ? valuesByKey.get(`${r.id}:${f.id}`) : undefined;
          t.fields++;
          if (v && (v.review_state === "accepted" || v.review_state === "edited" || v.review_state === "rejected")) t.reviewed++;
          if (matchesFilter("review", v, f)) t.review++;
          if (matchesFilter("issues", v, f)) t.issues++;
        }
      }
      byGroup[g.id] = t;
      for (const k of Object.keys(total) as (keyof Tally)[]) total[k] += t[k];
    }
    return { byGroup, total };
  }, [template.groups, live, valuesByKey]);

  const acceptable = ordered.filter(
    (v) =>
      v.review_state === "pending" &&
      v.status === "reported" &&
      !v.issues.length &&
      v.evidence.some((e) => !e.removed) &&
      v.evidence.filter((e) => !e.removed).every((e) => e.verified && e.value_check !== "mismatch"),
  ).length;

  useEffect(() => {
    extractionControls.acceptActive = () => {
      const st = useUi.getState();
      const i = ordered.findIndex((v) => v.id === st.activeValueId);
      const cur = ordered[i];
      if (!cur) return toast.info("Click a field first, then press Y to accept it.");
      const go = () => {
        const next = ordered.slice(i + 1).find((v) => v.review_state === "pending");
        if (next) {
          set({ activeValueId: next.id });
          const ev = next.evidence.find((e) => e.verified && !e.removed);
          if (ev) focusEvidence(primaryOf[ev.id] ?? ev.id);
        }
      };
      if (cur.review_state !== "pending" || !cur.status) return go();
      xapi.patchValue(cur.id, { action: "accept" }).then(() => {
        invalidate(id);
        go();
      }, (e: Error) => toast.error(e.message));
    };
    return () => {
      extractionControls.acceptActive = undefined;
    };
  }, [ordered, id, invalidate, set, focusEvidence, primaryOf]);

  const acceptAll = useMutation({
    mutationFn: () => xapi.acceptVerified(id),
    onSuccess: (r) => {
      invalidate(id);
      toast.success(`Accepted ${r.accepted} value${r.accepted === 1 ? "" : "s"} with verified evidence`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // "Accept all" includes suggestions whose source could not be verified; count them for the confirmation
  const pendingAll = ordered.filter((v) => v.review_state === "pending" && v.status);
  const risky = pendingAll.filter(
    (v) => visibleIssues(v).length > 0 || ((v.status === "reported" || v.status === "unclear") && evidenceState(v) !== "verified"),
  ).length;
  const acceptEverything = useMutation({
    mutationFn: () => xapi.acceptAll(id),
    onSuccess: (r) => {
      invalidate(id);
      toast.success(`Accepted ${r.accepted} AI suggestion${r.accepted === 1 ? "" : "s"}`, {
        duration: 8000,
        action: {
          label: "Undo",
          onClick: () =>
            xapi.undoAccept(id, r.value_ids).then(
              (u) => {
                invalidate(id);
                toast.info(`${u.reverted} suggestion${u.reverted === 1 ? "" : "s"} back to review`);
              },
              (e: Error) => toast.error(e.message),
            ),
        },
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const archived = detail.values.filter((v) => !v.in_template && v.status && !detail.records.find((r) => r.id === v.record_id)?.deleted);
  const ctxBase = { paperId: id, recordLabels, recordsByGroup, primaryOf, valuesOf };
  const visibleGroups = template.groups.filter((g) => filter === "all" || tallies.byGroup[g.id][filter] > 0);

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <Header detail={detail} />
        <div className="space-y-3 px-3 pt-3">
          <RunCard detail={detail} />
          <ReviewSummary
            counts={detail.counts}
            tally={tallies.total}
            acceptable={acceptable}
            pendingCount={pendingAll.length}
            riskyCount={risky}
            accepting={acceptAll.isPending || acceptEverything.isPending}
            onAcceptVerified={() => acceptAll.mutate()}
            onAcceptAll={() => acceptEverything.mutate()}
          />
        </div>
        <GroupNav template={template} tallies={tallies.byGroup} live={live} filter={filter} scrollRef={scrollRef} />
        <div className="space-y-5 px-3 pb-5 pt-1">
          {visibleGroups.map((g) => (
            <GroupSection key={g.id} group={g} detail={detail} live={live} valuesByKey={valuesByKey} ctxBase={ctxBase} filter={filter} tally={tallies.byGroup[g.id]} />
          ))}
          {filter !== "all" && visibleGroups.length === 0 && (
            <div className="rounded-xl border border-dashed border-line-strong bg-surface px-4 py-6 text-center text-[12.5px] text-ink-3">
              <CircleCheck size={18} className="mx-auto mb-1.5 text-emerald-500" />
              {filter === "review" ? "No AI suggestions left to review." : "No open issues."}{" "}
              <button className="text-accent underline-offset-2 hover:underline" onClick={() => set({ xFieldFilter: "all" })}>
                Show all fields
              </button>
            </div>
          )}

          {archived.length > 0 && <Archived values={archived} recordLabels={recordLabels} />}

          <AutosaveNotes
            key={id}
            title="Extraction notes"
            initial={detail.notes}
            updatedAt={detail.notes_updated_at}
            placeholder="Decisions made during extraction, author contacts, calculations, things to double-check…"
            save={(body) => xapi.setNotes(id, body)}
            onSaved={() => invalidate(id)}
          />
        </div>
      </div>
      <CompletionBar detail={detail} />
    </>
  );
}

function Header({ detail }: { detail: ExtractionDetail }) {
  const p = detail.paper;
  const setStage = useUi((s) => s.setStage);
  const select = useUi((s) => s.select);
  return (
    <div className="border-b border-line bg-surface px-4 pb-3.5 pt-3">
      <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
        <span className="rounded bg-surface-3 px-1.5 py-px font-mono font-medium text-ink-2">{p.paper_id}</span>
        {p.year && <span>{p.year}</span>}
        {detail.text?.page_count ? <span>· {detail.text.page_count} pages</span> : null}
        <span className="ml-auto">
          <XStatusBadge status={detail.status} />
        </span>
      </div>
      <h1 className="mt-1.5 font-serif text-[16.5px] font-semibold leading-snug text-ink">{p.title}</h1>
      {p.authors && <p className="mt-1 line-clamp-1 text-[12.5px] text-ink-2" title={p.authors}>{p.authors.replace(/;\s*/g, ", ")}</p>}
      {p.doi && (
        <a className="mt-1 inline-flex items-center gap-1 text-[12px] text-accent hover:underline" href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">
          {p.doi} <ExternalLink size={11} />
        </a>
      )}
      {!detail.eligible && (
        <Callout tone="amber" icon={<TriangleAlert size={13} />}>
          <span className="font-medium">No longer included.</span> The screening decision is now{" "}
          <span className="font-medium">{detail.decision ? detail.decision.decision.toUpperCase() : "not set"}</span>. The extracted data is kept but excluded
          from exports by default.{" "}
          <button
            className="underline underline-offset-2"
            onClick={() => {
              setStage("screening");
              select(p.paper_id);
            }}
          >
            Review screening decision
          </button>
        </Callout>
      )}
      {detail.flags.includes("template_changed") && (
        <Callout tone="amber" icon={<Info size={13} />}>
          The extraction template changed after this paper was marked complete. Check new or changed fields, then complete it again.
        </Callout>
      )}
    </div>
  );
}

function RunCard({ detail }: { detail: ExtractionDetail }) {
  const { data: status } = useStatus();
  const invalidate = useXInvalidate();
  const id = detail.paper.paper_id;
  const ai = status?.ai;
  const [showRejected, setShowRejected] = useState(false);
  const run = useMutation({
    mutationFn: () => xapi.run(id),
    onSuccess: () => {
      toast.info(`AI extraction queued for ${id}`);
      invalidate(id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reverify = useMutation({
    mutationFn: () => xapi.reverify(id),
    onSuccess: (r) => {
      invalidate(id);
      toast.success(`Evidence re-checked: ${r.verified} verified, ${r.unverified} not found in the current PDF`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const running = !!detail.job;
  const last = detail.last_successful_run;
  const failed = detail.last_run?.status === "failed" ? detail.last_run : null;
  const canRun = ai?.available && detail.eligible && detail.paper.pdf_available;

  return (
    <div className="space-y-2">
      {running && (
        <div className="overflow-hidden rounded-xl border border-accent/30 bg-surface">
          <div className="flex items-center gap-2.5 px-3.5 py-3 text-[13px]">
            <Spinner className="text-accent" />
            <div>
              <div className="font-medium">{detail.job?.state === "queued" ? "Queued for AI extraction" : "Extracting data…"}</div>
              <div className="text-[12px] text-ink-3">{detail.job?.stage}</div>
            </div>
          </div>
          <div className="h-0.5 overflow-hidden bg-accent/10">
            <div className="indeterminate h-full w-1/3 bg-accent" />
          </div>
        </div>
      )}
      {failed && !running && (
        <Callout tone="rose" icon={<TriangleAlert size={13} />}>
          <div className="font-medium">Last AI extraction failed</div>
          <div className="mt-0.5 break-words">{failed.error}</div>
        </Callout>
      )}
      {detail.flags.includes("pdf_changed") && (
        <Callout tone="amber" icon={<ScanSearch size={13} />}>
          <div>The PDF file changed after evidence was linked. Highlights may be misplaced.</div>
          <Button size="sm" variant="outline" className="mt-1.5" onClick={() => reverify.mutate()} disabled={reverify.isPending}>
            <RefreshCw size={12} /> Re-verify evidence against the current PDF
          </Button>
        </Callout>
      )}
      {!running && !last && (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{ai?.available ? <Sparkles size={16} /> : <Unplug size={16} />}</div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{canRun ? "Not extracted yet" : "Manual extraction"}</div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                {canRun
                  ? `Let ${ai!.model} fill the template from the full text. Every value comes back as a suggestion with its source passage, verified against the PDF.`
                  : !ai?.available
                    ? `${ai?.status ?? "No AI provider configured."} Enter values manually and attach passages from the PDF.`
                    : !detail.paper.pdf_available
                      ? "No local PDF: enter values manually."
                      : "This paper is not currently included."}
              </p>
              {canRun && (
                <Button size="sm" variant="primary" className="mt-2.5" onClick={() => run.mutate()} disabled={run.isPending}>
                  <Sparkles size={13} /> Run AI extraction
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {last && !running && (
        <div className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[12px]">
          <div className="flex items-center gap-2">
            <Sparkles size={13} className="text-violet-500" />
            <span className="font-medium text-ink">AI extraction</span>
            <Tip content={fmtDateTime(last.completed_at)}>
              <span className="text-ink-3">
                {last.provider}:{last.model} · {relTime(last.completed_at)}
              </span>
            </Tip>
            {canRun && (
              <Tip content="Re-run the AI. Reviewed values are never overwritten; differing suggestions are shown for you to decide.">
                <button className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => run.mutate()}>
                  <RefreshCw size={11} /> Re-run
                </button>
              </Tip>
            )}
          </div>
          {last.stats.summary && <p className="mt-1.5 leading-snug text-ink-2">{last.stats.summary}</p>}
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-ink-3">
            <span>{last.stats.records ?? 0} records</span>·<span>{last.stats.quotes_verified ?? 0} passages verified</span>
            {!!last.stats.quotes_unverified && <span className="text-amber-700 dark:text-amber-300">· {last.stats.quotes_unverified} not found in PDF</span>}
            {!!last.stats.value_mismatch && <span className="text-amber-700 dark:text-amber-300">· {last.stats.value_mismatch} value/passage mismatches</span>}
            {!!last.stats.rejected?.length && (
              <button className="underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => setShowRejected((x) => !x)}>
                · {last.stats.rejected.length} discarded
              </button>
            )}
          </div>
          {showRejected && (
            <ul className="mt-1.5 space-y-0.5 rounded-lg bg-surface-2 p-2 text-[11px] text-ink-3">
              {last.stats.rejected!.map((r, i) => (
                <li key={i}>
                  <span className="font-mono">{[r.group_id, r.field_id].filter(Boolean).join(".")}</span> — {r.reason}
                </li>
              ))}
            </ul>
          )}
          {last.outdated_reason && <p className="mt-1.5 text-amber-700 dark:text-amber-300">{last.outdated_reason}</p>}
        </div>
      )}
    </div>
  );
}

interface Tally {
  fields: number;
  reviewed: number;
  review: number;
  issues: number;
}

function matchesFilter(filter: "all" | "review" | "issues", v: ExtractionValue | undefined, f: TemplateField): boolean {
  if (filter === "all") return true;
  if (filter === "review") return !!v?.status && v.review_state === "pending";
  const missing = !v?.status || v.review_state === "rejected";
  if (missing) return f.required;
  if (v!.conflict || visibleIssues(v).length) return true;
  return (v!.status === "reported" || v!.status === "unclear") && evidenceState(v) !== "verified";
}

function ReviewSummary({
  counts,
  tally,
  acceptable,
  pendingCount,
  riskyCount,
  accepting,
  onAcceptVerified,
  onAcceptAll,
}: {
  counts: ExtractionDetail["counts"];
  tally: Tally;
  acceptable: number;
  pendingCount: number;
  riskyCount: number;
  accepting: boolean;
  onAcceptVerified: () => void;
  onAcceptAll: () => void;
}) {
  const filter = useUi((s) => s.xFieldFilter);
  const set = useUi((s) => s.set);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!pendingCount) setConfirming(false);
  }, [pendingCount]);
  const pct = tally.fields ? Math.round((tally.reviewed / tally.fields) * 100) : 0;
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">Review progress</div>
          <div className="mt-0.5 text-[13px] text-ink-2">
            <span className="text-[17px] font-semibold tabular-nums text-ink">{tally.reviewed}</span>
            <span className="tabular-nums"> / {tally.fields}</span> fields reviewed
          </div>
        </div>
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-3" aria-label={`${pct}% reviewed`}>
        <div className="bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        <div className="bg-violet-300 transition-all dark:bg-violet-500/60" style={{ width: `${tally.fields ? (tally.review / tally.fields) * 100 : 0}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
        <Legend dot="bg-emerald-500" label="reviewed" n={tally.reviewed} />
        <Legend dot="bg-violet-400" label="AI suggestions" n={tally.review} />
        {counts.unverified > 0 && <Legend dot="bg-amber-400" label="without verified source" n={counts.unverified} />}
        {counts.required_missing > 0 && <Legend dot="bg-rose-400" label="required missing" n={counts.required_missing} />}
        {counts.conflicts > 0 && <Legend dot="bg-violet-600" label="newer AI suggestions" n={counts.conflicts} />}
      </div>
      {pendingCount > 0 &&
        (confirming ? (
          <div className="mt-2.5 rounded-lg bg-amber-50 px-2.5 py-2 text-[12px] leading-snug text-amber-900 dark:bg-amber-500/10 dark:text-amber-100">
            <div className="font-medium">
              Accept all {pendingCount} AI suggestion{pendingCount === 1 ? "" : "s"}?
            </div>
            <p className="mt-0.5">
              {riskyCount > 0 ? (
                <>
                  <span className="font-medium">{riskyCount}</span> of them {riskyCount === 1 ? "has" : "have"} no verified source passage or a flagged issue and
                  will be marked Confirmed without checking.
                </>
              ) : (
                "Every suggestion has a verified source passage."
              )}{" "}
              You can undo this right after.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                autoFocus
                onClick={() => {
                  setConfirming(false);
                  onAcceptAll();
                }}
                disabled={accepting}
                className="inline-flex h-7 items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 text-[12.5px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Check size={13} strokeWidth={2.75} /> Accept all {pendingCount}
              </button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {acceptable > 0 && (
              <Tip content="Accept only suggestions whose source passage was verified in the PDF and contains the value. Values with issues stay pending.">
                <Button size="sm" variant="outline" onClick={onAcceptVerified} disabled={accepting}>
                  <CheckCheck size={13} /> Accept verified ({acceptable})
                </Button>
              </Tip>
            )}
            <Tip content="Accept every remaining AI suggestion for this paper, including ones without a verified source (asks for confirmation).">
              <Button size="sm" variant="outline" onClick={() => setConfirming(true)} disabled={accepting}>
                <Check size={13} strokeWidth={2.5} /> Accept all ({pendingCount})
              </Button>
            </Tip>
          </div>
        ))}
      <Segmented
        className="mt-2.5 w-full"
        value={filter}
        onChange={(v) => set({ xFieldFilter: v })}
        options={[
          { value: "all", label: "All fields" },
          { value: "review", label: <CountLabel label="To review" n={tally.review} />, title: "AI suggestions not yet reviewed" },
          { value: "issues", label: <CountLabel label="Issues" n={tally.issues} />, title: "Unverified or mismatched evidence, conflicts, missing required values" },
        ]}
      />
    </div>
  );
}

function Legend({ dot, label, n }: { dot: string; label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx("h-1.5 w-1.5 rounded-full", dot)} />
      <span className="tabular-nums text-ink-2">{n}</span> {label}
    </span>
  );
}

function CountLabel({ label, n }: { label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      {n > 0 && <span className="rounded-full bg-surface-3 px-1.5 text-[10px] tabular-nums text-ink-2">{n}</span>}
    </span>
  );
}

/**
 * Sticky jump list of template groups with per-group progress. Chips wrap onto extra lines
 * instead of overflowing, the section currently in view is highlighted (scroll-spy), and jumps
 * land just below the bar whatever its height.
 */
function GroupNav({
  template,
  tallies,
  live,
  filter,
  scrollRef,
}: {
  template: ExtractionTemplate;
  tallies: Record<string, Tally>;
  live: ExtractionRecord[];
  filter: "all" | "review" | "issues";
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const navRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // a section is "current" once its header passes the upper third of the visible area below the bar
        const top = navRef.current?.getBoundingClientRect().bottom ?? el.getBoundingClientRect().top;
        const line = top + Math.max(16, (el.getBoundingClientRect().bottom - top) * 0.33);
        const present = template.groups.map((g) => document.getElementById(`xg-${g.id}`)).filter((s): s is HTMLElement => !!s);
        let cur: string | null = present[0]?.id ?? null;
        for (const s of present) if (s.getBoundingClientRect().top <= line) cur = s.id;
        // when scrolled to the very bottom, the last section counts as current even if it is short
        if (present.length && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = present[present.length - 1].id;
        setCurrent(cur ? cur.slice(3) : null);
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [scrollRef, template.groups, filter]);

  const jump = (gid: string) => {
    const el = scrollRef.current;
    const section = document.getElementById(`xg-${gid}`);
    if (!el || !section) return;
    const top = section.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - (navRef.current?.offsetHeight ?? 0) - 8;
    el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    setCurrent(gid);
  };

  return (
    <div ref={navRef} className="sticky top-0 z-10 mt-3 border-y border-line bg-surface-2/95 px-3 py-2 backdrop-blur">
      <nav className="flex flex-wrap gap-1" aria-label="Extraction sections">
        {template.groups.map((g) => {
          const t = tallies[g.id];
          const n = live.filter((r) => r.group_id === g.id).length;
          const done = t.fields > 0 && t.review === 0 && t.issues === 0;
          const hidden = filter !== "all" && t[filter] === 0;
          const isCurrent = current === g.id && !hidden;
          return (
            <button
              key={g.id}
              disabled={hidden}
              aria-current={isCurrent ? "location" : undefined}
              title={`${g.label} — ${t.reviewed}/${t.fields} reviewed${t.review ? ` · ${t.review} AI suggestions to review` : ""}${t.issues ? ` · ${t.issues} issues` : ""}${hidden ? " (hidden by the current filter)" : ""}`}
              onClick={() => jump(g.id)}
              className={cx(
                "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium transition-colors",
                isCurrent
                  ? "border-accent/50 bg-accent-soft text-ink shadow-sm"
                  : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink",
                hidden && "pointer-events-none opacity-40",
              )}
            >
              {done ? (
                <CircleCheck size={11} className="shrink-0 text-emerald-500" />
              ) : (
                <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", t.review ? "bg-violet-400" : t.issues ? "bg-amber-400" : "bg-line-strong")} />
              )}
              <span className="truncate">{g.label}</span>
              {g.repeatable && <span className="shrink-0 tabular-nums text-ink-3">{n}</span>}
              {t.review > 0 && (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-violet-100 px-1 text-[10px] tabular-nums text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                  <Sparkles size={8} />
                  {t.review}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function GroupSection({
  group,
  detail,
  live,
  valuesByKey,
  ctxBase,
  filter,
  tally,
}: {
  group: TemplateGroup;
  detail: ExtractionDetail;
  live: ExtractionRecord[];
  valuesByKey: Map<string, ExtractionValue>;
  ctxBase: Omit<FieldContext, "group" | "record" | "recordName">;
  filter: "all" | "review" | "issues";
  tally: Tally;
}) {
  const [open, setOpen] = useState(true);
  const invalidate = useXInvalidate();
  const activeValueId = useUi((s) => s.activeValueId);
  const records = live.filter((r) => r.group_id === group.id);
  const removed = detail.records.filter((r) => r.group_id === group.id && r.deleted === 1);
  const recordProgress = (r: ExtractionRecord) => {
    let reviewed = 0;
    let pending = 0;
    for (const f of group.fields) {
      const v = valuesByKey.get(`${r.id}:${f.id}`);
      if (v && v.review_state !== "pending" && v.status) reviewed++;
      if (v?.status && v.review_state === "pending") pending++;
    }
    return { reviewed, pending, total: group.fields.length };
  };
  // In long lists, fully reviewed records start collapsed so attention goes to the open ones.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(records.length > 2 ? records.filter((r) => recordProgress(r).pending === 0 && recordProgress(r).reviewed > 0).map((r) => r.id) : []),
  );
  // expand a record when one of its fields is selected (e.g. from a PDF highlight or the Y shortcut)
  useEffect(() => {
    const v = detail.values.find((x) => x.id === activeValueId);
    if (v && collapsed.has(v.record_id)) {
      setCollapsed((s) => {
        const n = new Set(s);
        n.delete(v.record_id);
        return n;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeValueId]);

  const add = useMutation({
    mutationFn: () => xapi.addRecord(ctxBase.paperId, group.id),
    onSuccess: () => invalidate(ctxBase.paperId),
    onError: (e: Error) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: (rid: string) => xapi.patchRecord(rid, { deleted: false }),
    onSuccess: () => invalidate(ctxBase.paperId),
  });

  const fieldsFor = (record: ExtractionRecord | null) =>
    group.fields.filter((f) => matchesFilter(filter, record ? valuesByKey.get(`${record.id}:${f.id}`) : undefined, f));
  const rows = (record: ExtractionRecord | null, name: string) => {
    const ctx: FieldContext = { ...ctxBase, group, record, recordName: name };
    return fieldsFor(record).map((f) => <FieldRow key={f.id} ctx={ctx} field={f} value={record ? valuesByKey.get(`${record.id}:${f.id}`) : undefined} />);
  };
  const shownRecords = filter === "all" ? records : records.filter((r) => fieldsFor(r).length > 0);
  const allCollapsed = shownRecords.length > 0 && shownRecords.every((r) => collapsed.has(r.id));

  return (
    <section id={`xg-${group.id}`}>
      <div className="flex items-center gap-1.5 px-0.5 pb-2">
        <button className="flex min-w-0 items-center gap-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">{group.label}</h3>
        </button>
        {group.repeatable && (
          <span className="rounded-full bg-surface-3 px-1.5 text-[10.5px] font-medium tabular-nums text-ink-2">
            {records.length} {records.length === 1 ? group.record_label || "record" : `${group.record_label || "record"}s`}
          </span>
        )}
        <span className="ml-auto text-[11px] tabular-nums text-ink-3">
          {tally.reviewed}/{tally.fields} reviewed
        </span>
        {group.repeatable && shownRecords.length > 1 && open && (
          <Tip content={allCollapsed ? "Expand all" : "Collapse all"}>
            <button
              className="rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(shownRecords.map((r) => r.id)))}
            >
              <ChevronsUpDown size={13} />
            </button>
          </Tip>
        )}
      </div>
      {open && (
        <div className="space-y-2">
          {group.description && filter === "all" && <p className="px-0.5 text-[11.5px] leading-snug text-ink-3">{group.description}</p>}
          {!group.repeatable ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-[0_1px_0_rgb(0_0_0/0.02)]">{rows(records[0] ?? null, group.label)}</div>
          ) : (
            <>
              {shownRecords.map((r) => {
                const prog = recordProgress(r);
                return (
                  <RecordCard
                    key={r.id}
                    record={r}
                    group={group}
                    index={records.indexOf(r) + 1}
                    paperId={ctxBase.paperId}
                    progress={prog}
                    summary={summarise(r, group, valuesByKey, ctxBase.recordLabels)}
                    open={!collapsed.has(r.id)}
                    onToggle={() =>
                      setCollapsed((s) => {
                        const n = new Set(s);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                  >
                    {rows(r, ctxBase.recordLabels[r.id])}
                  </RecordCard>
                );
              })}
              {!records.length && <p className="px-0.5 text-[12px] italic text-ink-3">No {group.record_label?.toLowerCase() || "records"} recorded for this paper.</p>}
              {filter === "all" && (
                <button
                  onClick={() => add.mutate()}
                  disabled={add.isPending}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-2 text-[12px] font-medium text-ink-3 transition-colors hover:border-accent/50 hover:bg-surface hover:text-ink"
                >
                  <Plus size={13} /> Add {(group.record_label || "record").toLowerCase()}
                </button>
              )}
              {removed.length > 0 && filter === "all" && (
                <div className="px-0.5 text-[11px] text-ink-3">
                  Removed:{" "}
                  {removed.map((r, i) => (
                    <button key={r.id} className="mr-1.5 underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => restore.mutate(r.id)}>
                      {r.label || `#${i + 1}`} <RotateCcw size={10} className="inline" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** One-line summary of a record's key values, shown when it is collapsed. */
function summarise(r: ExtractionRecord, g: TemplateGroup, values: Map<string, ExtractionValue>, labels: Record<string, string>): string {
  const parts: string[] = [];
  for (const f of g.fields) {
    const v = values.get(`${r.id}:${f.id}`);
    if (!v || (v.status !== "reported" && v.status !== "unclear") || v.review_state === "rejected") continue;
    const s = displayValue(f, v.value, labels);
    if (s && s !== r.label) parts.push(`${s}${v.unit ? ` ${v.unit}` : ""}`);
    if (parts.length === 3) break;
  }
  return parts.join(" · ");
}

function RecordCard({
  record,
  group,
  index,
  paperId,
  progress,
  summary,
  open,
  onToggle,
  children,
}: {
  record: ExtractionRecord;
  group: TemplateGroup;
  index: number;
  paperId: string;
  progress: { reviewed: number; pending: number; total: number };
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const invalidate = useXInvalidate();
  const [label, setLabel] = useState(record.label ?? "");
  const patch = useMutation({
    mutationFn: (data: { label?: string; deleted?: boolean }) => xapi.patchRecord(record.id, data),
    onSuccess: (_r, data) => {
      invalidate(paperId);
      if (data.deleted)
        toast.success(`${group.record_label || "Record"} removed`, {
          action: { label: "Undo", onClick: () => xapi.patchRecord(record.id, { deleted: false }).then(() => invalidate(paperId)) },
        });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  useEffect(() => setLabel(record.label ?? ""), [record.label]);
  const done = progress.pending === 0 && progress.reviewed > 0;
  return (
    <div className={cx("overflow-hidden rounded-xl border bg-surface shadow-[0_1px_0_rgb(0_0_0/0.02)]", open ? "border-line" : "border-line/80")}>
      <div className={cx("flex items-center gap-1.5 px-2 py-1.5", open && "border-b border-line bg-surface-2/50")}>
        <button onClick={onToggle} className="rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <span className="shrink-0 rounded-md bg-surface-3 px-1.5 text-[10.5px] font-semibold tabular-nums text-ink-3">#{index}</span>
        <div className="min-w-0 flex-1">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label !== (record.label ?? "") && patch.mutate({ label })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            placeholder={`Name this ${(group.record_label || "record").toLowerCase()}`}
            className="w-full rounded bg-transparent px-1 text-[13px] font-semibold text-ink placeholder:font-normal placeholder:text-ink-3 hover:bg-surface-3/60 focus:bg-surface-3/60 focus:outline-none"
          />
          {!open && summary && (
            <button onClick={onToggle} className="block w-full truncate px-1 text-left text-[11.5px] text-ink-3">
              {summary}
            </button>
          )}
        </div>
        <Tip content={`${progress.reviewed} of ${progress.total} fields reviewed${progress.pending ? ` · ${progress.pending} AI suggestions` : ""}`}>
          <span
            className={cx(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium tabular-nums ring-1 ring-inset",
              done ? "text-emerald-700 ring-emerald-500/30 dark:text-emerald-300" : progress.pending ? "text-violet-700 ring-violet-400/30 dark:text-violet-300" : "text-ink-3 ring-line",
            )}
          >
            {done && <Check size={10} strokeWidth={3} />}
            {progress.reviewed}/{progress.total}
          </span>
        </Tip>
        {record.origin === "ai" && (
          <Tip content="Found by the AI">
            <Sparkles size={11} className="shrink-0 text-violet-500" />
          </Tip>
        )}
        <Tip content={`Remove this ${(group.record_label || "record").toLowerCase()} (can be restored)`}>
          <button className="shrink-0 rounded p-1 text-ink-3 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" onClick={() => patch.mutate({ deleted: true })}>
            <Trash size={12} />
          </button>
        </Tip>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

function Archived({ values, recordLabels }: { values: ExtractionValue[]; recordLabels: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-dashed border-line-strong px-3 py-2">
      <button className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-ink-3" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {values.length} value{values.length > 1 ? "s" : ""} from fields no longer in the template (kept, exported in long format)
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 text-[12px]">
          {values.map((v) => (
            <li key={v.id} className="text-ink-2">
              <span className="font-mono text-[11px] text-ink-3">
                {v.group_id}.{v.field_id}
                {recordLabels[v.record_id] ? ` (${recordLabels[v.record_id]})` : ""}
              </span>{" "}
              {v.status === "reported" || v.status === "unclear" ? displayValue(undefined, v.value) : v.status} · {evidenceState(v)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CompletionBar({ detail }: { detail: ExtractionDetail }) {
  const id = detail.paper.paper_id;
  const invalidate = useXInvalidate();
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const complete = useMutation({
    mutationFn: (v: { completed: boolean; force?: boolean }) => xapi.complete(id, v.completed, v.force),
    onSuccess: (r, v) => {
      if (v.completed && !r.completed) {
        setWarnings(r.warnings);
        return;
      }
      setWarnings(null);
      invalidate(id);
      toast.success(r.completed ? `${id} extraction completed` : "Extraction reopened");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const done = detail.status === "completed";
  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 pb-3 pt-2.5 shadow-[0_-4px_12px_rgb(0_0_0/0.03)]">
      {warnings && (
        <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <div className="font-medium">Complete anyway?</div>
          <ul className="mt-0.5 list-disc pl-4">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <div className="mt-1.5 flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => complete.mutate({ completed: true, force: true })}>
              Complete anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setWarnings(null)}>
              Keep reviewing
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[12px] text-ink-3">
          {done ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
              <CircleCheck size={13} /> Completed {relTime(detail.completed_at)}
            </span>
          ) : (
            <span className="whitespace-nowrap">
              <Kbd>J</Kbd> <Kbd>K</Kbd> papers · <Kbd>Y</Kbd> accept
            </span>
          )}
        </div>
        {done ? (
          <Button size="sm" variant="outline" onClick={() => complete.mutate({ completed: false })}>
            <Undo2 size={13} /> Reopen
          </Button>
        ) : (
          <button
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50"
            onClick={() => complete.mutate({ completed: true })}
            disabled={complete.isPending}
          >
            <CircleCheck size={14} /> Mark extraction complete
          </button>
        )}
      </div>
    </div>
  );
}

function Callout({ tone, icon, children }: { tone: "amber" | "rose"; icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className={cx(
        "mt-2.5 flex gap-2 rounded-lg px-2.5 py-2 text-[12px] leading-snug",
        tone === "amber" ? "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200" : "bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200",
      )}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

