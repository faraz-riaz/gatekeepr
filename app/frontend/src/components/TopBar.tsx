import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronDown, ChevronRight, Database, FileCog, FileDown, Keyboard, Monitor, Moon, Settings, Sparkles, Sun, Unplug } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { xapi } from "../extraction/api";
import { useTemplate, useXPapers } from "../extraction/hooks";
import { usePapers, useStatus } from "../hooks";
import { cx } from "../lib/format";
import { useUi, type Stage } from "../store";
import { Button, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Spinner, Tip } from "./ui";

export type DialogName = "criteria" | "shortcuts" | "settings" | "template";

export function TopBar({ onOpen }: { onOpen: (d: DialogName) => void }) {
  const { data: papers } = usePapers();
  const { data: xdata } = useXPapers();
  const { data: tpl } = useTemplate();
  const { data: status } = useStatus();
  const theme = useUi((s) => s.theme);
  const stage = useUi((s) => s.stage);
  const set = useUi((s) => s.set);
  const setStage = useUi((s) => s.setStage);
  const qc = useQueryClient();

  const s = useMemo(() => {
    const all = papers ?? [];
    const screened = all.filter((p) => p.decision).length;
    const toAnalyse = all.filter((p) => ["pending", "outdated", "failed"].includes(p.analysis_state)).length;
    const running = all.filter((p) => p.analysis_state === "running" || p.analysis_state === "queued").length;
    return { total: all.length, screened, toAnalyse, running, pct: all.length ? Math.round((screened / all.length) * 100) : 0 };
  }, [papers]);

  const x = useMemo(() => {
    const inc = (xdata?.papers ?? []).filter((p) => p.eligible);
    const done = inc.filter((p) => p.status === "completed").length;
    return {
      included: inc.length,
      done,
      toExtract: inc.filter((p) => p.status === "not_started" && p.pdf_available).length,
      running: inc.filter((p) => p.status === "running" || p.status === "queued").length,
      pct: inc.length ? Math.round((done / inc.length) * 100) : 0,
    };
  }, [xdata]);

  const analyzeAll = async () => {
    if (!confirm(`Queue AI analysis for ${s.toAnalyse} paper(s) without an up-to-date analysis? This uses the configured API and may incur costs.`)) return;
    try {
      const r = await api.analyzeAll();
      toast.success(`Queued ${r.queued.length} paper(s) for analysis`);
      qc.invalidateQueries({ queryKey: ["papers"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const extractAll = async () => {
    if (!confirm(`Run AI extraction for ${x.toExtract} included paper(s) that have not been extracted yet? This uses the configured API and may incur costs.`)) return;
    try {
      const r = await xapi.runAll();
      toast.success(`Queued ${r.queued.length} paper(s) for extraction`);
      qc.invalidateQueries({ queryKey: ["x-papers"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const aiBroken = status?.ai.available && status.ai.check?.ok === false;
  const screeningDone = s.total > 0 && s.screened === s.total;

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="hidden min-w-0 leading-tight xl:block">
          <div className="text-[13.5px] font-semibold tracking-tight">GateKeepr</div>
          <div className="truncate text-[11px] text-ink-3">Full-text review workspace</div>
        </div>
      </div>

      {/* workflow stages: screening → extraction */}
      <nav className="mx-auto flex items-center gap-1 rounded-xl bg-surface-3 p-1" aria-label="Review stages">
        <StageButton
          stage="screening"
          current={stage}
          index={1}
          label="Screening"
          progress={s.pct}
          count={`${s.screened}/${s.total}`}
          tip={`${s.screened} of ${s.total} papers have a human screening decision`}
          onClick={() => setStage("screening")}
        />
        <ChevronRight size={14} className="text-ink-3" />
        <StageButton
          stage="extraction"
          current={stage}
          index={2}
          label="Data extraction"
          progress={x.pct}
          count={x.included ? `${x.done}/${x.included}` : "—"}
          tip={
            x.included
              ? `${x.included} paper(s) with a final Include decision · ${x.done} extraction(s) completed`
              : "Extraction starts once papers have a final Include decision"
          }
          ready={stage === "screening" && screeningDone && x.included > 0 && x.done < x.included}
          onClick={() => setStage("extraction")}
        />
      </nav>

      <div className="flex items-center gap-1.5">
        {aiBroken ? (
          <Tip content={status!.ai.check!.message}>
            <button
              onClick={() => onOpen("settings")}
              className="hidden items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11.5px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 lg:inline-flex"
            >
              <Unplug size={12} /> AI connection failed
            </button>
          </Tip>
        ) : status?.ai.available ? (
          stage === "screening" ? (
            s.running > 0 ? (
              <span className="flex items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-2">
                <Spinner size={12} className="text-accent" /> Analysing {s.running}…
              </span>
            ) : (
              s.toAnalyse > 0 && (
                <Tip content="Analyse every paper with a PDF that has no up-to-date analysis">
                  <Button size="sm" variant="outline" onClick={analyzeAll}>
                    <Sparkles size={13} /> Analyse all ({s.toAnalyse})
                  </Button>
                </Tip>
              )
            )
          ) : x.running > 0 ? (
            <span className="flex items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-2">
              <Spinner size={12} className="text-accent" /> Extracting {x.running}…
            </span>
          ) : (
            tpl?.active &&
            x.toExtract > 0 && (
              <Tip content="Run AI extraction for every included paper with a PDF that has not been extracted yet">
                <Button size="sm" variant="outline" onClick={extractAll}>
                  <Sparkles size={13} /> Extract all ({x.toExtract})
                </Button>
              </Tip>
            )
          )
        ) : (
          status && (
            <Tip content={status.ai.status}>
              <span className="hidden cursor-help rounded-md border border-dashed border-line-strong px-2 py-1 text-[11.5px] text-ink-3 lg:inline">AI unavailable · manual mode</span>
            </Tip>
          )
        )}

        {stage === "screening" ? (
          <Button size="sm" variant="primary" onClick={() => (window.location.href = "/api/export.csv")}>
            <FileDown size={14} /> Export screening results
          </Button>
        ) : (
          <Menu
            trigger={
              <Button size="sm" variant="primary" disabled={!tpl?.active}>
                <FileDown size={14} /> Export extracted data <ChevronDown size={13} />
              </Button>
            }
          >
            <MenuLabel>Relational CSV files (ZIP)</MenuLabel>
            <MenuItem onSelect={() => (window.location.href = xapi.exportUrl("zip"))} hint="all">
              All values (pending ones flagged)
            </MenuItem>
            <MenuItem onSelect={() => (window.location.href = xapi.exportUrl("zip", { reviewedOnly: true }))}>Reviewer-confirmed values only</MenuItem>
            <MenuItem onSelect={() => (window.location.href = xapi.exportUrl("zip", { includeIneligible: true }))}>Including no-longer-included papers</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => (window.location.href = xapi.exportUrl("json"))}>Structured JSON (full hierarchy)</MenuItem>
          </Menu>
        )}
        {stage === "screening" ? (
          <IconButton label="Eligibility criteria" onClick={() => onOpen("criteria")}>
            <BookOpen size={16} />
          </IconButton>
        ) : (
          <IconButton label="Extraction template" onClick={() => onOpen("template")}>
            <FileCog size={16} />
          </IconButton>
        )}
        <IconButton label="Keyboard shortcuts" kbd="?" onClick={() => onOpen("shortcuts")}>
          <Keyboard size={16} />
        </IconButton>
        <Menu trigger={<IconButton label="Theme"><ThemeIcon size={16} /></IconButton>}>
          <MenuItem icon={<Sun size={14} />} onSelect={() => set({ theme: "light" })} hint={theme === "light" ? "✓" : undefined}>
            Light
          </MenuItem>
          <MenuItem icon={<Moon size={14} />} onSelect={() => set({ theme: "dark" })} hint={theme === "dark" ? "✓" : undefined}>
            Dark
          </MenuItem>
          <MenuItem icon={<Monitor size={14} />} onSelect={() => set({ theme: "system" })} hint={theme === "system" ? "✓" : undefined}>
            System
          </MenuItem>
        </Menu>
        <Menu trigger={<IconButton label="Settings & data"><Settings size={16} /></IconButton>}>
          <MenuItem icon={<Settings size={14} />} onSelect={() => onOpen("settings")}>
            Settings, AI & backup…
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<FileDown size={14} />} onSelect={() => (window.location.href = "/api/export.csv")}>
            Export screening results (CSV)
          </MenuItem>
          <MenuItem icon={<FileDown size={14} />} disabled={!tpl?.active} onSelect={() => (window.location.href = xapi.exportUrl("zip"))}>
            Export extracted data (ZIP)
          </MenuItem>
          <MenuItem icon={<Database size={14} />} onSelect={() => (window.location.href = "/api/backup")}>
            Download backup (JSON)
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}

function StageButton({
  stage,
  current,
  index,
  label,
  progress,
  count,
  tip,
  ready,
  onClick,
}: {
  stage: Stage;
  current: Stage;
  index: number;
  label: string;
  progress: number;
  count: string;
  tip: string;
  ready?: boolean;
  onClick: () => void;
}) {
  const active = stage === current;
  return (
    <Tip content={ready ? `Screening is complete — proceed to data extraction. ${tip}` : tip}>
      <button
        onClick={onClick}
        aria-current={active ? "step" : undefined}
        className={cx(
          "relative flex items-center gap-2 rounded-lg px-2.5 py-1 text-left transition-colors",
          active ? "bg-surface shadow-sm ring-1 ring-line" : "text-ink-3 hover:text-ink-2",
        )}
      >
        <span
          className={cx(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold",
            active ? "bg-accent text-white" : progress === 100 ? "bg-emerald-500 text-white" : "bg-line-strong text-surface",
          )}
        >
          {index}
        </span>
        <span className="leading-tight">
          <span className={cx("block text-[12.5px] font-semibold", active ? "text-ink" : "")}>{label}</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-14 overflow-hidden rounded-full bg-line">
              <span className={cx("block h-full rounded-full", progress === 100 ? "bg-emerald-500" : "bg-accent")} style={{ width: `${progress}%` }} />
            </span>
            <span className="text-[10.5px] tabular-nums text-ink-3">{count}</span>
          </span>
        </span>
        {ready && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-accent ring-2 ring-surface" />}
      </button>
    </Tip>
  );
}
