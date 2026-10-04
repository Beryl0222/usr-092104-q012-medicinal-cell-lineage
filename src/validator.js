/**
 * 领域事件信封与载荷校验（零依赖）。
 * 规则表与 contracts/*.schema.json 一一对应；tests/contract.test.js 会比对
 * 两侧的必填字段与枚举，防止契约与代码漂移。
 */

export const ENVELOPE_REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

export const KNOWN_EVENT_TYPES = [
  "MATERIAL_ACCESSIONED",
  "PASSAGE_RECORDED",
  "MATERIAL_ALIQUOTED",
  "MATERIAL_POOLED",
  "CONSTRUCT_INTRODUCED",
  "QC_PERFORMED",
  "LINEAGE_QUARANTINED",
  "LINEAGE_RELEASED",
  "LABEL_DISPUTE_FILED",
  "LABEL_DISPUTE_RESOLVED",
  "RUN_COMPLETED",
  "ARTIFACT_VERSIONED",
  "CLAIM_REGISTERED",
  "CLAIM_WITHDRAWN",
  "TRANSFER_APPROVED",
  "MATERIAL_SHIPPED",
  "MATERIAL_RECEIVED",
  "PERSONNEL_DEPARTURE_CHECKED",
  "RETENTION_POLICY_DECLARED",
];

export const KNOWN_AGGREGATE_TYPES = [
  "biological_material",
  "culture_passage",
  "gene_construct",
  "experiment_run",
  "data_artifact",
  "research_claim",
  "material_transfer",
  "label_dispute",
  "personnel_record",
  "retention_policy",
];

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KINDS = [
  "explant",
  "hairy_root_root_line",
  "passage_line",
  "transformed_line",
  "aliquot_vial",
  "pool",
];
const MATERIAL_STATES = ["available", "in_culture", "depleted", "destroyed"];
const QC_TYPES = [
  "bacterial_contamination",
  "fungal_contamination",
  "mycoplasma",
  "identity_marker",
  "viability",
  "authenticity",
  "transgene_pcr",
  "content_assay",
  "other",
];
const QC_RESULTS = ["passed", "failed", "inconclusive"];
const QUARANTINE_REASONS = ["contamination", "label_dispute", "suspect_pool", "other"];
const DISPUTE_RESOLUTIONS = ["identity_upheld", "identity_corrected"];
const RUN_OUTCOMES = ["success", "failure", "inconclusive"];
const ARTIFACT_LAYERS = ["raw_observation", "analysis", "interpretation"];
const REDISTRIBUTION = ["prohibited", "allowed_with_written_consent"];
const CLEARANCE = ["granted", "denied"];

const TERMS_RULES = {
  required: ["intended_use", "valid_until", "attribution", "redistribution"],
  dates: ["valid_until"],
  enums: { redistribution: REDISTRIBUTION },
};

const HASH_RULES = {
  required: ["alg", "value"],
  enums: { alg: ["sha256", "sha512"] },
};

const ARTIFACT_REF_ARRULE = {
  objects: { required: ["artifact_id", "version_no"], integers: ["version_no"] },
};

/**
 * 每类事件载荷的规则表：
 * - required 必填；enums 枚举；dates/datetimes 时间格式
 * - integers/booleans/plainObjects 类型检查
 * - nested 嵌套对象；arrays 数组（strings / dates / objects 子规则）
 */
