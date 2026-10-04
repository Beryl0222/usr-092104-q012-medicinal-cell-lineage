/**
 * 合规模块：
 * - 材料转移必须核对四要素（用途、期限、署名、再分发限制），冻结支系不得转出；
 * - 持有方跟踪：撤回主张时指出影响了哪些外部持有方与下游研究；
 * - 人员离岗：权限回收、材料归还、未授权带走检查，有未授权资料则不得放行。
 */

const TERMS_FIELDS = ["intended_use", "valid_until", "attribution", "redistribution"];

export class ComplianceRegistry {
  constructor() {
    /** transfer_id -> 档案 */
    this.transfers = new Map();
    /** material_id -> Set<lab_id> 当前持有方 */
    this.holders = new Map();
    /** material_id -> Set<lab_id> 运输在途的接收方 */
    this.inTransit = new Map();
    /** person_id -> 离岗检查档案（最新一次） */
    this.departures = new Map();
  }

  _trackInitialHolder(materialId, labId) {
    if (!labId) return;
    if (!this.holders.has(materialId)) this.holders.set(materialId, new Set());
    this.holders.get(materialId).add(labId);
  }

  apply(event, materialGraph) {
    const errors = [];
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "MATERIAL_ACCESSIONED": {
        this._trackInitialHolder(p.material_id, p.custodian_lab);
        break;
      }
      case "PASSAGE_RECORDED": {
        const lab = materialGraph?.materials.get(p.child_material_id)?.custodian_lab;
        this._trackInitialHolder(p.child_material_id, lab ?? event.lab_id);
        break;
      }
      case "MATERIAL_ALIQUOTED": {
        for (const child of p.children) {
          const lab = materialGraph?.materials.get(child.material_id)?.custodian_lab ?? event.lab_id;
          this._trackInitialHolder(child.material_id, lab);
        }
        break;
      }
      case "MATERIAL_POOLED": {
        const lab = materialGraph?.materials.get(p.pool_material_id)?.custodian_lab ?? event.lab_id;
        this._trackInitialHolder(p.pool_material_id, lab);
        break;
      }
      case "CONSTRUCT_INTRODUCED": {
        const lab = materialGraph?.materials.get(p.resulting_material_id)?.custodian_lab ?? event.lab_id;
        this._trackInitialHolder(p.resulting_material_id, lab);
        break;
      }
      case "TRANSFER_APPROVED": {
        if (this.transfers.has(p.transfer_id)) {
          errors.push(`转移单 ${p.transfer_id} 已存在，${event.event_id} 重复审批`);
          break;
        }
        const missing = TERMS_FIELDS.filter((f) => !p.terms?.[f]);
        if (missing.length) {
          errors.push(`转移单 ${p.transfer_id} 缺少条款：${missing.join("、")}`);
        }
        if (p.from_lab === p.to_lab) {
          errors.push(`转移单 ${p.transfer_id} 的转入/转出院系相同：${p.from_lab}`);
        }
        this.transfers.set(p.transfer_id, {
          transfer_id: p.transfer_id,
          material_ids: [...p.material_ids],
          from_lab: p.from_lab,
          to_lab: p.to_lab,
          terms: { ...p.terms },
          approver_id: p.approver_id,
          approved_event: event.event_id,
          approved_at: event.occurred_at,
          shipped: null,
          received: null,
        });
        break;
      }
      case "MATERIAL_SHIPPED": {
        const t = this.transfers.get(p.transfer_id);
        if (!t) {
          errors.push(`发运事件 ${event.event_id} 对应转移单不存在：${p.transfer_id}`);
          break;
        }
        for (const id of p.material_ids) {
          if (!t.material_ids.includes(id)) {
            errors.push(`发运材料 ${id} 不在转移单 ${p.transfer_id} 的批准清单内`);
          }
          if (!this.inTransit.has(id)) this.inTransit.set(id, new Set());
          this.inTransit.get(id).add(t.to_lab);
        }
        t.shipped = {
          material_ids: [...p.material_ids],
          shipped_at: p.shipped_at,
          carrier: p.carrier ?? null,
          event_id: event.event_id,
        };
        break;
      }
      case "MATERIAL_RECEIVED": {
        const t = this.transfers.get(p.transfer_id);
        if (!t) {
          errors.push(`接收事件 ${event.event_id} 对应转移单不存在：${p.transfer_id}`);
          break;
        }
        if (!t.shipped) {
          errors.push(`转移单 ${p.transfer_id} 未发运先接收（事件 ${event.event_id}）`);
        }
        for (const id of p.material_ids) {
          if (!t.material_ids.includes(id)) {
            errors.push(`接收材料 ${id} 不在转移单 ${p.transfer_id} 的批准清单内`);
          }
          if (!this.holders.has(id)) this.holders.set(id, new Set());
          this.holders.get(id).delete(t.from_lab);
          this.holders.get(id).add(t.to_lab);
          this.inTransit.get(id)?.delete(t.to_lab);
        }
        t.received = {
          material_ids: [...p.material_ids],
          received_at: p.received_at,
          receiver_id: p.receiver_id,
          event_id: event.event_id,
        };
        break;
      }
      case "PERSONNEL_DEPARTURE_CHECKED": {
        if (p.clearance === "granted" && (p.unauthorized_removals ?? []).length > 0) {
          errors.push(
            `离岗检查 ${event.event_id}：${p.person_id} 存在 ${p.unauthorized_removals.length} 项未授权带走记录，不得标记 granted`
          );
        }
        if (
          p.clearance === "granted" &&
          (!p.data_access_revoked_at || !(p.materials_returned ?? []))
        ) {
          errors.push(`离岗检查 ${event.event_id}：${p.person_id} 权限未回收/材料未归还，不得放行`);
        }
        this.departures.set(p.person_id, { ...p, checked_event: event.event_id });
        break;
      }
      default:
        break;
    }
    return errors;
  }

  holdersOf(materialId) {
    return [...(this.holders.get(materialId) ?? [])];
  }

  /**
   * 转出前核对：条款四要素齐全、期限未过、材料存在、非冻结支系、持有方为出院系。
   */
  verifyTransfer(transferId, materialGraph, { asOf } = {}) {
    const t = this.transfers.get(transferId);
    if (!t) return { found: false, problems: [`转移单不存在：${transferId}`] };
    const today = asOf ?? new Date().toISOString().slice(0, 10);
    const problems = [];

    for (const f of TERMS_FIELDS) {
      if (!t.terms[f]) problems.push(`条款缺失：${f}`);
    }
    if (t.terms.valid_until && t.terms.valid_until < today) {
      problems.push(`使用期限已过：valid_until=${t.terms.valid_until}（今日 ${today}）`);
    }
    for (const id of t.material_ids) {
      const mat = materialGraph?.materials.get(id);
      if (!mat) {
        problems.push(`材料不存在：${id}`);
        continue;
      }
      const freeze = materialGraph.freezeStatus(id);
      if (freeze.frozen) {
        problems.push(
          `材料 ${id} 处于冻结支系（根 ${freeze.quarantines.map((q) => q.subtree_root).join("、")}），不得转出`
        );
      }
      const heldBy = this.holdersOf(id);
      if (!heldBy.includes(t.from_lab)) {
        problems.push(`出院系 ${t.from_lab} 当前不持有 ${id}（实际持有：${heldBy.join("、") || "无"}）`);
      }
    }
    return {
      found: true,
      transfer: t,
      terms_complete: TERMS_FIELDS.every((f) => Boolean(t.terms[f])),
      within_validity: !t.terms.valid_until || t.terms.valid_until >= today,
      problems,
      shippable: problems.length === 0,
    };
  }

  /**
   * 撤回影响面：受影响材料及其后代冻存管的当前持有方（含外部单位）、在途转移、
   * 引用这些材料的实验、以及建立在这些实验/产物上的其他科学主张（下游研究）。
   * 后代支系一并展开：主张针对的是株系，发出去的分装管持有方同样必须被通知。
   */
  withdrawalImpact(claim, researchRegistry, materialGraph) {
    const seedIds = new Set(claim.materials_referenced ?? []);
    const runs = claim.supporting_run_ids.map((id) => researchRegistry.runs.get(id)).filter(Boolean);
    for (const run of runs) {
      for (const m of run.materials_used) seedIds.add(m.material_id);
    }

    // 展开到后代：每个种子材料及其全部传代/分装/混样/转化后代。
    const materialIds = new Set(seedIds);
    for (const id of [...seedIds]) {
      if (materialGraph?.materials.has(id)) {
        for (const d of materialGraph.descendants(id)) materialIds.add(d);
      }
    }

    const affectedMaterials = [...seedIds].map((id) => ({
      material_id: id,
      holders: this.holdersOf(id),
      in_transit_to: [...(this.inTransit.get(id) ?? [])],
      descendant_vials_held_by: [
        ...new Set(
          (materialGraph?.descendants(id) ?? [])
            .filter((d) => d !== id)
            .flatMap((d) => this.holdersOf(d))
        ),
      ],
    }));

    const affectedTransfers = [...this.transfers.values()]
      .filter((t) => t.material_ids.some((id) => materialIds.has(id)))
      .map((t) => ({
        transfer_id: t.transfer_id,
        from_lab: t.from_lab,
        to_lab: t.to_lab,
        status: t.received ? "received" : t.shipped ? "shipped" : "approved_only",
        terms: t.terms,
      }));

    // 下游研究：其他主张若引用了同一实验，或引用了本主张证据产物的同 artifact 链
    const downstreamClaims = [];
    const claimArtifactIds = new Set(claim.supporting_artifact_ids.map((a) => a.artifact_id));
    for (const other of researchRegistry.claims.values()) {
      if (other.claim_id === claim.claim_id) continue;
      const sharedRuns = other.supporting_run_ids.filter((id) => claim.supporting_run_ids.includes(id));
      const sharedArtifacts = other.supporting_artifact_ids.filter((a) => claimArtifactIds.has(a.artifact_id));
      const sharedMaterials = (other.materials_referenced ?? []).filter((id) => materialIds.has(id));
      if (sharedRuns.length || sharedArtifacts.length || sharedMaterials.length) {
        downstreamClaims.push({
          claim_id: other.claim_id,
          statement: other.statement,
          status: other.status,
          published_in: other.published_in,
          shared_runs: sharedRuns,
          shared_artifacts: sharedArtifacts,
          shared_materials: sharedMaterials,
        });
      }
    }

    const affectedRuns = [...researchRegistry.runs.values()]
      .filter((r) => r.materials_used.some((m) => materialIds.has(m.material_id)))
      .map((r) => ({
        run_id: r.run_id,
        outcome: r.outcome,
        lab_id: r.lab_id,
        protocol_id: r.protocol_id,
      }));

    const externalHolders = new Set();
    for (const m of affectedMaterials) {
      m.holders.forEach((h) => externalHolders.add(h));
      m.descendant_vials_held_by.forEach((h) => externalHolders.add(h));
    }

    return {
      withdrawn_claim: claim.claim_id,
      affected_materials: affectedMaterials,
      affected_transfers: affectedTransfers,
      affected_runs: affectedRuns,
      downstream_claims: downstreamClaims,
      holders_to_notify: [...externalHolders],
    };
  }

  /** 某人能否离岗：granted 且无未授权带走。 */
  departureStatus(personId) {
    const rec = this.departures.get(personId);
    if (!rec) return { found: false, clear: false, problems: [`无离岗检查记录：${personId}`] };
    const problems = [];
    if ((rec.unauthorized_removals ?? []).length) {
      problems.push(`存在未授权带走资料：${rec.unauthorized_removals.join("、")}`);
    }
    if (!rec.data_access_revoked_at) problems.push("数据访问权限未回收");
    if (rec.clearance !== "granted") problems.push(`检查结论为 ${rec.clearance}`);
    return { found: true, record: rec, clear: problems.length === 0, problems };
  }
}
