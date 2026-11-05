import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useUi } from "../store";
import { xapi, type ValuePayload } from "./api";
import type { ExtractionDetail, ExtractionPaperSummary, ValueTarget } from "./types";

const ACTIVE = new Set(["queued", "running"]);

export function useTemplate() {
  return useQuery({ queryKey: ["x-template"], queryFn: xapi.template, staleTime: 30_000 });
}

export function useXPapers() {
  return useQuery({
    queryKey: ["x-papers"],
    queryFn: xapi.papers,
    refetchInterval: (q) => ((q.state.data as { papers: ExtractionPaperSummary[] } | undefined)?.papers.some((p) => ACTIVE.has(p.status)) ? 2500 : false),
  });
}

export function useXPaper(id: string | null) {
  return useQuery({
    queryKey: ["x-paper", id],
    queryFn: () => xapi.paper(id!),
    enabled: !!id,
    refetchInterval: (q) => ((q.state.data as ExtractionDetail | undefined)?.job ? 2000 : false),
  });
}

export function useXInvalidate() {
  const qc = useQueryClient();
  return useCallback(
    (id?: string | null) => {
      if (id) qc.invalidateQueries({ queryKey: ["x-paper", id] });
      qc.invalidateQueries({ queryKey: ["x-papers"] });
    },
    [qc],
  );
}

/** Edit a value: by id when it exists, otherwise by target (creating record/value rows as needed). */
export function useValueAction(paperId: string) {
  const invalidate = useXInvalidate();
  return useMutation({
    mutationFn: (v: { valueId?: string | null; target?: ValueTarget; payload: ValuePayload }) =>
      v.valueId ? xapi.patchValue(v.valueId, v.payload) : xapi.upsertValue(paperId, v.target!, v.payload),
    onSuccess: () => invalidate(paperId),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function matchesXFilter(p: ExtractionPaperSummary, filter: string, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q) {
    const hay = `${p.paper_id} ${p.title ?? ""} ${p.authors ?? ""} ${p.doi ?? ""} ${p.year ?? ""}`.toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  switch (filter) {
    case "todo":
      return p.status === "not_started" || ACTIVE.has(p.status);
    case "review":
      return p.status === "awaiting_review" || p.status === "in_progress" || p.status === "ready";
    case "done":
      return p.status === "completed";
    case "attention":
      return p.flags.length > 0 || p.counts.unverified > 0 || p.counts.required_missing > 0;
  }
  return true;
}

export function useXFiltered() {
  const { data } = useXPapers();
  const search = useUi((s) => s.search);
  const filter = useUi((s) => s.xFilter);
  return useMemo(() => {
    const all = data?.papers ?? [];
    const eligible = all.filter((p) => p.eligible && matchesXFilter(p, filter, search));
    const former = all.filter((p) => !p.eligible && matchesXFilter(p, filter === "attention" ? "all" : filter, search));
    return { eligible, former, all };
  }, [data, search, filter]);
}

export function useXNavigation() {
  const { eligible, all } = useXFiltered();
  const selected = useUi((s) => s.xSelectedId);
  const select = useUi((s) => s.selectExtraction);

  const step = useCallback(
    (dir: 1 | -1) => {
      const list = eligible.length ? eligible : all.filter((p) => p.eligible);
      if (!list.length) return;
      const i = list.findIndex((p) => p.paper_id === selected);
      const next = i < 0 ? list[0] : list[Math.min(list.length - 1, Math.max(0, i + dir))];
      if (next) select(next.paper_id);
    },
    [eligible, all, selected, select],
  );

  const nextOpen = useCallback(() => {
    const list = all.filter((p) => p.eligible);
    const start = list.findIndex((p) => p.paper_id === selected);
    for (let k = 1; k <= list.length; k++) {
      const p = list[(start + k + list.length) % list.length];
      if (p && p.status !== "completed" && p.paper_id !== selected) {
        select(p.paper_id);
        return true;
      }
    }
    toast.success("Every included paper has a completed extraction");
    return false;
  }, [all, selected, select]);

  return { step, nextOpen };
}