export const PAYLOAD_RULES = {
  MATERIAL_ACCESSIONED: {
    required: ["material_id", "kind", "species", "custodian_lab"],
    enums: { kind: KINDS, initial_status: MATERIAL_STATES },
    arrays: {
      parent_material_ids: { strings: true },
    },
  },
  PASSAGE_RECORDED: {
    required: [
      "passage_id",
      "parent_material_id",
      "child_material_id",
      "passage_no",
      "operator_id",
    ],
    integers: ["passage_no", "duration_days"],
    datetimes: [],
    plainObjects: ["conditions"],
  },
  MATERIAL_ALIQUOTED: {
    required: ["parent_material_id", "children", "operator_id"],
    arrays: {
      children: {
        objects: { required: ["material_id", "vial_label"] },
      },
    },
  },
  MATERIAL_POOLED: {
    required: ["pool_material_id", "source_material_ids", "operator_id"],
    arrays: {
      source_material_ids: { strings: true, minItems: 2 },
    },
  },
  CONSTRUCT_INTRODUCED: {
    required: [
      "construct_id",
      "construct_name",
      "host_material_id",
      "resulting_material_id",
      "operator_id",
    ],
    nested: {
      verification: {
        required: [],
        enums: { result: ["positive", "negative", "inconclusive"] },
        arrays: { artifact_ids: { strings: true } },
      },
    },
  },
  QC_PERFORMED: {
    required: ["material_id", "qc_type", "result", "operator_id"],
    enums: { qc_type: QC_TYPES, result: QC_RESULTS },
    datetimes: ["observed_at"],
    arrays: { artifact_ids: { strings: true } },
  },
  LINEAGE_QUARANTINED: {
    required: ["subtree_root_material_id", "reason"],
    enums: { reason: QUARANTINE_REASONS },
    arrays: { related_event_ids: { strings: true } },
  },
  LINEAGE_RELEASED: {
    required: ["subtree_root_material_id", "reason"],
    arrays: { related_event_ids: { strings: true } },
  },
  LABEL_DISPUTE_FILED: {
    required: ["dispute_id", "material_ids", "description", "filed_by"],
    arrays: {
      material_ids: { strings: true, minItems: 1 },
      evidence_artifact_ids: { strings: true },
    },
  },
  LABEL_DISPUTE_RESOLVED: {
    required: ["dispute_id", "resolution"],
    enums: { resolution: DISPUTE_RESOLUTIONS },
  },
  RUN_COMPLETED: {
    required: ["run_id", "protocol_id", "materials_used", "parameters", "outcome", "operator_id"],
    enums: { outcome: RUN_OUTCOMES },
    datetimes: ["started_at", "completed_at"],
    booleans: ["retained"],
    plainObjects: ["parameters"],
    arrays: {
      instrument_ids: { strings: true },
      raw_artifact_ids: { strings: true },
      materials_used: {
        objects: { required: ["material_id"] },
        minItems: 1,
      },
    },
  },
  ARTIFACT_VERSIONED: {
    required: ["artifact_id", "version_no", "layer", "name", "content_hash"],
    enums: { layer: ARTIFACT_LAYERS },
    integers: ["version_no"],
    nested: { content_hash: HASH_RULES },
    arrays: {
      parent_artifact_refs: ARTIFACT_REF_ARRULE,
    },
  },
  CLAIM_REGISTERED: {
    required: ["claim_id", "statement", "supporting_run_ids", "supporting_artifact_ids"],
    arrays: {
      supporting_run_ids: { strings: true },
      materials_referenced: { strings: true },
      supporting_artifact_ids: ARTIFACT_REF_ARRULE,
    },
  },
  CLAIM_WITHDRAWN: {
    required: ["claim_id", "reason", "withdrawn_by"],
  },
  TRANSFER_APPROVED: {
    required: ["transfer_id", "material_ids", "from_lab", "to_lab", "terms", "approver_id"],
    nested: { terms: TERMS_RULES },
    arrays: { material_ids: { strings: true, minItems: 1 } },
  },
  MATERIAL_SHIPPED: {
    required: ["transfer_id", "material_ids", "shipped_at"],
    datetimes: ["shipped_at"],
    arrays: { material_ids: { strings: true, minItems: 1 } },
  },
  MATERIAL_RECEIVED: {
    required: ["transfer_id", "material_ids", "received_at", "receiver_id"],
    datetimes: ["received_at"],
    arrays: { material_ids: { strings: true, minItems: 1 } },
  },
  PERSONNEL_DEPARTURE_CHECKED: {
    required: [
      "person_id",
      "data_access_revoked_at",
      "materials_returned",
      "artifacts_checked",
      "clearance",
      "checker_id",
    ],
    enums: { clearance: CLEARANCE },
    dates: ["departure_date"],
    datetimes: ["data_access_revoked_at"],
    arrays: {
      materials_returned: { strings: true },
      artifacts_checked: { strings: true },
      unauthorized_removals: { strings: true },
    },
  },
  RETENTION_POLICY_DECLARED: {
    required: ["policy_id", "applies_to_outcomes", "retain_years", "searchable", "declared_by"],
    booleans: ["searchable"],
    integers: ["retain_years"],
    arrays: {
      applies_to_outcomes: { strings: true },
    },
  },
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkRequired(obj, fields, errors, path) {
  for (const f of fields) {
    if (!(f in obj) || obj[f] === null || obj[f] === "") {
      errors.push(`${path} 缺少字段：${f}`);
    }
  }
}

function checkRules(value, rules, errors, path) {
  if (!isObject(value)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  checkRequired(value, rules.required ?? [], errors, path);

  for (const [f, allowed] of Object.entries(rules.enums ?? {})) {
    if (f in value && value[f] !== undefined && !allowed.includes(value[f])) {
      errors.push(`${path}.${f} 取值非法：${String(value[f])}`);
    }
  }
  for (const f of rules.dates ?? []) {
    if (f in value && !(typeof value[f] === "string" && DATE_RE.test(value[f]))) {
      errors.push(`${path}.${f} 不是日期(YYYY-MM-DD)：${String(value[f])}`);
    }
  }
  for (const f of rules.datetimes ?? []) {
    if (f in value && !(typeof value[f] === "string" && DATETIME_RE.test(value[f]))) {
      errors.push(`${path}.${f} 不是 RFC3339 时间：${String(value[f])}`);
    }
  }
  for (const f of rules.integers ?? []) {
    if (f in value && (!Number.isInteger(value[f]) || value[f] < 1)) {
      errors.push(`${path}.${f} 必须是 ≥1 的整数`);
    }
  }
  for (const f of rules.booleans ?? []) {
    if (f in value && typeof value[f] !== "boolean") errors.push(`${path}.${f} 必须是布尔值`);
  }
  for (const f of rules.plainObjects ?? []) {
    if (f in value && !isObject(value[f])) errors.push(`${path}.${f} 必须是对象`);
  }
  for (const [f, nested] of Object.entries(rules.nested ?? {})) {
    if (f in value && isObject(value[f])) checkRules(value[f], nested, errors, `${path}.${f}`);
  }
  for (const [f, arrRule] of Object.entries(rules.arrays ?? {})) {
    if (!(f in value) || value[f] === undefined) continue;
    const arr = value[f];
    const p = `${path}.${f}`;
    if (!Array.isArray(arr)) {
      errors.push(`${p} 必须是数组`);
      continue;
    }
    if (arrRule.minItems && arr.length < arrRule.minItems) {
      errors.push(`${p} 至少包含 ${arrRule.minItems} 项`);
    }
    arr.forEach((item, i) => {
      const ip = `${p}[${i}]`;
      if (arrRule.strings && typeof item !== "string") errors.push(`${ip} 必须是字符串`);
      if (arrRule.dates && !(typeof item === "string" && DATE_RE.test(item))) {
        errors.push(`${ip} 不是日期`);
      }
      if (arrRule.objects) {
        if (!isObject(item)) errors.push(`${ip} 必须是对象`);
        else checkRules(item, arrRule.objects, errors, ip);
      }
    });
  }
}

/** 校验事件信封（仓库现有交换边界，七个必填字段仍然是最低要求）。 */
export function validateEventEnvelope(record) {
  const errors = [];
  if (!isObject(record)) return ["事件必须是对象"];
  checkRequired(record, ENVELOPE_REQUIRED, errors, "$");
  if ("event_type" in record && !KNOWN_EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if ("aggregate_type" in record && !KNOWN_AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if ("occurred_at" in record && !DATETIME_RE.test(record.occurred_at)) {
    errors.push("occurred_at 不是 RFC3339 时间");
  }
  if ("recorded_at" in record && !DATETIME_RE.test(record.recorded_at)) {
    errors.push("recorded_at 不是 RFC3339 时间");
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("payload" in record && record.payload !== undefined && !isObject(record.payload)) {
    errors.push("payload 必须是对象");
  }
  return errors;
}

/** 按事件类型校验类型化载荷。 */
export function validatePayload(eventType, payload) {
  const errors = [];
  const rules = PAYLOAD_RULES[eventType];
  if (!rules) {
    errors.push(`无载荷规则的事件类型：${eventType}`);
    return errors;
  }
  if (!isObject(payload)) {
    errors.push(`${eventType} 事件必须携带 payload 对象`);
    return errors;
  }
  checkRules(payload, rules, errors, `payload<${eventType}>`);
  return errors;
}

/**
 * 完整校验：信封 + 载荷。
 * 无 payload 的事件视为旧版联调事件（如 data/sample.json），只校验信封，保持向后兼容。
 */
export function validateEvent(record) {
  const errors = validateEventEnvelope(record);
  if (errors.length) return errors;
  if ("payload" in record && record.payload !== undefined) {
    errors.push(...validatePayload(record.event_type, record.payload));
  }
  return errors;
}

export class LineageValidationError extends Error {
  constructor(errors, eventId) {
    super(`事件${eventId ? ` ${eventId}` : ""}校验失败：\n- ${errors.join("\n- ")}`);
    this.name = "LineageValidationError";
    this.errors = errors;
  }
}
