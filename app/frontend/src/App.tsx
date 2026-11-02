import { FileText, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { AddEvidenceDialog } from "./components/AddEvidenceDialog";
import { decisionControls } from "./components/DecisionBar";
import { CriteriaDialog, SettingsDialog, ShortcutsDialog } from "./components/Dialogs";
import { EvidencePanel } from "./components/EvidencePanel";
import { PaperNavigator } from "./components/PaperNavigator";
import { MissingPdf, PdfViewer } from "./components/PdfViewer";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { IconButton, Spinner } from "./components/ui";
import { useAnalyze, useNavigation, usePaper, usePapers, useStatus } from "./hooks";
import { isTypingTarget } from "./lib/format";
import { viewerControls } from "./lib/pdfjs";
import { useUi } from "./store";

function useTheme() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches));
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
}

export default function App() {
  useTheme();
  const ui = useUi();
  const { data: papers } = usePapers();
  const { data: status } = useStatus();
  const { step, nextUnscreened } = useNavigation();
  const analyze = useAnalyze();
  const [dialog, setDialog] = useState<null | "criteria" | "shortcuts" | "settings">(null);

  // select something sensible on first load (resume previous paper if it still exists)
  useEffect(() => {
    if (!papers?.length) return;
    if (!ui.selectedId || !papers.some((p) => p.paper_id === ui.selectedId)) {
      const first = papers.find((p) => !p.decision) ?? papers[0];
      ui.select(first.paper_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [papers?.length]);

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && viewerControls.focusSearch) {
        e.preventDefault();
        viewerControls.focusSearch();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || dialog) return;
      if (document.querySelector("[role=dialog]")) return;
      const s = useUi.getState();
      const k = e.key;
      const map: Record<string, () => void> = {
        i: () => decisionControls.decide?.("include"),
        e: () => decisionControls.decide?.("exclude"),
        m: () => decisionControls.decide?.("maybe"),
        j: () => step(1),
        k: () => step(-1),
        n: () => nextUnscreened(),
        a: () => {
          if (s.selectedId && status?.ai.available) analyze.mutate({ id: s.selectedId });
        },
        h: () => s.set({ showHighlights: !s.showHighlights }),
        g: () => s.set({ showInclude: !s.showInclude, showHighlights: true }),
        r: () => s.set({ showExclude: !s.showExclude, showHighlights: true }),
        u: () => s.set({ showUncertain: !s.showUncertain, showHighlights: true }),
        ".": () => viewerControls.nextHighlight?.(),
        ",": () => viewerControls.prevHighlight?.(),
        "[": () => s.set({ leftOpen: !s.leftOpen }),
        "]": () => s.set({ rightOpen: !s.rightOpen }),
        "+": () => viewerControls.zoomIn?.(),
        "=": () => viewerControls.zoomIn?.(),
        "-": () => viewerControls.zoomOut?.(),
        "0": () => viewerControls.fitWidth?.(),
        "?": () => setDialog("shortcuts"),
        Escape: () => s.set({ pendingSelection: null, addEvidenceFor: null }),
      };
      const fn = map[k] ?? map[k.toLowerCase()];
      if (fn && !(k.length === 1 && k !== k.toLowerCase() && /[a-z]/i.test(k))) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, nextUnscreened, analyze, status?.ai.available, dialog]);

  return (
    <div className="flex h-full flex-col">
      <TopBar onOpen={setDialog} />
      <div className="flex min-h-0 flex-1">
        <Sidebar side="left" open={ui.leftOpen} width={ui.leftWidth} min={240} max={520} onWidth={(w) => ui.set({ leftWidth: w })}>
          <PaperNavigator />
        </Sidebar>
        <main className="relative min-w-0 flex-1">
          <Workspace />
        </main>
        <Sidebar side="right" open={ui.rightOpen} width={ui.rightWidth} min={340} max={720} onWidth={(w) => ui.set({ rightWidth: w })}>
          <EvidencePanel />
        </Sidebar>
      </div>
      <AddEvidenceDialog />
      <ShortcutsDialog open={dialog === "shortcuts"} onOpenChange={(v) => setDialog(v ? "shortcuts" : null)} />
      <CriteriaDialog open={dialog === "criteria"} onOpenChange={(v) => setDialog(v ? "criteria" : null)} />
      <SettingsDialog open={dialog === "settings"} onOpenChange={(v) => setDialog(v ? "settings" : null)} />
    </div>
  );
}

function Workspace() {
  const selectedId = useUi((s) => s.selectedId);
  const leftOpen = useUi((s) => s.leftOpen);
  const rightOpen = useUi((s) => s.rightOpen);
  const set = useUi((s) => s.set);
  const { data: detail, isLoading, error } = usePaper(selectedId);

  const reopen = (
    <div className="absolute left-2 top-2 z-10 flex gap-1">
      {!leftOpen && (
        <IconButton label="Show paper list" kbd="[" onClick={() => set({ leftOpen: true })} className="bg-surface shadow">
          <PanelLeftOpen size={16} />
        </IconButton>
      )}
      {!rightOpen && (
        <IconButton label="Show evidence panel" kbd="]" onClick={() => set({ rightOpen: true })} className="bg-surface shadow">
          <PanelRightOpen size={16} />
        </IconButton>
      )}
    </div>
  );

  if (!selectedId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-viewer text-ink-3">
        <FileText size={28} />
        <div className="text-[13px]">Select a paper from the list to start screening.</div>
      </div>
    );
  }
  if (error) {
    return <div className="flex h-full items-center justify-center bg-viewer p-6 text-rose-600">Could not load paper: {(error as Error).message}</div>;
  }
  if (isLoading || !detail || detail.paper.paper_id !== selectedId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-viewer text-ink-3">
        <Spinner /> Loading…
      </div>
    );
  }
  if (!detail.paper.pdf_available) {
    return (
      <div className="relative h-full">
        {reopen}
        <MissingPdf detail={detail} />
      </div>
    );
  }
  return <PdfViewer detail={detail} />;
}
