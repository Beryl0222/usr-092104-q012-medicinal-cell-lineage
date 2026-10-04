/** 领域事件类型（与 contracts/domain.schema.json 枚举一致）。 */
export type DomainEventType =
  | "MATERIAL_ACCESSIONED"
  | "PASSAGE_RECORDED"
  | "MATERIAL_ALIQUOTED"
  | "MATERIAL_POOLED"
  | "CONSTRUCT_INTRODUCED"
  | "QC_PERFORMED"
  | "LINEAGE_QUARANTINED"
  | "LINEAGE_RELEASED"
  | "LABEL_DISPUTE_FILED"
  | "LABEL_DISPUTE_RESOLVED"
  | "RUN_COMPLETED"
  | "ARTIFACT_VERSIONED"
  | "CLAIM_REGISTERED"
  | "CLAIM_WITHDRAWN"
  | "TRANSFER_APPROVED"
  | "MATERIAL_SHIPPED"
  | "MATERIAL_RECEIVED"
  | "PERSONNEL_DEPARTURE_CHECKED"
  | "RETENTION_POLICY_DECLARED";

export type AggregateType =
  | "biological_material"
  | "culture_passage"
  | "gene_construct"
  | "experiment_run"
  | "data_artifact"
  | "research_claim"
  | "material_transfer"
  | "label_dispute"
  | "personnel_record"
  | "retention_policy";

/** 材料转移条款四要素。 */
export interface TransferTerms {
  /** 核定用途 */
  intended_use: string;
  /** 使用期限截止日 YYYY-MM-DD */
  valid_until: string;
  /** 署名与来源标注要求 */
  attribution: string;
  /** 再分发限制 */
  redistribution: "prohibited" | "allowed_with_written_consent";
  extra_restrictions?: string[];
}

/** 跨实验室交换的领域事件信封（七个必填字段为最低交换边界，其余可选向后兼容）。 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  /** 事实实际发生时间（纸质记录补录时可为过去时间，RFC3339）。 */
  occurred_at: string;
  /** 录入本系统的时间；补录历史笔记时与 occurred_at 区分。 */
  recorded_at?: string;
  /** 同一 aggregate_id 内严格递增，只追加、不回改。 */
  version: number;
  summary: string;
  /** 来源实验室。 */
  lab_id?: string;
  /** 证据出处备注（纸质册卷页、冻存盒、转录人）。 */
  source_note?: string;
  /** 按 event_type 定义的类型化载荷，见 contracts/payloads.schema.json。 */
  payload?: TPayload;
}
