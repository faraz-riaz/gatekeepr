import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { DECISION_LABEL, flattenCriteria } from "./lib/format";
import { useUi } from "./store";
import type { Decision, PaperDetail, PaperSummary } from "./types";

const ACTIVE = new Set(["queued", "running"]);

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: api.status, staleTime: 10_000, refetchInterval: 15_000 });
}

export function useCriteria() {
  const q = useQuery({ queryKey: ["criteria"], queryFn: api.criteria, staleTime: 60_000, retry: 1 });
  const map = useMemo(() => flattenCriteria(q.data), [q.data]);
  return { ...q, map };
}

export function usePapers() {
  return useQuery({
    queryKey: ["papers"],
    queryFn: api.papers,
    refetchInterval: (q) => ((q.state.data as PaperSummary[] | undefined)?.some((p) => ACTIVE.has(p.analysis_state)) ? 2500 : false),
  });
}

export function usePaper(id: string | null) {
  return useQuery({
    queryKey: ["paper", id],
    queryFn: () => api.paper(id!),
    enabled: !!id,
    refetchInterval: (q) => {
      const d = q.state.data as PaperDetail | undefined;
      return d && ACTIVE.has(d.analysis_state) ? 2000 : false;
    },
  });
}

export function matchesFilters(p: PaperSummary, s: ReturnType<typeof useUi.getState>): boolean {
  const q = s.search.trim().toLowerCase();
  if (q) {
    const hay = `${p.paper_id} ${p.title ?? ""} ${p.authors ?? ""} ${p.doi ?? ""} ${p.year ?? ""}`.toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  switch (s.decisionFilter) {
    case "unscreened":
      if (p.decision) return false;
      break;
    case "include":
    case "exclude":
    case "maybe":
      if (p.decision !== s.decisionFilter) return false;
  }
  if (s.pdfFilter === "available" && !p.pdf_available) return false;
  if (s.pdfFilter === "missing" && p.pdf_available) return false;
  switch (s.aiFilter) {
    case "analysed":
      return p.analysis_state === "complete" || p.analysis_state === "outdated";
    case "pending":
      return p.analysis_state === "pending" || ACTIVE.has(p.analysis_state);
    case "outdated":
      return p.analysis_state === "outdated";
    case "failed":
      return p.analysis_state === "failed" || p.analysis_state === "no_text";
    case "suggest_include":
      return p.ai_decision === "include";
    case "suggest_exclude":
      return p.ai_decision === "exclude";
    case "suggest_maybe":
      return p.ai_decision === "maybe";
  }
  return true;
}

export function useFilteredPapers() {
  const { data } = usePapers();
  const search = useUi((s) => s.search);
  const decisionFilter = useUi((s) => s.decisionFilter);
  const pdfFilter = useUi((s) => s.pdfFilter);
  const aiFilter = useUi((s) => s.aiFilter);
  return useMemo(() => {
    const s = useUi.getState();
    return (data ?? []).filter((p) => matchesFilters(p, s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, decisionFilter, pdfFilter, aiFilter]);
}

export function useNavigation() {
  const { data: all } = usePapers();
  const filtered = useFilteredPapers();
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);

  const step = useCallback(
    (dir: 1 | -1) => {
      const list = filtered.length ? filtered : all ?? [];
      if (!list.length) return;
      const i = list.findIndex((p) => p.paper_id === selectedId);
      const next = i < 0 ? list[0] : list[Math.min(list.length - 1, Math.max(0, i + dir))];
      if (next) select(next.paper_id);
    },
    [filtered, all, selectedId, select],
  );

  const nextUnscreened = useCallback(
    (fromId?: string | null, opts?: { silent?: boolean; skip?: string }) => {
      const list = all ?? [];
      const start = list.findIndex((p) => p.paper_id === (fromId ?? selectedId));
      for (let k = 1; k <= list.length; k++) {
        const p = list[(start + k + list.length) % list.length];
        if (p && !p.decision && p.paper_id !== opts?.skip && p.paper_id !== (fromId ?? selectedId)) {
          select(p.paper_id);
          return true;
        }
      }
      if (!opts?.silent)
        toast.success("All papers have a screening decision 🎉", {
          description: "Included papers are ready for data extraction.",
          action: { label: "Go to extraction", onClick: () => useUi.getState().setStage("extraction") },
        });
      return false;
    },
    [all, selectedId, select],
  );

  return { step, nextUnscreened };
}

export function useDecide() {
  const qc = useQueryClient();
  const { nextUnscreened } = useNavigation();
  return useMutation({
    mutationFn: (v: { id: string; decision: Decision; code?: string | null; reason?: string | null; advance?: boolean; previous?: PaperDetail["decision"] }) =>
      api.setDecision(v.id, v.decision, v.code, v.reason),
    onMutate: async (v) => {
      // Optimistic update of the navigator marker
      await qc.cancelQueries({ queryKey: ["papers"] });
      qc.setQueryData<PaperSummary[]>(["papers"], (old) =>
        old?.map((p) => (p.paper_id === v.id ? { ...p, decision: v.decision, decision_code: v.code ?? null, decided_at: new Date().toISOString() } : p)),
      );
    },
    onSuccess: (rec, v) => {
      qc.invalidateQueries({ queryKey: ["papers"] });
      qc.invalidateQueries({ queryKey: ["paper", v.id] });
      qc.invalidateQueries({ queryKey: ["x-papers"] }); // eligibility for extraction follows the decision
      toast.success(`${v.id} → ${DECISION_LABEL[v.decision].toUpperCase()}${rec.code ? ` · ${rec.code}` : ""}`, {
        description: "Decision saved",
        action: {
          label: "Undo",
          onClick: async () => {
            if (v.previous) await api.setDecision(v.id, v.previous.decision, v.previous.code, v.previous.reason);
            else await api.clearDecision(v.id);
            qc.invalidateQueries({ queryKey: ["papers"] });
            qc.invalidateQueries({ queryKey: ["paper", v.id] });
            useUi.getState().select(v.id);
          },
        },
      });
      if (v.advance) nextUnscreened(v.id, { skip: v.id });
    },
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: ["papers"] });
      toast.error(`Could not save decision: ${e.message}`);
    },
  });
}

export function useAnalyze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; force?: boolean }) => api.analyze(v.id, v.force),
    onSuccess: (_r, v) => {
      toast.info(`Analysis queued for ${v.id}`);
      qc.invalidateQueries({ queryKey: ["papers"] });
      qc.invalidateQueries({ queryKey: ["paper", v.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useInvalidatePaper() {
  const qc = useQueryClient();
  return useCallback(
    (id: string) => {
      qc.invalidateQueries({ queryKey: ["paper", id] });
      qc.invalidateQueries({ queryKey: ["papers"] });
    },
    [qc],
  );
}
