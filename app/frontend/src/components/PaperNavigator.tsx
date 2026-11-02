import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  FileText,
  FileX,
  Funnel,
  PanelLeftClose,
  Search,
  SkipForward,
  Sparkles,
  StickyNote,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useFilteredPapers, useNavigation, usePapers } from "../hooks";
import { cx, DECISION_LABEL, decisionTone, firstAuthor } from "../lib/format";
import { useUi, type AiFilter, type PdfFilter } from "../store";
import type { PaperSummary } from "../types";
import { Button, IconButton, Kbd, Menu, MenuItem, MenuLabel, MenuSeparator, Segmented, Spinner, Tip } from "./ui";

export function PaperNavigator() {
  const { data: papers, isLoading, error } = usePapers();
  const filtered = useFilteredPapers();
  const ui = useUi();
  const { step, nextUnscreened } = useNavigation();
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const all = papers ?? [];
    const c = { total: all.length, screened: 0, include: 0, exclude: 0, maybe: 0, pdf: 0 };
    for (const p of all) {
      if (p.decision) {
        c.screened++;
        c[p.decision]++;
      }
      if (p.pdf_available) c.pdf++;
    }
    return c;
  }, [papers]);

  // keep the selected row visible
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-pid="${ui.selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [ui.selectedId, filtered.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target as HTMLElement)?.closest("input,textarea")) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeFilters = (ui.pdfFilter !== "all" ? 1 : 0) + (ui.aiFilter !== "all" ? 1 : 0);

  return (
    <div className="flex h-full flex-col">
      {/* header + stats */}
      <div className="border-b border-line px-3 pb-3 pt-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-ink">Papers</h2>
          <IconButton label="Collapse paper list" kbd="[" onClick={() => ui.set({ leftOpen: false })} className="-mr-1.5 h-7 w-7">
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
        <div className="mt-2 grid grid-cols-5 gap-1 text-center">
          <Stat label="Total" value={stats.total} />
          <Stat label="Screened" value={stats.screened} />
          <Stat label="Included" value={stats.include} tone="text-emerald-600 dark:text-emerald-400" />
          <Stat label="Excluded" value={stats.exclude} tone="text-rose-600 dark:text-rose-400" />
          <Stat label="Maybe" value={stats.maybe} tone="text-amber-600 dark:text-amber-400" />
        </div>
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-3" aria-label="Screening progress">
          {(["include", "maybe", "exclude"] as const).map((d) => (
            <div key={d} className={cx(decisionTone[d].bar, "transition-all")} style={{ width: `${stats.total ? (stats[d] / stats.total) * 100 : 0}%` }} />
          ))}
        </div>
      </div>

      {/* search + filters */}
      <div className="space-y-2 border-b border-line px-3 py-2.5">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            ref={searchRef}
            value={ui.search}
            onChange={(e) => ui.set({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                ui.set({ search: "" });
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Enter" && filtered[0]) ui.select(filtered[0].paper_id);
            }}
            placeholder="Search title, author, DOI, ID…"
            className="h-8 w-full rounded-md border border-line bg-surface-2 pl-8 pr-14 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:outline-none"
          />
          <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {ui.search ? (
              <button className="rounded p-0.5 text-ink-3 hover:text-ink" onClick={() => ui.set({ search: "" })} aria-label="Clear search">
                <X size={13} />
              </button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Segmented
            className="flex-1"
            value={ui.decisionFilter}
            onChange={(v) => ui.set({ decisionFilter: v })}
            options={[
              { value: "all", label: "All" },
              { value: "unscreened", label: "To do", title: "Not yet screened" },
              { value: "include", label: <span className="text-emerald-600 dark:text-emerald-400">Inc</span>, title: "Included" },
              { value: "exclude", label: <span className="text-rose-600 dark:text-rose-400">Exc</span>, title: "Excluded" },
              { value: "maybe", label: <span className="text-amber-600 dark:text-amber-400">May</span>, title: "Maybe" },
            ]}
          />
          <Menu
            trigger={
              <button
                className={cx(
                  "relative inline-flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-2 hover:bg-surface-3",
                  activeFilters && "border-accent text-accent",
                )}
                aria-label="More filters"
              >
                <Funnel size={13} />
                {activeFilters > 0 && <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-white">{activeFilters}</span>}
              </button>
            }
          >
            <MenuLabel>Full text</MenuLabel>
            {(
              [
                ["all", "Any"],
                ["available", `PDF available (${stats.pdf})`],
                ["missing", `PDF missing (${stats.total - stats.pdf})`],
              ] as [PdfFilter, string][]
            ).map(([v, l]) => (
              <MenuItem key={v} onSelect={() => ui.set({ pdfFilter: v })} icon={ui.pdfFilter === v ? <Check size={14} /> : null}>
                {l}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuLabel>AI analysis</MenuLabel>
            {(
              [
                ["all", "Any"],
                ["analysed", "Analysed"],
                ["pending", "Not analysed / running"],
                ["outdated", "Potentially outdated"],
                ["failed", "Failed / no text"],
                ["suggest_include", "AI suggests include"],
                ["suggest_exclude", "AI suggests exclude"],
                ["suggest_maybe", "AI suggests maybe"],
              ] as [AiFilter, string][]
            ).map(([v, l]) => (
              <MenuItem key={v} onSelect={() => ui.set({ aiFilter: v })} icon={ui.aiFilter === v ? <Check size={14} /> : null}>
                {l}
              </MenuItem>
            ))}
            {activeFilters > 0 && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => ui.set({ pdfFilter: "all", aiFilter: "all" })} icon={<X size={14} />}>
                  Clear filters
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>

      {/* list */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {isLoading && <div className="flex items-center justify-center gap-2 py-10 text-ink-3"><Spinner /> Loading papers…</div>}
        {error && <div className="m-2 rounded-md bg-rose-50 p-3 text-[12.5px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">Could not load papers: {(error as Error).message}</div>}
        {!isLoading && !error && filtered.length === 0 && (
          <div className="px-4 py-10 text-center text-[12.5px] text-ink-3">
            No papers match these filters.
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => ui.set({ search: "", decisionFilter: "all", pdfFilter: "all", aiFilter: "all" })}>
                Reset filters
              </Button>
            </div>
          </div>
        )}
        {filtered.map((p) => (
          <PaperRow key={p.paper_id} p={p} selected={p.paper_id === ui.selectedId} onClick={() => ui.select(p.paper_id)} />
        ))}
      </div>

      {/* footer navigation */}
      <div className="flex items-center gap-1 border-t border-line px-2 py-2">
        <IconButton label="Previous paper" kbd="K" onClick={() => step(-1)}>
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton label="Next paper" kbd="J" onClick={() => step(1)}>
          <ArrowRight size={15} />
        </IconButton>
        <Tip content="Jump to the next paper without a decision" kbd="N">
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => nextUnscreened()}>
            <SkipForward size={13} /> Next unscreened
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

function AiIcon({ p }: { p: PaperSummary }) {
  switch (p.analysis_state) {
    case "running":
    case "queued":
      return (
        <Tip content={p.analysis_state === "running" ? "AI analysis running" : "Queued for analysis"}>
          <span className="text-accent"><Spinner size={12} /></span>
        </Tip>
      );
    case "complete":
    case "outdated": {
      const tone = p.ai_decision ? decisionTone[p.ai_decision].text : "text-ink-3";
      return (
        <Tip content={`AI suggests ${p.ai_decision ? DECISION_LABEL[p.ai_decision].toUpperCase() : "—"}${p.ai_code ? ` (${p.ai_code})` : ""}${p.analysis_state === "outdated" ? " · potentially outdated" : ""}`}>
          <span className={cx("relative inline-flex", tone)}>
            <Sparkles size={13} />
            {p.analysis_state === "outdated" && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
          </span>
        </Tip>
      );
    }
    case "failed":
      return <Tip content="Analysis failed"><TriangleAlert size={13} className="text-rose-500" /></Tip>;
    case "no_text":
      return <Tip content="No extractable text (scanned PDF)"><TriangleAlert size={13} className="text-amber-500" /></Tip>;
    case "pending":
      return <Tip content="Not analysed yet"><Clock size={13} className="text-ink-3/70" /></Tip>;
    default:
      return null;
  }
}

function PaperRow({ p, selected, onClick }: { p: PaperSummary; selected: boolean; onClick: () => void }) {
  const tone = p.decision ? decisionTone[p.decision] : null;
  return (
    <button
      data-pid={p.paper_id}
      onClick={onClick}
      className={cx(
        "group relative mb-0.5 flex w-full gap-2.5 rounded-lg py-2 pl-3 pr-2 text-left transition-colors",
        selected ? "bg-accent-soft ring-1 ring-accent/25" : "hover:bg-surface-3/70",
      )}
    >
      <span className={cx("absolute bottom-2 left-1 top-2 w-[3px] rounded-full", tone ? tone.bar : "bg-line")} />
      <div className="min-w-0 flex-1 pl-1">
        <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
          <span className="font-mono font-medium text-ink-2">{p.paper_id}</span>
          {p.year && <span>· {p.year}</span>}
          {p.duplicate_of && (
            <Tip content={`Manifest: duplicate of ${p.duplicate_of}`}>
              <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">dup</span>
            </Tip>
          )}
        </div>
        <div className={cx("mt-0.5 line-clamp-2 text-[13px] leading-snug", selected ? "font-medium text-ink" : "text-ink")} title={p.title ?? ""}>
          {p.title || <span className="italic text-ink-3">Untitled</span>}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-ink-3">{firstAuthor(p.authors) || "—"}</div>
      </div>
      <div className="flex w-[54px] shrink-0 flex-col items-end justify-between gap-1">
        <DecisionBadge decision={p.decision} code={p.decision_code} />
        <div className="flex items-center gap-1.5">
          {p.has_notes && <Tip content="Has reviewer notes"><StickyNote size={12} className="text-ink-3" /></Tip>}
          <AiIcon p={p} />
          {p.pdf_available ? (
            <Tip content="Full-text PDF available"><FileText size={13} className="text-ink-3" /></Tip>
          ) : (
            <Tip content={`No local PDF (${p.access_status ?? "unknown"})`}><FileX size={13} className="text-rose-400" /></Tip>
          )}
        </div>
      </div>
    </button>
  );
}

export function DecisionBadge({ decision, code }: { decision: PaperSummary["decision"]; code?: string | null }) {
  if (!decision) return <span className="rounded-full border border-dashed border-line-strong px-1.5 text-[10px] font-medium leading-4 text-ink-3">To do</span>;
  const t = decisionTone[decision];
  return (
    <Tip content={`${DECISION_LABEL[decision]}${code ? ` · ${code}` : ""}`}>
      <span className={cx("rounded-full px-1.5 text-[10px] font-semibold uppercase leading-4 ring-1", t.soft, t.text, t.ring)}>{DECISION_LABEL[decision]}</span>
    </Tip>
  );
}
