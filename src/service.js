import { EventStore } from "./store.js";
import { LineageIndex, FREEZE_REASONS } from "./lineage.js";
import { EvidenceIndex, RETENTION_CLASSES } from "./evidence.js";
import { ClaimIndex } from "./claims.js";
import { TransferIndex, REQUIRED_TRANSFER_TERMS } from "./transfer.js";
import { PersonnelIndex } from "./personnel.js";
import * as audit from "./audit.js";

/**
 * 中药细胞株科研谱系服务门面。
 * 所有状态变更都以仓库既定事件信封落账，实验室之间用 exportEvents/importEvents 交换记录。
 */
export class LineageService {
  constructor({ now } = {}) {
    this.store = new EventStore();
    this.lineage = new LineageIndex();
    this.evidence = new EvidenceIndex();
    this.claims = new ClaimIndex();
    this.transfers = new TransferIndex();
    this.personnel = new PersonnelIndex();
    this._now = now ?? (() => new Date().toISOString());
  }

  #indexes() {
    return [this.lineage, this.evidence, this.claims, this.transfers, this.personnel];
  }

  /** 校验并追加一个事件，同步刷新全部投影。 */
  ingest(event) {
    const stored = this.store.append(event);
    for (const index of this.#indexes()) index.apply(stored);
    return stored;
  }

  #emit(eventType, aggregateType, aggregateId, summary, payload, occurredAt) {
    return this.ingest({
      event_id: `evt-${String(this.store.all().length + 1).padStart(4, "0")}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: occurredAt ?? this._now(),
      version: this.store.nextVersion(aggregateType, aggregateId),
      summary,
      payload,
    });
  }

  // ---- 材料与谱系 ----

  accessionMaterial({ material_id, species, strain_name, aliases = [], team, occurred_at }) {
    return this.#emit("MATERIAL_ACCESSIONED", "biological_material", material_id, `材料登记：${strain_name ?? material_id}`, {
      species,
      strain_name,
      aliases,
      team,
    }, occurred_at);
  }

  recordPassage({ passage_id, parent_material_id, child_material_id, passage_number, conditions = {}, operator, team, occurred_at }) {
    return this.#emit("PASSAGE_RECORDED", "culture_passage", passage_id, `传代：${parent_material_id} → ${child_material_id}`, {
      parent_material_id,
      child_material_id,
      passage_number,
      conditions,
      operator,
      team,
    }, occurred_at);
  }

  recordAliquot({ child_material_id, parent_material_id, vial_count, freezer_location, occurred_at }) {
    return this.#emit("ALIQUOT_CREATED", "biological_material", child_material_id, `分装：${parent_material_id} → ${child_material_id}`, {
      parent_material_id,
      vial_count,
      freezer_location,
    }, occurred_at);
  }

  introduceConstruct({ child_material_id, parent_material_id, construct, occurred_at }) {
    return this.#emit("CONSTRUCT_INTRODUCED", "biological_material", child_material_id, `基因构建：${parent_material_id} → ${child_material_id}`, {
      parent_material_id,
      construct,
    }, occurred_at);
  }

  recordContaminationCheck({ material_id, check_type, result, method, lab, occurred_at }) {
    return this.#emit("CONTAMINATION_CHECK_RECORDED", "biological_material", material_id, `污染检查：${material_id} ${result}`, {
      check_type,
      result,
      method,
      lab,
    }, occurred_at);
  }

  /** 混样、污染或标签争议：仅冻结被标记材料及其后代支系。 */
  freezeBranch({ material_id, reason, detail, occurred_at }) {
    if (!FREEZE_REASONS.includes(reason)) {
      throw new Error(`冻结原因必须是 ${FREEZE_REASONS.join("/")} 之一，收到：${reason}`);
    }
    return this.#emit("BRANCH_FROZEN", "biological_material", material_id, `支系冻结：${material_id}（${reason}）`, { reason, detail }, occurred_at);
  }

  releaseBranch({ material_id, resolution, occurred_at }) {
    return this.#emit("BRANCH_RELEASED", "biological_material", material_id, `支系解冻：${material_id}`, { resolution }, occurred_at);
  }

  discardMaterial({ material_id, reason, occurred_at }) {
    return this.#emit("MATERIAL_DISCARDED", "biological_material", material_id, `材料销毁：${material_id}`, { reason }, occurred_at);
  }

  vialStatus(materialId) {
    return this.lineage.status(materialId);
  }

  ancestry(materialId) {
    return this.lineage.ancestors(materialId);
  }

  descendantsOf(materialId) {
    return this.lineage.descendants(materialId);
  }

  /** 任一冻存管的完整档案：祖先、后代、污染检查与当前可用状态。 */
  vialReport(materialId) {
    const material = this.lineage.materials.get(materialId);
    return {
      material_id: materialId,
      ...(material ? { species: material.species, strain_name: material.strain_name, aliases: material.aliases, team: material.team, derived_by: material.derived_by } : {}),
      status: this.lineage.status(materialId),
      ancestry: this.lineage.ancestors(materialId),
      descendants: this.lineage.descendants(materialId),
      contamination_checks: material ? structuredClone(material.checks) : [],
    };
  }

  // ---- 实验与证据留版 ----

  completeRun({ run_id, team, protocol, parameters = {}, material_ids = [], outcome, failure_reason, retention_class, occurred_at }) {
    if (!["success", "failed"].includes(outcome)) throw new Error(`outcome 必须是 success/failed，收到：${outcome}`);
    if (outcome === "failed" && !failure_reason) throw new Error("失败实验必须记录 failure_reason");
    const finalRetention = retention_class ?? (outcome === "failed" ? "failed_retained" : "standard");
    if (!RETENTION_CLASSES.includes(finalRetention)) throw new Error(`未知保留等级：${finalRetention}`);
    return this.#emit("RUN_COMPLETED", "experiment_run", run_id, `实验完成：${run_id}（${outcome}）`, {
      team,
      protocol,
      parameters,
      material_ids,
      outcome,
      failure_reason,
      retention_class: finalRetention,
    }, occurred_at);
  }

  registerRawData({ run_id, data_ref, hash, instrument, occurred_at }) {
    const version = (this.evidence.getRun(run_id)?.raw_data.length ?? 0) + 1;
    return this.#emit("RAW_DATA_REGISTERED", "experiment_run", run_id, `原始数据留版：${data_ref} v${version}`, {
      version,
      data_ref,
      hash,
      instrument,
    }, occurred_at);
  }

  versionAnalysis({ run_id, analysis_ref, software, parameters = {}, occurred_at }) {
    const version = (this.evidence.getRun(run_id)?.analyses.length ?? 0) + 1;
    return this.#emit("ANALYSIS_VERSIONED", "experiment_run", run_id, `分析结果留版：${analysis_ref} v${version}`, {
      version,
      analysis_ref,
      software,
      parameters,
    }, occurred_at);
  }

  versionInterpretation({ run_id, interpretation_ref, author, note, occurred_at }) {
    const version = (this.evidence.getRun(run_id)?.interpretations.length ?? 0) + 1;
    return this.#emit("INTERPRETATION_VERSIONED", "experiment_run", run_id, `解释留版：${interpretation_ref} v${version}`, {
      version,
      interpretation_ref,
      author,
      note,
    }, occurred_at);
  }

  getRun(runId) {
    return this.evidence.getRun(runId);
  }

  searchRuns(criteria = {}) {
    return this.evidence.searchRuns(criteria);
  }

  // ---- 科学主张 ----

  registerClaim({ claim_id, statement, team, material_ids = [], run_ids = [], parameter_refs = [], observation_refs = [], occurred_at }) {
    return this.#emit("CLAIM_REGISTERED", "research_claim", claim_id, `主张登记：${claim_id}`, {
      statement,
      team,
      material_ids,
      run_ids,
      parameter_refs,
      observation_refs,
    }, occurred_at);
  }

  /** 一项主张的具体样本、参数与原始观测；失败证据单列，样本异常会标记 at_risk。 */
  claimEvidence(claimId) {
    const claim = this.claims.getClaim(claimId);
    if (!claim) throw new Error(`未登记的主张：${claimId}`);
    const materials = claim.material_ids.map((id) => ({ material_id: id, ...this.lineage.status(id) }));
    const runs = claim.run_ids.map((id) => this.evidence.getRun(id)).filter(Boolean);
    const supportingRuns = runs.filter((run) => run.outcome === "success");
    const failedRuns = runs.filter((run) => run.outcome === "failed");
    const observations = [];
    const missingObservations = [];
    for (const ref of claim.observation_refs) {
      const hit = this.evidence.findRawData(ref);
      if (hit) observations.push(hit);
      else missingObservations.push(ref);
    }
    const parameters = Object.fromEntries(
      claim.parameter_refs.map((name) => [name, supportingRuns.map((run) => run.parameters[name]).filter((value) => value !== undefined)]),
    );
    return {
      claim_id: claim.claim_id,
      statement: claim.statement,
      team: claim.team,
      materials,
      parameters,
      observations,
      missing_observations: missingObservations,
      supporting_runs: supportingRuns,
      failed_runs: failedRuns,
      at_risk: materials.some((material) => material.state !== "available"),
    };
  }

  // ---- 对外转移与撤回 ----

  /** 转移前核对：用途、期限、署名、再分发限制，以及材料当前可用。 */
  transferPreflight(materialId, terms) {
    const violations = [];
    for (const field of REQUIRED_TRANSFER_TERMS) {
      if (terms[field] === undefined || terms[field] === null || terms[field] === "") violations.push(`缺少条款：${field}`);
    }
    if (terms.redistribution_allowed !== undefined && typeof terms.redistribution_allowed !== "boolean") {
      violations.push("redistribution_allowed 必须是布尔值");
    }
    if (terms.term_end && Number.isNaN(Date.parse(terms.term_end))) violations.push("term_end 必须是可解析的日期");
    const status = this.lineage.status(materialId);
    if (status.state === "unknown") violations.push(`材料未登记：${materialId}`);
    else if (status.state !== "available") violations.push(`材料当前不可用（${status.state}）：${materialId}`);
    return violations;
  }

  approveTransfer({ agreement_id, material_id, from_team, to_holder, custodian, purpose, term_end, attribution, redistribution_allowed, occurred_at }) {
    const terms = { purpose, term_end, attribution, redistribution_allowed };
    const violations = this.transferPreflight(material_id, terms);
    if (violations.length > 0) {
      const failure = new Error(`转移核对未通过：${violations.join("；")}`);
      failure.violations = violations;
      throw failure;
    }
    return this.#emit("TRANSFER_APPROVED", "transfer_agreement", agreement_id, `转移批准：${material_id} → ${to_holder}`, {
      material_id,
      from_team,
      to_holder,
      custodian,
      ...terms,
    }, occurred_at);
  }

  withdrawTransfer({ agreement_id, reason, occurred_at }) {
    if (!this.transfers.getAgreement(agreement_id)) throw new Error(`未登记的转移协议：${agreement_id}`);
    this.#emit("TRANSFER_WITHDRAWN", "transfer_agreement", agreement_id, `转移撤回：${agreement_id}`, { reason }, occurred_at);
    return this.withdrawalImpact(agreement_id);
  }

  /** 撤回影响：受影响的全部持有方（含再分发链）与相关研究。 */
  withdrawalImpact(agreementId) {
    const agreement = this.transfers.getAgreement(agreementId);
    if (!agreement) throw new Error(`未登记的转移协议：${agreementId}`);
    const holders = this.transfers.holdersOf(agreement.material_id, [agreement.to_holder]);
    const affectedClaims = [...this.claims.claims.values()].filter(
      (claim) => holders.has(claim.team) && claim.material_ids.includes(agreement.material_id),
    );
    const affectedRuns = [...this.evidence.runs.values()].filter(
      (run) => holders.has(run.team) && run.material_ids.includes(agreement.material_id),
    );
    return {
      agreement_id: agreementId,
      material_id: agreement.material_id,
      holders: [...holders],
      affected_claims: affectedClaims.map((claim) => claim.claim_id),
      affected_runs: affectedRuns.map((run) => run.run_id),
    };
  }

  // ---- 人员授权与离岗 ----

  authorizePersonnel({ person_id, scope, resource, occurred_at }) {
    return this.#emit("PERSONNEL_AUTHORIZED", "personnel", person_id, `授权：${person_id} 获得 ${scope}`, { scope, resource }, occurred_at);
  }

  revokeAuthorization({ person_id, scope, occurred_at }) {
    return this.#emit("PERSONNEL_AUTHORIZATION_REVOKED", "personnel", person_id, `回收授权：${person_id} 的 ${scope}`, { scope }, occurred_at);
  }

  accessCheck(personId, scope) {
    return this.personnel.hasAccess(personId, scope);
  }

  /** 离岗：回收全部授权并列出必须归还的在管材料，离岗后 accessCheck 一律拒绝。 */
  offboardPersonnel(personId, { occurred_at } = {}) {
    if (this.personnel.isOffboarded(personId)) throw new Error(`人员已离岗：${personId}`);
    const active = this.personnel.activeAuthorizations(personId);
    for (const { scope } of active) this.revokeAuthorization({ person_id: personId, scope, occurred_at });
    this.#emit("PERSONNEL_OFFBOARDED", "personnel", personId, `离岗：${personId}`, {}, occurred_at);
    const custody = [...this.transfers.agreements.values()].filter(
      (agreement) => agreement.custodian === personId && agreement.status === "active",
    );
    return {
      person_id: personId,
      revoked_scopes: active.map((entry) => entry.scope),
      must_return: custody.map((agreement) => ({ agreement_id: agreement.agreement_id, material_id: agreement.material_id, holder: agreement.to_holder })),
    };
  }

  // ---- 管理审计 ----

  reproducibilityReport(claimId) {
    const claim = this.claims.getClaim(claimId);
    if (!claim) throw new Error(`未登记的主张：${claimId}`);
    const runs = claim.run_ids.map((id) => this.evidence.getRun(id)).filter(Boolean);
    return audit.reproducibilityReport(claim, runs);
  }

  materialFlowReport() {
    return audit.materialFlowReport([...this.transfers.agreements.values()], (id) => this.lineage.status(id));
  }

  integrityOverview() {
    const claims = [...this.claims.claims.values()].map((claim) => {
      const evidence = this.claimEvidence(claim.claim_id);
      return { ...claim, evidence_complete: evidence.missing_observations.length === 0 && evidence.supporting_runs.length > 0 };
    });
    return audit.integrityOverview({
      runs: [...this.evidence.runs.values()],
      claims,
      frozenBranches: this.lineage.freezes.size,
      agreements: [...this.transfers.agreements.values()],
    });
  }

  // ---- 实验室间事件交换 ----

  exportEvents() {
    return this.store.all();
  }

  /** 导入他方事件信封；按 event_id 去重，保持各聚合版本连续。 */
  importEvents(events) {
    const imported = [];
    for (const event of events) {
      if (this.store.has(event.event_id)) continue;
      imported.push(this.ingest(event));
    }
    return imported;
  }

  static fromEvents(events, options) {
    const service = new LineageService(options);
    service.importEvents(events);
    return service;
  }
}
