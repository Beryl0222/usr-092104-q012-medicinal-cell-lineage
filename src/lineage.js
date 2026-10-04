export const FREEZE_REASONS = ["mix_up", "contamination", "label_dispute"];

const DERIVATION_VIA = {
  PASSAGE_RECORDED: "passage",
  ALIQUOT_CREATED: "aliquot",
  CONSTRUCT_INTRODUCED: "construct",
};

/**
 * 谱系投影：传代、分装、基因构建形成父子边；
 * 混样/污染/标签争议只在被标记的支系上登记冻结，不影响亲本与姊妹支系。
 */
export class LineageIndex {
  constructor() {
    this.materials = new Map();
    this.parentOf = new Map();
    this.childrenOf = new Map();
    this.freezes = new Map();
    this.discarded = new Map();
    this.passages = new Map();
  }

  apply(event) {
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "MATERIAL_ACCESSIONED":
        this.#register(event.aggregate_id, {
          species: payload.species,
          strain_name: payload.strain_name,
          aliases: payload.aliases ?? [],
          team: payload.team,
          origin: "accessioned",
          accessioned_at: event.occurred_at,
        });
        break;
      case "PASSAGE_RECORDED": {
        this.passages.set(event.aggregate_id, {
          passage_id: event.aggregate_id,
          parent_material_id: payload.parent_material_id,
          child_material_id: payload.child_material_id,
          passage_number: payload.passage_number,
          conditions: payload.conditions ?? {},
          operator: payload.operator,
          team: payload.team,
          recorded_at: event.occurred_at,
        });
        this.#derive(event, "passage");
        break;
      }
      case "ALIQUOT_CREATED":
        this.#derive(event, "aliquot", { freezer_location: payload.freezer_location, vial_count: payload.vial_count });
        break;
      case "CONSTRUCT_INTRODUCED":
        this.#derive(event, "construct", { construct: payload.construct ?? {} });
        break;
      case "CONTAMINATION_CHECK_RECORDED":
        this.#material(event.aggregate_id).checks.push({
          check_type: payload.check_type,
          result: payload.result,
          method: payload.method,
          lab: payload.lab,
          checked_at: event.occurred_at,
        });
        break;
      case "BRANCH_FROZEN":
        this.freezes.set(event.aggregate_id, {
          reason: payload.reason,
          detail: payload.detail,
          frozen_at: event.occurred_at,
        });
        break;
      case "BRANCH_RELEASED":
        this.freezes.delete(event.aggregate_id);
        break;
      case "MATERIAL_DISCARDED":
        this.discarded.set(event.aggregate_id, { reason: payload.reason, discarded_at: event.occurred_at });
        break;
      default:
        break;
    }
  }

  #register(id, fields) {
    const existing = this.materials.get(id) ?? { material_id: id, checks: [], derived_by: null };
    this.materials.set(id, { ...existing, ...fields });
  }

  #material(id) {
    if (!this.materials.has(id)) this.#register(id, { origin: "derived" });
    return this.materials.get(id);
  }

  #derive(event, via, extra = {}) {
    const payload = event.payload ?? {};
    const parentId = payload.parent_material_id;
    const childId = via === "passage" ? payload.child_material_id : event.aggregate_id;
    if (!parentId || !childId) throw new Error(`${event.event_type} 缺少 parent_material_id 或子代材料编号`);
    this.#material(parentId);
    this.#register(childId, { origin: "derived", derived_by: via, ...extra });
    this.parentOf.set(childId, parentId);
    if (!this.childrenOf.has(parentId)) this.childrenOf.set(parentId, []);
    this.childrenOf.get(parentId).push({ child_id: childId, via, ref_id: event.aggregate_id });
  }

  /** 从亲本一路走到根，返回 [亲本, ..., 根]。 */
  ancestors(materialId) {
    const chain = [];
    const seen = new Set([materialId]);
    let current = this.parentOf.get(materialId);
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = this.parentOf.get(current);
    }
    return chain;
  }

  /** 广度优先展开后代支系。 */
  descendants(materialId) {
    const result = [];
    const queue = [{ id: materialId, depth: 0 }];
    const seen = new Set([materialId]);
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      for (const edge of this.childrenOf.get(id) ?? []) {
        if (seen.has(edge.child_id)) continue;
        seen.add(edge.child_id);
        result.push({ material_id: edge.child_id, via: edge.via, depth: depth + 1 });
        queue.push({ id: edge.child_id, depth: depth + 1 });
      }
    }
    return result;
  }

  /** 当前可用状态：unknown / discarded / frozen / available。 */
  status(materialId) {
    if (!this.materials.has(materialId)) return { state: "unknown" };
    if (this.discarded.has(materialId)) {
      return { state: "discarded", ...this.discarded.get(materialId) };
    }
    for (const id of [materialId, ...this.ancestors(materialId)]) {
      if (this.freezes.has(id)) {
        return { state: "frozen", frozen_at_branch: id, ...this.freezes.get(id) };
      }
    }
    return { state: "available" };
  }
}
