/** 领域事件信封。 */
export interface DomainEvent<T = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: T;
}

export type AggregateType =
  | "biological_material"
  | "culture_passage"
  | "experiment_run"
  | "research_claim"
  | "transfer_agreement"
  | "personnel";

export type MaterialState = "available" | "frozen" | "discarded" | "unknown";

export type FreezeReason = "mix_up" | "contamination" | "label_dispute";

export interface MaterialStatus {
  state: MaterialState;
  reason?: string;
  frozen_at_branch?: string;
}

export type RunOutcome = "success" | "failed";

export type RetentionClass = "standard" | "failed_retained" | "long_term";

/** 对外转移必须核对的条款：用途、期限、署名、再分发限制。 */
export interface TransferTerms {
  purpose: string;
  term_end: string;
  attribution: string;
  redistribution_allowed: boolean;
}
