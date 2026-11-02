import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Rect } from "./types";

export type Theme = "light" | "dark" | "system";
export type DecisionFilter = "all" | "unscreened" | "include" | "exclude" | "maybe";
export type PdfFilter = "all" | "available" | "missing";
export type AiFilter = "all" | "analysed" | "pending" | "outdated" | "failed" | "suggest_include" | "suggest_exclude" | "suggest_maybe";

export interface PendingSelection {
  text: string;
  page: number;
  rects: Rect[];
  /** viewport position for the floating action button */
  x: number;
  y: number;
}

interface UiState {
  // persisted preferences
  theme: Theme;
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  showHighlights: boolean;
  showInclude: boolean;
  showExclude: boolean;
  showUncertain: boolean;
  showDismissed: boolean;
  autoAdvance: boolean;
  selectedId: string | null;
  decisionFilter: DecisionFilter;
  pdfFilter: PdfFilter;
  aiFilter: AiFilter;
  rightTab: "criteria" | "evidence";
  // session state
  search: string;
  activeEvidenceId: string | null;
  focusNonce: number;
  pendingSelection: PendingSelection | null;
  addEvidenceFor: { criterionId?: string } | null;

  set: (patch: Partial<UiState>) => void;
  select: (id: string | null) => void;
  focusEvidence: (id: string | null) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: "system",
      leftOpen: true,
      rightOpen: true,
      leftWidth: 320,
      rightWidth: 440,
      showHighlights: true,
      showInclude: true,
      showExclude: true,
      showUncertain: true,
      showDismissed: false,
      autoAdvance: true,
      selectedId: null,
      decisionFilter: "all",
      pdfFilter: "all",
      aiFilter: "all",
      rightTab: "criteria",
      search: "",
      activeEvidenceId: null,
      focusNonce: 0,
      pendingSelection: null,
      addEvidenceFor: null,

      set: (patch) => set(patch),
      select: (id) => set({ selectedId: id, activeEvidenceId: null, pendingSelection: null, addEvidenceFor: null }),
      focusEvidence: (id) => set((s) => ({ activeEvidenceId: id, focusNonce: s.focusNonce + 1 })),
    }),
    {
      name: "screening-ui",
      partialize: (s) => ({
        theme: s.theme,
        leftOpen: s.leftOpen,
        rightOpen: s.rightOpen,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        showHighlights: s.showHighlights,
        showInclude: s.showInclude,
        showExclude: s.showExclude,
        showUncertain: s.showUncertain,
        showDismissed: s.showDismissed,
        autoAdvance: s.autoAdvance,
        selectedId: s.selectedId,
        decisionFilter: s.decisionFilter,
        pdfFilter: s.pdfFilter,
        aiFilter: s.aiFilter,
        rightTab: s.rightTab,
      }),
    },
  ),
);
