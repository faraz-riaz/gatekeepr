import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, FileText, FileX, PanelLeftClose, Search, SkipForward, StickyNote, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, Kbd, Segmented, Spinner, Tip } from "../components/ui";
import { cx } from "../lib/format";
import { useUi } from "../store";
import { X_STATUS } from "./format";
import { useXFiltered, useXNavigation, useXPapers } from "./hooks";
import type { ExtractionPaperSummary } from "./types";

const FLAG_HELP: Record<string, string> = {
  not_eligible: "No longer included in screening — data is kept but excluded from exports by default",
  template_changed: "The template changed after this extraction was completed",
  pdf_changed: "The PDF changed after evidence was linked — re-verify evidence",
  failed: "The last AI extraction failed",
  conflicts: "A newer AI suggestion differs from a reviewed value",
};

export function ExtractionNavigator() {
  const { data, isLoading, error } = useXPapers();
  const { eligible, former, all } = useXFiltered();
  const ui = useUi();
  const { step, nextOpen } = useXNavigation();
  const listRef = useRef<HTMLDivElement>(null);
  const [showFormer, setShowFormer] = useState(false);

  const stats = useMemo(() => {
    const inc = all.filter((p) => p.eligible);
    return {
      included: inc.length,
      done: inc.filter((p) => p.status === "completed").length,
      review: inc.filter((p) => ["awaiting_review", "in_progress", "ready"].includes(p.status)).length,
      todo: inc.filter((p) => p.status === "not_started" || p.status === "queued" || p.status === "running").length,
    };
  }, [all]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-xpid="${ui.xSelectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [ui.xSelectedId, eligible.length]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-3 pb-3 pt-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-ink">Included papers</h2>
          <IconButton label="Collapse paper list" kbd="[" onClick={() => ui.set({ leftOpen: false })} className="-mr-1.5 h-7 w-7">
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1 text-center">
          <Stat label="Included" value={stats.included} />
          <Stat label="To extract" value={stats.todo} />
          <Stat label="In review" value={stats.review} tone="text-violet-600 dark:text-violet-400" />
          <Stat label="Completed" value={stats.done} tone="text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-3" aria-label="Extraction progress">
          <div className="bg-emerald-500 transition-all" style={{ width: `${stats.included ? (stats.done / stats.included) * 100 : 0}%` }} />
          <div className="bg-violet-400 transition-all" style={{ width: `${stats.included ? (stats.review / stats.included) * 100 : 0}%` }} />
        </div>
      </div>

      <div className="space-y-2 border-b border-line px-3 py-2.5">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={ui.search}
            onChange={(e) => ui.set({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                ui.set({ search: "" });
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Enter" && eligible[0]) ui.selectExtraction(eligible[0].paper_id);
            }}
            placeholder="Search included papers…"
            className="h-8 w-full rounded-md border border-line bg-surface-2 pl-8 pr-8 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:outline-none"
          />
          {ui.search ? (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-3 hover:text-ink" onClick={() => ui.set({ search: "" })} aria-label="Clear search">
              <X size={13} />
            </button>
          ) : (
            <Kbd className="absolute right-1.5 top-1/2 -translate-y-1/2">/</Kbd>
          )}
        </div>
        <Segmented
          className="w-full"
          value={ui.xFilter}
          onChange={(v) => ui.set({ xFilter: v })}
          options={[
            { value: "all", label: "All" },
            { value: "todo", label: "To do", title: "Not extracted yet" },
            { value: "review", label: "Review", title: "Awaiting or in review" },
            { value: "done", label: "Done", title: "Completed" },
            { value: "attention", label: <TriangleAlert size={12} className="mx-auto" />, title: "Needs attention: flags, unverified evidence or missing required values" },
          ]}
        />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-10 text-ink-3">
            <Spinner /> Loading…
          </div>
        )}
        {error && <div className="m-2 rounded-md bg-rose-50 p-3 text-[12.5px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{(error as Error).message}</div>}
        {data && stats.included === 0 && (
          <div className="px-4 py-10 text-center text-[12.5px] leading-relaxed text-ink-3">
            No papers have a final <span className="font-medium text-emerald-600 dark:text-emerald-400">Include</span> decision yet.
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={() => ui.setStage("screening")}>
                <ArrowLeft size={13} /> Back to screening
              </Button>
            </div>
          </div>
        )}
        {data && stats.included > 0 && eligible.length === 0 && <div className="px-4 py-8 text-center text-[12.5px] text-ink-3">No papers match these filters.</div>}
        {eligible.map((p) => (
          <Row key={p.paper_id} p={p} selected={p.paper_id === ui.xSelectedId} onClick={() => ui.selectExtraction(p.paper_id)} />
        ))}
        {former.length > 0 && (
          <div className="mt-3 border-t border-line pt-2">
            <button className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3 hover:text-ink-2" onClick={() => setShowFormer((x) => !x)}>
              {showFormer ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              No longer included ({former.length})
            </button>
            {showFormer && (
              <>
                <p className="px-2 pb-1.5 text-[11px] leading-snug text-ink-3">Screening decisions changed after extraction began. The data is kept and can be viewed.</p>
                {former.map((p) => (
                  <Row key={p.paper_id} p={p} selected={p.paper_id === ui.xSelectedId} onClick={() => ui.selectExtraction(p.paper_id)} />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-line px-2 py-2">
        <IconButton label="Previous paper" kbd="K" onClick={() => step(-1)}>
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton label="Next paper" kbd="J" onClick={() => step(1)}>
          <ArrowRight size={15} />
        </IconButton>
        <Tip content="Jump to the next included paper that is not completed" kbd="N">
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => nextOpen()}>
            <SkipForward size={13} /> Next to extract
          </Button>
        </Tip>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-md py-1">
      <div className={cx("text-[15px] font-semibold tabular-nums leading-none", tone ?? "text-ink")}>{value}</div>
      <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">{label}</div>
    </div>
  );
}

export function XStatusBadge({ status }: { status: ExtractionPaperSummary["status"] }) {
  const m = X_STATUS[status];
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[10px] font-semibold leading-4 ring-1", m.cls)}>
      {(status === "running" || status === "queued") && <Spinner size={9} />}
      {m.label}
    </span>
  );
}

function Row({ p, selected, onClick }: { p: ExtractionPaperSummary; selected: boolean; onClick: () => void }) {
  const c = p.counts;
  const pct = c.expected ? Math.round((Math.min(c.reviewed, c.expected) / c.expected) * 100) : 0;
  const flags = p.flags.filter((f) => FLAG_HELP[f]);
  return (
    <button
      data-xpid={p.paper_id}
      onClick={onClick}
      className={cx(
        "group relative mb-0.5 flex w-full gap-2.5 rounded-lg py-2 pl-3 pr-2 text-left transition-colors",
        selected ? "bg-accent-soft ring-1 ring-accent/25" : "hover:bg-surface-3/70",
        !p.eligible && "opacity-70",
      )}
    >
      <span className={cx("absolute bottom-2 left-1 top-2 w-[3px] rounded-full", X_STATUS[p.status].dot)} />
      <div className="min-w-0 flex-1 pl-1">
        <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
          <span className="font-mono font-medium text-ink-2">{p.paper_id}</span>
          {p.year && <span>· {p.year}</span>}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink" title={p.title ?? ""}>
          {p.title || <span className="italic text-ink-3">Untitled</span>}
        </div>
        {c.expected > 0 && p.status !== "not_started" && (
          <Tip content={`${c.reviewed} of ${c.expected} field values reviewed${c.pending ? ` · ${c.pending} AI suggestions pending` : ""}${c.unverified ? ` · ${c.unverified} without verified evidence` : ""}`}>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
                <div className={cx("h-full rounded-full", p.status === "completed" ? "bg-emerald-500" : "bg-violet-400")} style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[10.5px] tabular-nums text-ink-3">{pct}%</span>
            </div>
          </Tip>
        )}
      </div>
      <div className="flex w-[84px] shrink-0 flex-col items-end justify-between gap-1">
        <XStatusBadge status={p.status} />
        <div className="flex items-center gap-1.5">
          {flags.length > 0 && (
            <Tip content={flags.map((f) => FLAG_HELP[f]).join(" · ")}>
              <TriangleAlert size={12} className="text-amber-500" />
            </Tip>
          )}
          {p.has_notes && (
            <Tip content="Has extraction notes">
              <StickyNote size={12} className="text-ink-3" />
            </Tip>
          )}
          {p.pdf_available ? (
            <Tip content="Full-text PDF available">
              <FileText size={13} className="text-ink-3" />
            </Tip>
          ) : (
            <Tip content="No local PDF — manual extraction only">
              <FileX size={13} className="text-rose-400" />
            </Tip>
          )}
        </div>
      </div>
    </button>
  );
}
