/**
 * 材料谱系图：登记/传代/分装/混样/基因构建事件形成有向无环图。
 * 污染、混样、标签争议只在具名支系根上冻结，冻结沿后代边传播，旁支不受影响。
 */

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export class MaterialGraph {
  constructor() {
    /** @type {Map<string, object>} 材料编号 -> 材料档案 */
    this.materials = new Map();
    /** @type {Array<{from:string,to:string,kind:string,event_id:string,detail:object}>} */
    this.edges = [];
    /** 支系冻结状态：subtree_root -> 当前状态栈结果 */
    this.quarantineRoots = new Map();
    /** 标签争议：dispute_id -> 档案 */
    this.disputes = new Map();
  }

  _birth(id, event, extra = {}) {
    if (this.materials.has(id)) {
      return { error: `材料 ${id} 已被先前事件创建（${this.materials.get(id).created_event}），${event.event_id} 重复创建` };
    }
    this.materials.set(id, {
      id,
      created_event: event.event_id,
      created_at: event.occurred_at,
      kind: extra.kind ?? null,
      species: extra.species ?? null,
      strain_designation: extra.strain_designation ?? null,
      origin_description: extra.origin_description ?? null,
      storage_location: extra.storage_location ?? null,
      vial_label: extra.vial_label ?? null,
      custodian_lab: extra.custodian_lab ?? null,
      availability: extra.availability ?? "available",
      qc: [],
      events: [event.event_id],
      ...extra.fields,
    });
    return null;
  }

  /** 后代材料继承亲本的物种/株系名/保管方（仅填补空缺；混样不继承单一株系名）。 */
  _inheritIdentity(childId, parentIds, { inheritDesignation = true } = {}) {
    const child = this.materials.get(childId);
    if (!child) return;
    for (const pid of parentIds) {
      const parent = this.materials.get(pid);
      if (!parent) continue;
      if (!child.species && parent.species) child.species = parent.species;
      if (inheritDesignation && !child.strain_designation && parent.strain_designation) {
        child.strain_designation = parent.strain_designation;
      }
      if (!child.custodian_lab && parent.custodian_lab) child.custodian_lab = parent.custodian_lab;
    }
  }

  _requireExists(id, eventId) {
    if (!this.materials.has(id)) return `事件 ${eventId} 引用了尚不存在的材料：${id}`;
    return null;
  }

  /**
   * 补全已存在材料的身份档案（纸质笔记事后转录的常见情形：
   * 材料先由转化/传代事件诞生，随后才有正式登记）。只填补空缺，
   * 与既有事实冲突（种类/物种不一致）则报错。
   */
  _supplement(id, p, event) {
    const m = this.materials.get(id);
    const errors = [];
    // 毛状根本身即 Ri 质粒转化产物，允许事后建档把泛化的 transformed_line 细化为 hairy_root_root_line。
    const KIND_REFINEMENT = { transformed_line: new Set(["hairy_root_root_line"]) };
    if (p.kind && m.kind && p.kind !== m.kind && !(KIND_REFINEMENT[m.kind]?.has(p.kind))) {
      errors.push(`材料 ${id} 登记种类冲突：已有 ${m.kind}，事件 ${event.event_id} 记为 ${p.kind}`);
    }
    if (p.species && m.species && p.species !== m.species) {
      errors.push(`材料 ${id} 登记物种冲突：已有 ${m.species}，事件 ${event.event_id} 记为 ${p.species}`);
    }
    if (errors.length) return errors;
    if (p.kind && p.kind !== m.kind) m.kind = p.kind;
    if (!m.species && p.species) m.species = p.species;
    if (!m.strain_designation && p.strain_designation) m.strain_designation = p.strain_designation;
    if (!m.origin_description && p.origin_description) m.origin_description = p.origin_description;
    if (!m.storage_location && p.storage_location) m.storage_location = p.storage_location;
    if (!m.custodian_lab && p.custodian_lab) m.custodian_lab = p.custodian_lab;
    if (p.initial_status && m.availability === "available") m.availability = p.initial_status;
    if (p.attributes) m.attributes = { ...(m.attributes ?? {}), ...p.attributes };
    m.events.push(event.event_id);
    return [];
  }

  _addEdge(from, to, kind, eventId, detail = {}) {
    this.edges.push({ from, to, kind, event_id: eventId, detail });
    const m = this.materials.get(to);
    if (m && !m.events.includes(eventId)) m.events.push(eventId);
  }

  /**
   * 应用单条已通过信封/载荷校验的事件，返回结构性错误列表（引用完整性）。
   * @returns {string[]}
   */
  apply(event) {
    const errors = [];
    const p = event.payload ?? {};
    const requireAll = (ids) => ids.forEach((id) => {
      const e = this._requireExists(id, event.event_id);
      if (e) errors.push(e);
    });

    switch (event.event_type) {
      case "MATERIAL_ACCESSIONED": {
        if (this.materials.has(p.material_id)) {
          // 事后补登记：补全身份档案并建立与所列亲本的溯源边。
          errors.push(...this._supplement(p.material_id, p, event));
        } else {
          const err = this._birth(p.material_id, event, {
            kind: p.kind,
            species: p.species,
            strain_designation: p.strain_designation,
            origin_description: p.origin_description,
            storage_location: p.storage_location,
            custodian_lab: p.custodian_lab,
            availability: p.initial_status ?? "available",
            fields: { attributes: p.attributes ?? {} },
          });
          if (err) errors.push(err);
        }
        requireAll(p.parent_material_ids ?? []);
        (p.parent_material_ids ?? []).forEach((pid) => {
          if (this.materials.has(pid)) {
            const already = this.edges.some(
              (e) => e.from === pid && e.to === p.material_id && e.kind === "accession_line"
            );
            if (!already) this._addEdge(pid, p.material_id, "accession_line", event.event_id);
          }
        });
        break;
      }
      case "PASSAGE_RECORDED": {
        requireAll([p.parent_material_id]);
        if (!this.materials.has(p.child_material_id)) {
          const err = this._birth(p.child_material_id, event, {
            kind: "passage_line",
            fields: { passage_no: p.passage_no, medium: p.medium ?? null, conditions: p.conditions ?? {} },
          });
          if (err) errors.push(err);
        }
        this._inheritIdentity(p.child_material_id, [p.parent_material_id]);
        if (this.materials.has(p.parent_material_id) && this.materials.has(p.child_material_id)) {
          this._addEdge(p.parent_material_id, p.child_material_id, "passage", event.event_id, {
            passage_id: p.passage_id,
            passage_no: p.passage_no,
            medium: p.medium,
            conditions: p.conditions,
            operator_id: p.operator_id,
            paper_note_ref: p.paper_note_ref,
          });
        }
        break;
      }
      case "MATERIAL_ALIQUOTED": {
        requireAll([p.parent_material_id]);
        for (const child of p.children) {
          if (!this.materials.has(child.material_id)) {
            const err = this._birth(child.material_id, event, {
              kind: "aliquot_vial",
              storage_location: child.storage_location,
              vial_label: child.vial_label,
              custodian_lab: this.materials.get(p.parent_material_id)?.custodian_lab ?? null,
              fields: { volume_ml: child.volume_ml ?? null },
            });
            if (err) errors.push(err);
          } else {
            errors.push(`事件 ${event.event_id} 的冻存管编号已存在：${child.material_id}`);
          }
        }
        if (this.materials.has(p.parent_material_id)) {
          p.children.forEach((child) => {
            if (this.materials.has(child.material_id)) {
              this._inheritIdentity(child.material_id, [p.parent_material_id]);
              this._addEdge(p.parent_material_id, child.material_id, "aliquot", event.event_id, {
                vial_label: child.vial_label,
                storage_location: child.storage_location,
                volume_ml: child.volume_ml,
                operator_id: p.operator_id,
              });
            }
          });
        }
        break;
      }
      case "MATERIAL_POOLED": {
        requireAll(p.source_material_ids);
        if (!this.materials.has(p.pool_material_id)) {
          const sourcesKnown = p.source_material_ids.every((id) => this.materials.has(id));
          const err = this._birth(p.pool_material_id, event, {
            kind: "pool",
            custodian_lab: sourcesKnown
              ? (this.materials.get(p.source_material_ids[0])?.custodian_lab ?? null)
              : null,
            fields: { sources: [...p.source_material_ids], ratio_note: p.ratio_note ?? null },
          });
          if (err) errors.push(err);
        } else {
          errors.push(`事件 ${event.event_id} 的混样编号已存在：${p.pool_material_id}`);
        }
        if (this.materials.has(p.pool_material_id)) {
          this._inheritIdentity(p.pool_material_id, p.source_material_ids, { inheritDesignation: false });
          p.source_material_ids.forEach((sid) => {
            if (this.materials.has(sid)) {
              this._addEdge(sid, p.pool_material_id, "pool", event.event_id, {
                ratio_note: p.ratio_note,
                operator_id: p.operator_id,
              });
            }
          });
        }
        break;
      }
      case "CONSTRUCT_INTRODUCED": {
        requireAll([p.host_material_id]);
        if (this.materials.has(p.resulting_material_id)) {
          // 产物已由登记事件建档（如纸质补录顺序）：不重复创建，仅补构建信息与溯源边。
          const m = this.materials.get(p.resulting_material_id);
          if (p.resulting_strain_designation && !m.strain_designation) {
            m.strain_designation = p.resulting_strain_designation;
          }
          m.construct = {
            construct_id: p.construct_id,
            construct_name: p.construct_name,
            vector: p.vector ?? null,
            delivery_method: p.delivery_method ?? null,
            selection_marker: p.selection_marker ?? null,
            verification: p.verification ?? null,
          };
          m.events.push(event.event_id);
        } else {
          const host = this.materials.get(p.host_material_id);
          const err = this._birth(p.resulting_material_id, event, {
            kind: "transformed_line",
            species: host?.species ?? null,
            strain_designation: p.resulting_strain_designation ?? null,
            custodian_lab: host?.custodian_lab ?? null,
            fields: {
              construct: {
                construct_id: p.construct_id,
                construct_name: p.construct_name,
                vector: p.vector ?? null,
                delivery_method: p.delivery_method ?? null,
                selection_marker: p.selection_marker ?? null,
                verification: p.verification ?? null,
              },
            },
          });
          if (err) errors.push(err);
        }
        if (this.materials.has(p.host_material_id) && this.materials.has(p.resulting_material_id)) {
          this._addEdge(p.host_material_id, p.resulting_material_id, "construct", event.event_id, {
            construct_id: p.construct_id,
            construct_name: p.construct_name,
            vector: p.vector,
            delivery_method: p.delivery_method,
            selection_marker: p.selection_marker,
            verification: p.verification,
            operator_id: p.operator_id,
          });
        }
        break;
      }
      case "QC_PERFORMED": {
        requireAll([p.material_id]);
        if (this.materials.has(p.material_id)) {
          this.materials.get(p.material_id).qc.push({
            qc_type: p.qc_type,
            result: p.result,
            method: p.method ?? null,
            observed_at: p.observed_at ?? event.occurred_at,
            artifact_ids: p.artifact_ids ?? [],
            notes: p.notes ?? null,
            operator_id: p.operator_id,
            event_id: event.event_id,
          });
        }
        break;
      }
      case "LINEAGE_QUARANTINED": {
        requireAll([p.subtree_root_material_id]);
        if (this.materials.has(p.subtree_root_material_id)) {
          this.quarantineRoots.set(p.subtree_root_material_id, {
            active: true,
            reason: p.reason,
            note: p.note ?? null,
            related_event_ids: p.related_event_ids ?? [],
            quarantined_by: event.event_id,
            quarantined_at: event.occurred_at,
            released_by: null,
          });
        }
        break;
      }
      case "LINEAGE_RELEASED": {
        requireAll([p.subtree_root_material_id]);
        const q = this.quarantineRoots.get(p.subtree_root_material_id);
        if (!q) {
          errors.push(`事件 ${event.event_id} 试图解除冻结，但 ${p.subtree_root_material_id} 没有活跃冻结记录`);
        } else {
          q.active = false;
          q.released_by = event.event_id;
          q.release_reason = p.reason;
        }
        break;
      }
      case "LABEL_DISPUTE_FILED": {
        requireAll(p.material_ids);
        this.disputes.set(p.dispute_id, {
          dispute_id: p.dispute_id,
          material_ids: [...p.material_ids],
          description: p.description,
          evidence_artifact_ids: p.evidence_artifact_ids ?? [],
          filed_by: p.filed_by,
          filed_at: event.occurred_at,
          status: "open",
          resolution: null,
        });
        break;
      }
      case "LABEL_DISPUTE_RESOLVED": {
        const d = this.disputes.get(p.dispute_id);
        if (!d) {
          errors.push(`事件 ${event.event_id} 处理的标签争议不存在：${p.dispute_id}`);
        } else {
          d.status = "resolved";
          d.resolution = p.resolution;
          d.corrected_material_id = p.corrected_material_id ?? null;
          d.note = p.note ?? null;
          d.resolved_by = event.event_id;
        }
        break;
      }
      default:
        break;
    }
    return errors;
  }

  _adjacency(dir) {
    const map = new Map();
    for (const id of this.materials.keys()) map.set(id, []);
    for (const e of this.edges) {
      const [a, b] = dir === "down" ? [e.from, e.to] : [e.to, e.from];
      map.get(a)?.push(e);
    }
    return map;
  }

  /** 从某材料向上的全部祖先（含自身），按溯源路径返回。 */
  ancestors(materialId) {
    const up = this._adjacency("up");
    const seen = new Set();
    const path = [];
    const walk = (id, trail) => {
      for (const edge of up.get(id) ?? []) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        const step = { material_id: edge.from, edge, trail: [...trail] };
        path.push(step);
        walk(edge.from, [...trail, edge.from]);
      }
    };
    walk(materialId, []);
    return path;
  }

  /** 从某材料向下的全部后代（含自身）。 */
  descendants(materialId) {
    const down = this._adjacency("down");
    const seen = new Set([materialId]);
    const out = [materialId];
    const walk = (id) => {
      for (const edge of down.get(id) ?? []) {
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          out.push(edge.to);
          walk(edge.to);
        }
      }
    };
    walk(materialId);
    return out;
  }

  /** 直接亲本边。 */
  parentsOf(materialId) {
    return this.edges.filter((e) => e.to === materialId);
  }

  childrenOf(materialId) {
    return this.edges.filter((e) => e.from === materialId);
  }

  /**
   * 判断材料当前是否被冻结：它等于或位于任一活跃冻结支系根之下。
   * 多个冻结根同时命中时全部列出。
   */
  freezeStatus(materialId) {
    const active = [...this.quarantineRoots.entries()].filter(([, q]) => q.active);
    const hits = [];
    for (const [root, q] of active) {
      if (root === materialId || this.descendants(root).includes(materialId)) {
        hits.push({ subtree_root: root, ...q });
      }
    }
    return { frozen: hits.length > 0, quarantines: hits };
  }

  /** 某材料完整溯源视图：身份、祖先链、培养与构建事件、质检、冻结状态。 */
  lineageOf(materialId) {
    if (!this.materials.has(materialId)) return null;
    const ancestorSteps = this.ancestors(materialId);
    return {
      material: this.materials.get(materialId),
      parents: this.parentsOf(materialId).map((e) => ({
        material_id: e.from,
        relation: e.kind,
        via_event: e.event_id,
        detail: e.detail,
      })),
      ancestor_ids: [...new Set(ancestorSteps.map((s) => s.material_id))],
      ancestor_path: ancestorSteps,
      descendant_count: this.descendants(materialId).length - 1,
      freeze: this.freezeStatus(materialId),
    };
  }
}

export function buildMaterialGraph(events) {
  const graph = new MaterialGraph();
  const errors = [];
  for (const event of events) {
    if (!isObject(event) || !event.payload) continue;
    errors.push(...graph.apply(event));
  }
  return { graph, errors };
}
