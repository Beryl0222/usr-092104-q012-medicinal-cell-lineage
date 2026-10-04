/**
 * 谱系服务：把跨团队仓库里交换的"事件信封"日志收录为可查询状态。
 *
 * 收录规则：
 * 1. 每个信封先过信封校验，再过按类型的载荷校验；
 * 2. event_id 幂等（跨实验室重放同一信封不会重复记账）；
 * 3. 同一 aggregate_id 的 version 必须严格递增，事件只追加、不回改；
 * 4. 结构/引用错误整信封拒收并进入 rejection 清单，绝不静默吞掉。
 */

import { readFile } from "node:fs/promises";
import { validateEvent } from "./validator.js";
import { MaterialGraph } from "./materials.js";
import { ResearchRegistry } from "./research.js";
import { ComplianceRegistry } from "./compliance.js";

/** 解析事件日志：支持 JSON 数组与 JSONL（每行一个信封）。 */
export function parseEventLog(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function loadEventLog(path) {
  return parseEventLog(await readFile(path, "utf8"));
}

export class LineageService {
  constructor() {
    this.materials = new MaterialGraph();
    this.research = new ResearchRegistry();
    this.compliance = new ComplianceRegistry();
    /** event_id -> 信封（收录顺序保留） */
    this.events = new Map();
    this.rejections = [];
    /** aggregate_id -> 已收录最大 version */
    this.aggregateVersions = new Map();
    /** lab_id -> 收录事件数 */
    this.eventsByLab = new Map();
  }

  /**
   * 收录一个事件信封（跨实验室交换入口）。
   * @returns {{accepted:boolean, reasons?:string[]}}
   */
  ingest(event, { source = "unknown" } = {}) {
    if (!event || typeof event !== "object") {
      this.rejections.push({ event: null, source, reasons: ["信封不是对象"] });
      return { accepted: false, reasons: ["信封不是对象"] };
    }
    const reasons = validateEvent(event);

    if (this.events.has(event.event_id)) {
      // 幂等：同一信封（可能来自不同团队仓库）重放直接视为已收录。
      return { accepted: true, duplicated: true };
    }

    const lastVersion = this.aggregateVersions.get(event.aggregate_id);
    if (lastVersion !== undefined && event.version <= lastVersion) {
      reasons.push(
        `${event.aggregate_id} 版本乱序/回改：已收录 v${lastVersion}，收到 v${event.version}（只允许追加）`
      );
    }

    if (reasons.length) {
      this.rejections.push({ event_id: event.event_id ?? null, source, reasons });
      return { accepted: false, reasons };
    }

    // 结构/引用完整性：三个登记处各自核对，任一报错都拒收整信封。
    const structural = [
      ...this.materials.apply(event),
      ...this.research.apply(event),
      ...this.compliance.apply(event, this.materials),
    ];
    if (structural.length) {
      this.rejections.push({ event_id: event.event_id, source, reasons: structural });
      return { accepted: false, reasons: structural };
    }

    this.events.set(event.event_id, event);
    this.aggregateVersions.set(event.aggregate_id, event.version);
    const lab = event.lab_id ?? source;
    this.eventsByLab.set(lab, (this.eventsByLab.get(lab) ?? 0) + 1);
    return { accepted: true };
  }

  /** 批量收录；容忍坏信封但全部记录在案。 */
  ingestAll(events, { source } = {}) {
    const report = { accepted: 0, duplicated: 0, rejected: 0, rejections: [] };
    for (const event of events) {
      const r = this.ingest(event, { source: source ?? event?.lab_id ?? "unknown" });
      if (r.accepted) {
        if (r.duplicated) report.duplicated += 1;
        else report.accepted += 1;
      } else {
        report.rejected += 1;
        report.rejections.push({ event_id: event?.event_id ?? null, reasons: r.reasons });
      }
    }
    return report;
  }

  /** 任一冻存管/材料：祖先、当前可用状态、冻结情况。 */
  statusOf(materialId) {
    const lineage = this.materials.lineageOf(materialId);
    if (!lineage) return { found: false, material_id: materialId };
    return {
      found: true,
      material_id: materialId,
      vial_label: lineage.material.vial_label,
      kind: lineage.material.kind,
      species: lineage.material.species,
      strain_designation: lineage.material.strain_designation,
      storage_location: lineage.material.storage_location,
      availability: lineage.material.availability,
      custodian_lab: lineage.material.custodian_lab,
      current_holders: this.compliance.holdersOf(materialId),
      frozen: lineage.freeze.frozen,
      freeze_detail: lineage.freeze.quarantines,
      parents: lineage.parents,
      ancestor_ids: lineage.ancestor_ids,
      qc: lineage.material.qc,
      history_event_ids: lineage.material.events,
    };
  }

  /** 科学主张 -> 样本、参数、原始观测的完整证据包。 */
  evidenceFor(claimId) {
    return this.research.resolveClaim(claimId, this.materials);
  }

  /**
   * 管理者检查报告：基于实验真实性的指标，而非奖项/论文数量。
   * - 跨团队复现：同一 protocol_id 在多个实验室各有成功实验；
   * - 材料流转：转移单批准/在途/接收、条款问题、冻结材料转出企图；
   * - 主张健康度：证据链完整（可解析到原始观测）数量；
   * - 失败实验保留：失败/无定论实验仍被保留且可检索；
   * - 待处理风险：活跃冻结支系、未决标签争议、离岗未放行人员。
   */
  managementReport() {
    const runsByProtocol = new Map();
    for (const run of this.research.runs.values()) {
      if (!runsByProtocol.has(run.protocol_id)) runsByProtocol.set(run.protocol_id, []);
      runsByProtocol.get(run.protocol_id).push(run);
    }

    const crossLabReproduction = [];
    for (const [protocolId, runs] of runsByProtocol) {
      const byLab = new Map();
      for (const r of runs) {
        if (!byLab.has(r.lab_id)) byLab.set(r.lab_id, { total: 0, success: 0, failure: 0 });
        const cell = byLab.get(r.lab_id);
        cell.total += 1;
        if (r.outcome === "success") cell.success += 1;
        if (r.outcome === "failure") cell.failure += 1;
      }
      const labs = [...byLab.entries()].map(([lab_id, c]) => ({ lab_id, ...c }));
      const reproducingLabs = labs.filter((l) => l.success > 0).map((l) => l.lab_id);
      crossLabReproduction.push({
        protocol_id: protocolId,
        labs,
        lab_count: labs.length,
        reproduced_across_labs: reproducingLabs.length >= 2,
        reproducing_labs: reproducingLabs,
      });
    }

    const transfers = [...this.compliance.transfers.values()].map((t) => {
      const check = this.compliance.verifyTransfer(t.transfer_id, this.materials, {
        asOf: "9999-01-01", // 报告只看结构问题（冻结/持有），不看当天期限
      });
      return {
        transfer_id: t.transfer_id,
        material_ids: t.material_ids,
        from_lab: t.from_lab,
        to_lab: t.to_lab,
        status: t.received ? "received" : t.shipped ? "in_transit" : "approved_only",
        structural_problems: check.problems,
      };
    });

    const claims = [...this.research.claims.values()].map((c) => {
      const resolved = this.research.resolveClaim(c.claim_id, this.materials);
      return {
        claim_id: c.claim_id,
        status: c.status,
        statement: c.statement,
        evidence_sound: resolved.sound,
        evidence_gaps: resolved.gaps,
        raw_observation_count: resolved.raw_observations?.length ?? 0,
      };
    });

    const failedRuns = [...this.research.runs.values()].filter((r) => r.outcome !== "success");

    return {
      generated_from_events: this.events.size,
      events_by_lab: Object.fromEntries(this.eventsByLab),
      materials: {
        total: this.materials.materials.size,
        quarantined_roots: [...this.materials.quarantineRoots.entries()]
          .filter(([, q]) => q.active)
          .map(([id, q]) => ({ subtree_root: id, reason: q.reason, affected_material_ids: this.materials.descendants(id) })),
        open_label_disputes: [...this.materials.disputes.values()].filter((d) => d.status === "open"),
      },
      experiments: {
        total: this.research.runs.size,
        success: [...this.research.runs.values()].filter((r) => r.outcome === "success").length,
        failed_or_inconclusive: failedRuns.length,
        failed_kept_searchable: failedRuns.filter((r) => r.retained !== false).length,
        retention: this.research.retentionStatus(),
      },
      claims: {
        total: claims.length,
        active: claims.filter((c) => c.status === "active").length,
        withdrawn: claims.filter((c) => c.status === "withdrawn").length,
        sound: claims.filter((c) => c.evidence_sound).length,
        with_gaps: claims.filter((c) => !c.evidence_sound),
      },
      cross_lab_reproduction: crossLabReproduction,
      material_transfers: transfers,
      personnel_uncleared: [...this.compliance.departures.entries()]
        .filter(([, p]) => p.clearance !== "granted" || (p.unauthorized_removals ?? []).length > 0)
        .map(([person_id, p]) => ({ person_id, clearance: p.clearance, unauthorized_removals: p.unauthorized_removals ?? [] })),
      ingest_rejections: this.rejections,
    };
  }
}

/** 从一组事件直接构建服务（测试与 CLI 共用）。 */
export function buildService(events) {
  const service = new LineageService();
  const report = service.ingestAll(events);
  return { service, report };
}

export async function buildServiceFromLog(path) {
  const events = await loadEventLog(path);
  return buildService(events);
}
