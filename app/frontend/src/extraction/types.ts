import type { Decision, PaperDetail, Rect } from "../types";

export type FieldType = "text" | "long_text" | "number" | "integer" | "categorical" | "multi_categorical" | "date" | "boolean" | "reference";

export interface TemplateField {
  id: string;
  label: string;
  type: FieldType;
  description: string;
  instructions: string;
  required: boolean;
  options: string[];
  allow_other: boolean;
  unit: string;
  target_group: string;
  multiple: boolean;
  examples: string[];
}

export interface TemplateGroup {
  id: string;
  label: string;
  description: string;
  instructions: string;
  repeatable: boolean;
  record_label: string;
  fields: TemplateField[];
}

export interface ExtractionTemplate {
  schema_version: 1;
  title: string;
  description: string;
  instructions: string;
  groups: TemplateGroup[];
}

export interface ActiveTemplate {
  version: number;
  name: string;
  template: ExtractionTemplate;
  hash: string;
  created_at: string;
  source_filename: string | null;
}

export interface TemplateImpact {
  diff: {
    added_groups: string[];
    removed_groups: string[];
    added_fields: string[];
    removed_fields: string[];
    changed_fields: { group: string; field: string; changes: string[] }[];
    repeatable_changed: string[];
    required_added: string[];
  };
  unchanged: boolean;
  impact: {
    values_in_removed_fields: number;
    papers_with_removed_values: number;
    values_in_changed_fields: number;
    papers_with_changed_values: number;
    completed_papers: number;
  };
}

export type ValueStatus = "reported" | "not_reported" | "unclear" | "not_applicable";
export type ReviewState = "pending" | "accepted" | "edited" | "rejected";
export type ExtractionStatus = "not_started" | "queued" | "running" | "awaiting_review" | "in_progress" | "ready" | "completed";

export interface ExtractionCounts {
  expected: number;
  resolved: number;
  pending: number;
  reviewed: number;
  unverified: number;
  conflicts: number;
  required_missing: number;
  records: number;
}

export interface ExtractionPaperSummary {
  paper_id: string;
  order: number;
  title: string | null;
  authors: string | null;
  year: string | null;
  doi: string | null;
  pdf_available: boolean;
  eligible: boolean;
  decision: Decision | null;
  decision_code: string | null;
  completed_at: string | null;
  has_notes: boolean;
  status: ExtractionStatus;
  flags: string[];
  counts: ExtractionCounts;
}

export interface ExtractionEvidence {
  id: string;
  paper_id: string;
  value_id: string;
  origin: "ai" | "manual";
  quote: string;
  model_quote: string | null;
  page: number | null;
  rects: Rect[];
  verified: boolean;
  match_method: string | null;
  match_score: number | null;
  value_check: "ok" | "mismatch" | "n/a" | null;
  pdf_sha256: string | null;
  removed: boolean;
  created_at: string;
}

export interface Suggestion {
  status: ValueStatus;
  value: unknown;
  unit: string;
  context: string;
  note: string;
  issues: string[];
  run_id: number;
  evidence: { verified: boolean; quote: string; page: number | null; value_check: string }[];
}

export interface ExtractionValue {
  id: string;
  record_id: string;
  group_id: string;
  field_id: string;
  status: ValueStatus | null;
  value: unknown;
  unit: string;
  context: string;
  note: string;
  origin: "ai" | "manual";
  review_state: ReviewState;
  issues: string[];
  ai: Suggestion | null;
  conflict: Suggestion | null;
  reviewed_at: string | null;
  updated_at: string;
  in_template: boolean;
  evidence: ExtractionEvidence[];
}

export interface ExtractionRecord {
  id: string;
  group_id: string;
  label: string | null;
  origin: "ai" | "manual";
  sort_order: number;
  /** 0 = live, 1 = removed by the reviewer, 2 = no longer reported by the AI */
  deleted: number;
  created_at: string;
}

export interface ExtractionRun {
  id: number;
  status: "running" | "complete" | "failed";
  provider: string | null;
  model: string | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
  template_version: number | null;
  stats: {
    quotes_total?: number;
    quotes_verified?: number;
    quotes_unverified?: number;
    value_mismatch?: number;
    records?: number;
    chunks?: number;
    duration_s?: number;
    summary?: string;
    rejected?: { group_id: string; record_key?: string; field_id?: string; reason: string }[];
  };
  outdated_reason: string | null;
}

export interface ExtractionDetail {
  paper: {
    paper_id: string;
    title: string | null;
    authors: string | null;
    year: string | null;
    doi: string | null;
    source: string | null;
    pdf_available: boolean;
    access_status: string | null;
    landing_page_url: string | null;
    pdf_url: string | null;
    link: string | null;
    manifest_notes: string | null;
    pmcid: string | null;
    duplicate_of: string | null;
  };
  decision: { decision: Decision; code: string | null; decided_at: string } | null;
  eligible: boolean;
  template_version: number | null;
  text: PaperDetail["text"];
  records: ExtractionRecord[];
  values: ExtractionValue[];
  notes: string;
  notes_updated_at: string | null;
  completed_at: string | null;
  completed_template_version: number | null;
  last_run: ExtractionRun | null;
  last_successful_run: ExtractionRun | null;
  job: { state: string; stage: string } | null;
  status: ExtractionStatus;
  flags: string[];
  counts: ExtractionCounts;
}

/** Where a value lives: a field of a record (record may not exist yet for single groups). */
export interface ValueTarget {
  group_id: string;
  field_id: string;
  record_id?: string | null;
}
