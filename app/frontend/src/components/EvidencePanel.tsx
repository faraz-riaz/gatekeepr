import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  ExternalLink,
  Info,
  PanelRightClose,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useAnalyze, useInvalidatePaper, usePaper, useStatus } from "../hooks";
import { cx, DECISION_LABEL, decisionTone, fmtDateTime, relTime } from "../lib/format";
import { useUi } from "../store";
import type { Analysis, Decision, PaperDetail } from "../types";
import { CriteriaSection, EvidenceByPage } from "./CriteriaView";
import { DecisionBar } from "./DecisionBar";
import { Button, IconButton, Segmented, Spinner, Tip } from "./ui";

export function EvidencePanel() {
  const selectedId = useUi((s) => s.selectedId);
  const { data: detail, isLoading, error } = usePaper(selectedId);
  const set = useUi((s) => s.set);
  const tab = useUi((s) => s.rightTab);
  const [expandAll, setExpandAll] = useState<boolean | null>(null);

  useEffect(() => setExpandAll(null), [selectedId]);

  return (
    <div className="flex h-full flex-col bg-surface-2">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-surface px-3">
        <h2 className="text-[13px] font-semibold">Eligibility analysis</h2>
        <IconButton label="Collapse evidence panel" kbd="]" className="-mr-1.5 h-7 w-7" onClick={() => set({ rightOpen: false })}>
          <PanelRightClose size={16} />
        </IconButton>
      </div>
      {!selectedId && <div className="p-6 text-center text-[13px] text-ink-3">Select a paper to begin.</div>}
      {selectedId && isLoading && (
        <div className="flex items-center justify-center gap-2 p-10 text-ink-3">
          <Spinner /> Loading…
        </div>
      )}
      {error && <div className="m-3 rounded-lg bg-rose-50 p-3 text-[12.5px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{(error as Error).message}</div>}
      {detail && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PaperHeader detail={detail} />
            <div className="space-y-4 px-3 pb-5 pt-3">
              <AnalysisCard detail={detail} />
              <div className="flex items-center gap-2">
                <Segmented
                  className="flex-1"
                  value={tab}
                  onChange={(v) => set({ rightTab: v })}
                  options={[
                    { value: "criteria", label: "By criterion" },
                    { value: "evidence", label: `Evidence by page (${detail.evidence.filter((e) => !e.dismissed).length})` },
                  ]}
                />
                {tab === "criteria" && (
                  <IconButton label={expandAll ? "Collapse all criteria" : "Expand all criteria"} className="h-7 w-7" onClick={() => setExpandAll((x) => !x)}>
                    <ChevronsUpDown size={14} />
                  </IconButton>
                )}
              </div>
              {tab === "criteria" ? (
                <>
                  <CriteriaSection kind="inclusion" detail={detail} expandAll={expandAll} />
                  <CriteriaSection kind="exclusion" detail={detail} expandAll={expandAll} />
                </>
              ) : (
                <EvidenceByPage detail={detail} />
              )}
              <NotesBox key={detail.paper.paper_id} detail={detail} />
            </div>
          </div>
          <DecisionBar detail={detail} />
        </>
      )}
    </div>
  );
}

