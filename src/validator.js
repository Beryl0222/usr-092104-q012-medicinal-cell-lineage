export const EVENT_TYPES = [
  "MATERIAL_ACCESSIONED",
  "PASSAGE_RECORDED",
  "ALIQUOT_CREATED",
  "CONSTRUCT_INTRODUCED",
  "CONTAMINATION_CHECK_RECORDED",
  "BRANCH_FROZEN",
  "BRANCH_RELEASED",
  "MATERIAL_DISCARDED",
  "RUN_COMPLETED",
  "RAW_DATA_REGISTERED",
  "ANALYSIS_VERSIONED",
  "INTERPRETATION_VERSIONED",
  "CLAIM_REGISTERED",
  "TRANSFER_APPROVED",
  "TRANSFER_WITHDRAWN",
  "PERSONNEL_AUTHORIZED",
  "PERSONNEL_AUTHORIZATION_REVOKED",
  "PERSONNEL_OFFBOARDED",
];

export const AGGREGATE_TYPES = [
  "biological_material",
  "culture_passage",
  "experiment_run",
  "research_claim",
  "transfer_agreement",
  "personnel",
];

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export function validateEvent(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["事件必须是对象"];
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) errors.push("occurred_at 必须是可解析的时间");
  if ("payload" in record && (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  return errors;
}
