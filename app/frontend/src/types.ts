export type Decision = "include" | "exclude" | "maybe";
export type AnalysisState =
  | "no_pdf"
  | "queued"
  | "running"
  | "complete"
  | "outdated"
  | "failed"
  | "no_text"
  | "pending";
export type Stance = "supports" | "contradicts" | "ambiguous";
export type Polarity = "include" | "exclude" | "uncertain";
export type CriterionStatus =
  | "met"
  | "not_met"
  | "unclear"
  | "not_applicable"
  | "triggered"
  | "not_triggered"
  | "not_found";

export interface PaperSummary {
  paper_id: string;
  order: number;
  title: string | null;
  authors: string | null;
  year: string | null;
  doi: string | null;
  pdf_available: boolean;
  access_status: string | null;
  duplicate_of: string | null;
  decision: Decision | null;
  decision_code: string | null;
  decided_at: string | null;
  ai_decision: Decision | null;
  ai_code: string | null;
  analysis_state: AnalysisState;
  evidence_counts: Partial<Record<Polarity, number>>;
  has_notes: boolean;
}

/** [page, x0, y0, x1, y1] in PDF user space */
export type Rect = [number, number, number, number, number];

export interface Evidence {
  id: string;
  paper_id: string;
  analysis_id: number | null;
  origin: "ai" | "manual";
  criterion_id: string;
  stance: Stance;
  polarity: Polarity;
  quote: string;
  model_quote: string | null;
  page: number;
  rects: Rect[];
  explanation: string | null;
  match_method: string | null;
  match_score: number | null;
  dismissed: boolean;
  created_at: string;
  updated_at: string;
}

export interface Assessment {
  status: CriterionStatus;
  model_status: string | null;
  justification: string;
  notes: string[];
  route?: string;
}

export interface Recommendation {
  decision: Decision;
  code: string;
  explanation: string;
  unresolved: string[];
  violated: string[];
  triggered: string[];
  model_decision: Decision | null;
  model_code: string | null;
  agrees_with_model: boolean | null;
}

export interface LegacyInputProfile {
  leads: string;
  sampling_rate: string;
  duration: string;
  source_heterogeneity: string;
  processing: string;
  model_accepts: string;
  compatibility_method: string;
}

export interface StudyCharacteristic {
  label: string;
  value: string;
}

export interface Analysis {
  id: number;
  provider: string;
  model: string;
  created_at: string;
  completed_at: string;
  result: {
    study_summary: string;
    study_characteristics?: StudyCharacteristic[];
    /** Present only in analyses created by the original review-specific schema. */
    contribution_type?: string;
    input_profile?: LegacyInputProfile;
    assessments: Record<string, Assessment>;
    model_rationale: string;
    model_decision: Decision;
    model_code: string;
  };
  recommendation: Recommendation;
  rejected: { criterion_id: string; stance: string; page: number; quote: string; explanation: string; reason: string }[];
  stats: {
    chunks: number;
    chars: number;
    quotes_total: number;
    quotes_verified: number;
    quotes_rejected: number;
    fuzzy_matches: number;
    duration_s: number;
  };
  outdated_reason: string | null;
}

export interface DecisionRecord {
  paper_id: string;
  decision: Decision;
  code: string | null;
  reason: string | null;
  decided_at: string;
  ai_decision: Decision | null;
  ai_code: string | null;
}

export interface PaperDetail {
  paper: {
    paper_id: string;
    order: number;
    title: string | null;
    authors: string | null;
    year: string | null;
    doi: string | null;
    link: string | null;
    pmid: string | null;
    pmcid: string | null;
    pdf_url: string | null;
    landing_page_url: string | null;
    source: string | null;
    access_status: string | null;
    license: string | null;
    duplicate_of: string | null;
    manifest_notes: string | null;
    pdf_available: boolean;
    pdf_relpath: string | null;
    pdf_checksum_ok: boolean | null;
    match_confidence: number | null;
  };
  text: { status: string; message: string | null; page_count: number; char_count: number } | null;
  analysis: Analysis | null;
  analysis_failed: { error: string; at: string } | null;
  analysis_state: AnalysisState;
  job: { state: string; stage: string; queued_at: string; started_at?: string } | null;
  evidence: Evidence[];
  decision: DecisionRecord | null;
  decision_history: { decision: string; code: string | null; reason: string | null; decided_at: string; ai_decision: string | null }[];
  notes: { body: string; updated_at: string } | null;
}

export interface SubRequirement {
  id: string;
  text: string;
  kind: "all_required" | "route";
}

export interface Criterion {
  id: string;
  name: string;
  definition: string;
  sub_requirements?: SubRequirement[];
}

export interface Criteria {
  source_file: string;
  title: string;
  core_rule: string | null;
  inclusion_rule: string | null;
  exclusion_rule: string | null;
  do_not_exclude: string | null;
  if_uncertain: string | null;
  inclusion: Criterion[];
  exclusion: Criterion[];
  unretrieved: { id: string; name: string; definition: string }[];
  content_hash: string;
  full_text: string;
}

export interface AppStatus {
  ai: {
    available: boolean;
    provider: string | null;
    model: string | null;
    status: string;
    check: { ok: boolean; message: string; at: string } | null;
    concurrency: number;
  };
  criteria: { ok: boolean; error: string | null; hash: string | null; file: string };
  analysis_version: string;
  paths: Record<string, string>;
  last_sync: string | null;
  jobs: Record<string, { state: string; stage: string }>;
}

/** Flattened lookup of every criterion / sub-requirement by ID */
export interface CriterionInfo {
  id: string;
  kind: "inclusion" | "exclusion";
  name: string;
  definition: string;
  parent: string | null;
}