function PaperHeader({ detail }: { detail: PaperDetail }) {
  const p = detail.paper;
  const [more, setMore] = useState(false);
  return (
    <div className="border-b border-line bg-surface px-4 pb-3.5 pt-3">
      <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
        <span className="rounded bg-surface-3 px-1.5 py-px font-mono font-medium text-ink-2">{p.paper_id}</span>
        {p.year && <span>{p.year}</span>}
        {detail.text?.page_count ? <span>· {detail.text.page_count} pages</span> : null}
        {p.source && <span className="truncate">· {p.source}</span>}
      </div>
      <h1 className="mt-1.5 font-serif text-[17px] font-semibold leading-snug text-ink">{p.title}</h1>
      {p.authors && (
        <p className={cx("mt-1 text-[12.5px] leading-snug text-ink-2", !more && "line-clamp-1")} onClick={() => setMore((m) => !m)} title={p.authors}>
          {p.authors.replace(/;\s*/g, ", ")}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {p.doi && (
          <a className="inline-flex items-center gap-1 text-accent hover:underline" href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">
            {p.doi} <ExternalLink size={11} />
          </a>
        )}
        {p.license && <span className="text-ink-3">{p.license}</span>}
      </div>
      {p.duplicate_of && (
        <Callout tone="amber" icon={<Info size={13} />}>
          Manifest: this record is the published version of / duplicate of <span className="font-mono font-medium">{p.duplicate_of}</span> and reuses its PDF. Apply your review's
          duplicate or secondary-report criterion and screen the most appropriate report.
        </Callout>
      )}
      {p.pdf_checksum_ok === false && (
        <Callout tone="rose" icon={<TriangleAlert size={13} />}>
          The PDF file's checksum does not match the manifest. The file may have been replaced since acquisition.
        </Callout>
      )}
    </div>
  );
}

function Callout({ tone, icon, children }: { tone: "amber" | "rose" | "neutral" | "accent"; icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className={cx(
        "mt-2.5 flex gap-2 rounded-lg px-2.5 py-2 text-[12px] leading-snug",
        tone === "amber" && "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200",
        tone === "rose" && "bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200",
        tone === "neutral" && "bg-surface-3 text-ink-2",
        tone === "accent" && "bg-accent-soft text-ink",
      )}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const REC_ICON: Record<Decision, ReactNode> = {
  include: <CircleCheck size={18} />,
  exclude: <CircleX size={18} />,
  maybe: <CircleQuestionMark size={18} />,
};

function AnalysisCard({ detail }: { detail: PaperDetail }) {
  const { data: status } = useStatus();
  const analyze = useAnalyze();
  const a = detail.analysis;
  const ai = status?.ai;
  const running = detail.analysis_state === "running" || detail.analysis_state === "queued";

  if (!detail.paper.pdf_available) {
    return (
      <Callout tone="neutral" icon={<Info size={13} />}>
        <span className="font-medium">Full text not retrieved.</span> AI analysis needs the full-text PDF. You can still record a decision (e.g. U1 — not retrieved) and notes.
      </Callout>
    );
  }

  return (
    <div className="space-y-2">
      {ai?.available && ai.check && !ai.check.ok && !running && (
        <Callout tone="amber" icon={<Unplug size={13} />}>
          <div className="font-medium">AI provider connection failed</div>
          <div className="mt-0.5 line-clamp-4 break-words">{ai.check.message}</div>
          <div className="mt-1 text-ink-3">Manual screening and annotation remain fully available.</div>
        </Callout>
      )}
      {running && (
        <div className="overflow-hidden rounded-xl border border-accent/30 bg-surface">
          <div className="flex items-center gap-2.5 px-3.5 py-3 text-[13px]">
            <Spinner className="text-accent" />
            <div>
              <div className="font-medium">{detail.analysis_state === "queued" ? "Queued for AI analysis" : "Analysing full text…"}</div>
              <div className="text-[12px] text-ink-3">{detail.job?.stage}</div>
            </div>
          </div>
          <div className="h-0.5 overflow-hidden bg-accent/10">
            <div className="indeterminate h-full w-1/3 bg-accent" />
          </div>
        </div>
      )}
      {detail.analysis_failed && !running && (
        <Callout tone="rose" icon={<TriangleAlert size={13} />}>
          <div className="font-medium">Last analysis attempt failed</div>
          <div className="mt-0.5 break-words">{detail.analysis_failed.error}</div>
        </Callout>
      )}
      {a ? (
        <RecommendationCard a={a} onReanalyze={ai?.available ? () => analyze.mutate({ id: detail.paper.paper_id, force: true }) : undefined} running={running} />
      ) : (
        !running && (
          <div className="rounded-xl border border-dashed border-line-strong bg-surface p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">{ai?.available ? <Sparkles size={16} /> : <Unplug size={16} />}</div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{ai?.available ? "Not analysed yet" : "AI analysis unavailable"}</div>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
                  {ai?.available
                    ? `Analyse the full text against the criteria with ${ai.model}. Every quotation is verified against the PDF before it is highlighted.`
                    : `${ai?.status ?? "No provider configured."} You can still read, annotate evidence manually and record decisions.`}
                </p>
                {detail.analysis_state === "no_text" && <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">This PDF has no extractable text, so it cannot be analysed.</p>}
                {ai?.available && detail.analysis_state !== "no_text" && (
                  <Button size="sm" variant="primary" className="mt-2.5" onClick={() => analyze.mutate({ id: detail.paper.paper_id })} disabled={analyze.isPending}>
                    <Sparkles size={13} /> Analyse paper <span className="ml-1 text-[10.5px] opacity-60">A</span>
                  </Button>
                )}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function RecommendationCard({ a, onReanalyze, running }: { a: Analysis; onReanalyze?: () => void; running: boolean }) {
  const rec = a.recommendation;
  const t = decisionTone[rec.decision];
  const [showProfile, setShowProfile] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const characteristics = a.result.study_characteristics ?? [];
  return (
    <div className={cx("overflow-hidden rounded-xl border bg-surface", rec.decision === "include" ? "border-emerald-200 dark:border-emerald-500/25" : rec.decision === "exclude" ? "border-rose-200 dark:border-rose-500/25" : "border-amber-200 dark:border-amber-500/25")}>
      <div className={cx("px-3.5 pb-3 pt-3", t.soft)}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">AI suggestion · advisory</div>
          {onReanalyze && (
            <Tip content="Re-run the analysis (uses the API)">
              <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-black/5 hover:text-ink dark:hover:bg-white/5" onClick={onReanalyze} disabled={running}>
                <RefreshCw size={11} className={running ? "animate-spin" : ""} /> Re-analyse
              </button>
            </Tip>
          )}
        </div>
        <div className={cx("mt-1 flex items-center gap-2", t.text)}>
          {REC_ICON[rec.decision]}
          <span className="text-[19px] font-bold tracking-tight">{DECISION_LABEL[rec.decision].toUpperCase()}</span>
          {rec.code && <span className="rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-[11.5px] font-medium dark:bg-black/20">{rec.code}</span>}
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink">{rec.explanation}</p>
      </div>
      <div className="space-y-2 px-3.5 py-2.5 text-[12px]">
        {a.outdated_reason && (
          <div className="flex gap-1.5 text-amber-700 dark:text-amber-300">
            <TriangleAlert size={13} className="mt-px shrink-0" /> {a.outdated_reason} Consider re-analysing.
          </div>
        )}
        {rec.agrees_with_model === false && rec.model_decision && (
          <div className="flex gap-1.5 text-ink-2">
            <Info size={13} className="mt-px shrink-0 text-ink-3" />
            <span>
              The model itself suggested <span className="font-medium">{DECISION_LABEL[rec.model_decision].toUpperCase()}</span>
              {rec.model_code ? ` (${rec.model_code})` : ""}; the recommendation above applies the review's decision rules to the verified evidence only.
            </span>
          </div>
        )}
        <p className="leading-snug text-ink-2">{a.result.study_summary}</p>
        {a.result.model_rationale && <p className="leading-snug text-ink-3">{a.result.model_rationale}</p>}

        {characteristics.length > 0 && <button className="flex items-center gap-1 font-medium text-ink-2 hover:text-ink" onClick={() => setShowProfile((s) => !s)}>
          {showProfile ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Study characteristics
          <span className="ml-1 rounded bg-surface-3 px-1.5 text-[10.5px] font-normal text-ink-3">{characteristics.length}</span>
        </button>}
        {showProfile && characteristics.length > 0 && (
          <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 rounded-lg bg-surface-2 p-2.5 text-[11.5px]">
            {characteristics.map((item, index) => (
              <div key={`${item.label}-${index}`} className="contents">
                <dt className="text-ink-3">{item.label}</dt>
                <dd className="text-ink-2">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-2 text-[11px] text-ink-3">
          <Tip content={fmtDateTime(a.completed_at)}>
            <span>
              {a.provider}:{a.model} · {relTime(a.completed_at)}
            </span>
          </Tip>
          <span>·</span>
          <span>
            {a.stats.quotes_verified} verified quote{a.stats.quotes_verified === 1 ? "" : "s"}
          </span>
          {a.stats.quotes_rejected > 0 && (
            <>
              <span>·</span>
              <button className="underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => setShowRejected((s) => !s)}>
                {a.stats.quotes_rejected} rejected
              </button>
            </>
          )}
          {a.stats.chunks > 1 && <span>· {a.stats.chunks} parts</span>}
        </div>
        {showRejected && (
          <div className="space-y-1.5 rounded-lg bg-surface-2 p-2.5">
            <p className="text-[11px] text-ink-3">Quotations returned by the model that could not be verified in the PDF text. They are not highlighted and were not used.</p>
            {a.rejected.map((r, i) => (
              <div key={i} className="text-[11.5px]">
                <span className="font-mono text-ink-3">{r.criterion_id}</span> <span className="text-ink-3">p.{r.page}</span>{" "}
                <span className="italic text-ink-2 line-through decoration-ink-3/40">“{r.quote}”</span> <span className="text-rose-600 dark:text-rose-400">— {r.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotesBox({ detail }: { detail: PaperDetail }) {
  // Mounted once per paper (keyed by paper ID); refetches never overwrite what the reviewer is typing.
  const id = detail.paper.paper_id;
  const invalidate = useInvalidatePaper();
  const [value, setValue] = useState(detail.notes?.body ?? "");
  const [state, setState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const lastSaved = useRef(detail.notes?.body ?? "");
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const save = async (body: string) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    if (body === lastSaved.current) {
      setState((s) => (s === "dirty" ? "saved" : s));
      return;
    }
    setState("saving");
    try {
      await api.setNotes(id, body);
      lastSaved.current = body;
      setState("saved");
      invalidate(id);
    } catch (e) {
      pending.current = body;
      setState("dirty");
      toast.error(`Notes not saved: ${(e as Error).message}`);
    }
  };

  // flush unsaved edits when switching to another paper
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current !== null && pending.current !== lastSaved.current) {
        api.setNotes(id, pending.current).then(() => invalidate(id), (e) => toast.error(`Notes not saved: ${e.message}`));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChange = (v: string) => {
    setValue(v);
    setState("dirty");
    pending.current = v;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(v), 700);
  };

  return (
    <section>
      <div className="flex items-center justify-between px-1 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Reviewer notes</h3>
        <span className="text-[11px] text-ink-3">
          {state === "saving" && "Saving…"}
          {state === "saved" && "Saved"}
          {state === "dirty" && "Unsaved"}
          {state === "idle" && detail.notes?.updated_at && `Updated ${relTime(detail.notes.updated_at)}`}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => pending.current !== null && save(value)}
        rows={4}
        placeholder="Interpretations, concerns, uncertainties, sections to re-check…"
        className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
      />
    </section>
  );
}
