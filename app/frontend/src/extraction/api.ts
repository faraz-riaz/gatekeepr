import { request } from "../api";
import type { Rect } from "../types";
import type {
  ActiveTemplate,
  ExtractionDetail,
  ExtractionEvidence,
  ExtractionPaperSummary,
  ExtractionRecord,
  ExtractionTemplate,
  TemplateImpact,
  ValueStatus,
  ValueTarget,
} from "./types";

const xp = (id: string) => `/api/extraction/papers/${encodeURIComponent(id)}`;

export interface ValuePayload {
  action: "accept" | "reject" | "edit" | "note" | "reset" | "use_conflict" | "dismiss_conflict";
  status?: ValueStatus | null;
  value?: unknown;
  unit?: string;
  context?: string;
  note?: string;
}

export const xapi = {
  template: () =>
    request<{ active: ActiveTemplate | null; versions: { version: number; name: string; created_at: string; source_filename: string | null }[] }>(
      "GET",
      "/api/extraction/template",
    ),
  exampleTemplate: () => request<ExtractionTemplate>("GET", "/api/extraction/template/example"),
  importTemplate: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ template: ExtractionTemplate; warnings: string[]; source_filename: string }>("POST", "/api/extraction/template/import", fd);
  },
  previewTemplate: (template: ExtractionTemplate) => request<TemplateImpact>("POST", "/api/extraction/template/preview", { template }),
  saveTemplate: (template: ExtractionTemplate, source_filename?: string | null) =>
    request<ActiveTemplate>("PUT", "/api/extraction/template", { template, source_filename }),
  templateDownloadUrl: (format: "json" | "xlsx") => `/api/extraction/template/download?format=${format}`,

  papers: () => request<{ template_version: number | null; papers: ExtractionPaperSummary[] }>("GET", "/api/extraction/papers"),
  paper: (id: string) => request<ExtractionDetail>("GET", xp(id)),
  run: (id: string) => request<{ queued: boolean; message: string }>("POST", `${xp(id)}/run`),
  runAll: () => request<{ queued: string[] }>("POST", "/api/extraction/run-all"),

  upsertValue: (id: string, target: ValueTarget, payload: ValuePayload) =>
    request<{ value_id: string }>("PUT", `${xp(id)}/values`, { ...target, ...payload }),
  patchValue: (valueId: string, payload: ValuePayload) => request<{ value_id: string }>("PATCH", `/api/extraction/values/${valueId}`, payload),
  acceptVerified: (id: string) => request<{ accepted: number }>("POST", `${xp(id)}/accept-verified`),
  acceptAll: (id: string) => request<{ accepted: number; value_ids: string[] }>("POST", `${xp(id)}/accept-all`),
  undoAccept: (id: string, value_ids: string[]) => request<{ reverted: number }>("POST", `${xp(id)}/undo-accept`, { value_ids }),

  addRecord: (id: string, group_id: string, label = "") => request<ExtractionRecord>("POST", `${xp(id)}/records`, { group_id, label }),
  patchRecord: (recordId: string, data: { label?: string; deleted?: boolean; sort_order?: number }) =>
    request<ExtractionRecord>("PATCH", `/api/extraction/records/${recordId}`, data),

  addEvidence: (id: string, target: ValueTarget, data: { quote: string; page: number; selection_rects?: Rect[] }) =>
    request<ExtractionEvidence>("POST", `${xp(id)}/evidence`, { ...target, ...data }),
  patchEvidence: (evidenceId: string, removed: boolean) =>
    request<ExtractionEvidence>("PATCH", `/api/extraction/evidence/${evidenceId}?removed=${removed}`),
  deleteEvidence: (evidenceId: string) => request<{ deleted: boolean }>("DELETE", `/api/extraction/evidence/${evidenceId}`),
  reverify: (id: string) => request<{ verified: number; unverified: number }>("POST", `${xp(id)}/reverify`),

  setNotes: (id: string, body: string) => request<{ body: string; updated_at: string }>("PUT", `${xp(id)}/notes`, { body }),
  complete: (id: string, completed: boolean, force = false) =>
    request<{ completed: boolean; warnings: string[] }>("POST", `${xp(id)}/complete`, { completed, force }),
  exportUrl: (format: "zip" | "json", opts: { reviewedOnly?: boolean; includeIneligible?: boolean } = {}) =>
    `/api/extraction/export.${format}?reviewed_only=${!!opts.reviewedOnly}&include_ineligible=${!!opts.includeIneligible}`,
};
