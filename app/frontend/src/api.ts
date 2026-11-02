import type { AppStatus, Criteria, Decision, DecisionRecord, Evidence, PaperDetail, PaperSummary, Rect, Stance } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => request<AppStatus>("GET", "/api/status"),
  criteria: () => request<Criteria>("GET", "/api/criteria"),
  papers: () => request<PaperSummary[]>("GET", "/api/papers"),
  paper: (id: string) => request<PaperDetail>("GET", `/api/papers/${encodeURIComponent(id)}`),
  pdfUrl: (id: string, download = false) => `/api/papers/${encodeURIComponent(id)}/pdf${download ? "?download=1" : ""}`,
  analyze: (id: string, force = false) => request<{ queued: boolean; message: string }>("POST", `/api/papers/${encodeURIComponent(id)}/analyze`, { force }),
  analyzeAll: () => request<{ queued: string[] }>("POST", "/api/analyze-all", {}),
  testAi: () => request<{ ok: boolean; message: string }>("POST", "/api/ai/test"),
  setDecision: (id: string, decision: Decision, code?: string | null, reason?: string | null) =>
    request<DecisionRecord>("PUT", `/api/papers/${encodeURIComponent(id)}/decision`, { decision, code, reason }),
  clearDecision: (id: string) => request<{ cleared: boolean }>("DELETE", `/api/papers/${encodeURIComponent(id)}/decision`),
  setNotes: (id: string, body: string) => request<{ body: string; updated_at: string }>("PUT", `/api/papers/${encodeURIComponent(id)}/notes`, { body }),
  addEvidence: (
    id: string,
    data: { criterion_id: string; stance: Stance; quote: string; page: number; explanation?: string; selection_rects?: Rect[] },
  ) => request<Evidence>("POST", `/api/papers/${encodeURIComponent(id)}/evidence`, data),
  patchEvidence: (eid: string, data: Partial<Pick<Evidence, "dismissed" | "explanation" | "criterion_id" | "stance">>) =>
    request<Evidence>("PATCH", `/api/evidence/${eid}`, data),
  deleteEvidence: (eid: string) => request<{ deleted: boolean }>("DELETE", `/api/evidence/${eid}`),
  sync: () => request<{ papers: number; with_pdf: number }>("POST", "/api/sync"),
  restore: (file: File, mode: "merge" | "replace") => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ restored: Record<string, number> }>("POST", `/api/restore?mode=${mode}`, fd);
  },
};
