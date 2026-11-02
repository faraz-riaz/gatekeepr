import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Database, FileDown, Keyboard, Monitor, Moon, Settings, Sparkles, Sun, Unplug } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useCriteria, usePapers, useStatus } from "../hooks";
import { useUi } from "../store";
import { Button, IconButton, Menu, MenuItem, MenuSeparator, Spinner, Tip } from "./ui";

export function TopBar({ onOpen }: { onOpen: (d: "criteria" | "shortcuts" | "settings") => void }) {
  const { data: papers } = usePapers();
  const { data: status } = useStatus();
  const { data: criteria } = useCriteria();
  const theme = useUi((s) => s.theme);
  const set = useUi((s) => s.set);
  const qc = useQueryClient();

  const s = useMemo(() => {
    const all = papers ?? [];
    const screened = all.filter((p) => p.decision).length;
    const toAnalyse = all.filter((p) => ["pending", "outdated", "failed"].includes(p.analysis_state)).length;
    const running = all.filter((p) => p.analysis_state === "running" || p.analysis_state === "queued").length;
    return { total: all.length, screened, toAnalyse, running, pct: all.length ? Math.round((screened / all.length) * 100) : 0 };
  }, [papers]);

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

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="min-w-0 leading-tight">
          <div className="text-[13.5px] font-semibold tracking-tight">GateKeepr</div>
          <div className="truncate text-[11px] text-ink-3">{criteria ? criteria.title.split("—").pop()?.trim() : "Scoping review"}</div>
        </div>
      </div>

      <Tip content={`${s.screened} of ${s.total} papers have a human decision`}>
        <div className="mx-auto hidden w-full max-w-sm items-center gap-3 md:flex">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${s.pct}%` }} />
          </div>
          <span className="shrink-0 text-[12px] tabular-nums text-ink-2">
            <span className="font-semibold text-ink">{s.screened}</span> / {s.total} screened · {s.pct}%
          </span>
        </div>
      </Tip>

      <div className="ml-auto flex items-center gap-1.5 md:ml-0">
        {status?.ai.available && status.ai.check?.ok === false ? (
          <Tip content={status.ai.check.message}>
            <button
              onClick={() => onOpen("settings")}
              className="hidden items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11.5px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 lg:inline-flex"
            >
              <Unplug size={12} /> AI connection failed
            </button>
          </Tip>
        ) : status?.ai.available ? (
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
        ) : (
          status && (
            <Tip content={status.ai.status}>
              <span className="hidden cursor-help rounded-md border border-dashed border-line-strong px-2 py-1 text-[11.5px] text-ink-3 lg:inline">AI unavailable · manual mode</span>
            </Tip>
          )
        )}
        <Button size="sm" variant="primary" onClick={() => (window.location.href = "/api/export.csv")}>
          <FileDown size={14} /> Export screening results
        </Button>
        <IconButton label="Eligibility criteria" onClick={() => onOpen("criteria")}>
          <BookOpen size={16} />
        </IconButton>
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
          <MenuItem icon={<Database size={14} />} onSelect={() => (window.location.href = "/api/backup")}>
            Download backup (JSON)
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}
