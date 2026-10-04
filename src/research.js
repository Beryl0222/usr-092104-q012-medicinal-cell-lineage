/**
 * 科研记录模块：
 * - 实验（experiment_run）：成功、失败、无定论同样留存与检索；
 * - 数据产物三层：raw_observation（仪器原始观测）→ analysis（分析结果）→ interpretation（解释），
 *   每层各自留版，版本不可修改，溯源边只能从上层指向较低层；
 * - 科学主张（research_claim）：必须解析到具体实验、具体版本产物、具体材料与参数。
 */

const LAYER_ORDER = { raw_observation: 0, analysis: 1, interpretation: 2 };

export class ResearchRegistry {
  constructor() {
    /** @type {Map<string, object>} run_id -> run */
    this.runs = new Map();
    /** artifact_id -> { versions: Map<version_no, object>, latest: number } */
    this.artifacts = new Map();
    /** claim_id -> claim 档案（含状态） */
    this.claims = new Map();
    /** policy_id -> 保留策略 */
    this.retentionPolicies = new Map();
    this.runEvents = new Map(); // run_id -> 创建事件
  }

  apply(event) {
    const errors = [];
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "RETENTION_POLICY_DECLARED": {
        this.retentionPolicies.set(p.policy_id, { ...p, declared_at: event.occurred_at });
        break;
      }
      case "RUN_COMPLETED": {
        if (this.runs.has(p.run_id)) {
          errors.push(`实验 ${p.run_id} 已存在，${event.event_id} 重复登记`);
          break;
        }
        this.runs.set(p.run_id, {
          run_id: p.run_id,
          protocol_id: p.protocol_id,
          protocol_name: p.protocol_name ?? null,
          materials_used: p.materials_used.map((m) => ({ ...m })),
          parameters: { ...p.parameters },
          instrument_ids: [...(p.instrument_ids ?? [])],
          outcome: p.outcome,
          failure_category: p.failure_category ?? null,
          started_at: p.started_at ?? null,
          completed_at: p.completed_at ?? event.occurred_at,
          operator_id: p.operator_id,
          retained: p.retained ?? true,
          raw_artifact_ids: [...(p.raw_artifact_ids ?? [])],
          lab_id: event.lab_id ?? null,
          source_note: event.source_note ?? null,
          registered_event: event.event_id,
        });
        this.runEvents.set(p.run_id, event);
        break;
      }
      case "ARTIFACT_VERSIONED": {
        let entry = this.artifacts.get(p.artifact_id);
        if (!entry) {
          entry = { artifact_id: p.artifact_id, versions: new Map(), latest: 0, layer: p.layer, name: p.name };
          this.artifacts.set(p.artifact_id, entry);
        } else if (entry.layer !== p.layer) {
          errors.push(
            `产物 ${p.artifact_id} 层级冲突：已有 ${entry.layer}，${event.event_id} 试图记为 ${p.layer}（同一 artifact_id 层级必须固定）`
          );
          break;
        }
        if (entry.versions.has(p.version_no)) {
          errors.push(`产物 ${p.artifact_id} v${p.version_no} 已留版，版本不可覆盖（事件 ${event.event_id}）`);
          break;
        }
        if (p.version_no !== entry.latest + 1) {
          errors.push(
            `产物 ${p.artifact_id} 版本不连续：期望 v${entry.latest + 1}，收到 v${p.version_no}`
          );
          break;
        }
        entry.versions.set(p.version_no, {
          artifact_id: p.artifact_id,
          version_no: p.version_no,
          layer: p.layer,
          name: p.name,
          storage_uri: p.storage_uri ?? null,
          content_hash: p.content_hash,
          parent_artifact_refs: (p.parent_artifact_refs ?? []).map((r) => ({ ...r })),
          run_id: p.run_id ?? null,
          instrument_id: p.instrument_id ?? null,
          recorded_by: p.recorded_by ?? null,
          note: p.note ?? null,
          versioned_by: event.event_id,
          versioned_at: event.occurred_at,
        });
        entry.latest = p.version_no;
        break;
      }
      case "CLAIM_REGISTERED": {
        if (this.claims.has(p.claim_id)) {
          errors.push(`主张 ${p.claim_id} 已存在，${event.event_id} 重复登记`);
          break;
        }
        this.claims.set(p.claim_id, {
          claim_id: p.claim_id,
          statement: p.statement,
          supporting_run_ids: [...p.supporting_run_ids],
          supporting_artifact_ids: p.supporting_artifact_ids.map((a) => ({ ...a })),
          materials_referenced: [...(p.materials_referenced ?? [])],
          registered_by: p.registered_by ?? null,
          published_in: p.published_in ?? null,
          registered_event: event.event_id,
          registered_at: event.occurred_at,
          status: "active",
          withdrawal: null,
        });
        break;
      }
      case "CLAIM_WITHDRAWN": {
        const claim = this.claims.get(p.claim_id);
        if (!claim) {
          errors.push(`撤回事件 ${event.event_id} 指向不存在的主张：${p.claim_id}`);
          break;
        }
        claim.status = "withdrawn";
        claim.withdrawal = {
          reason: p.reason,
          withdrawn_by: p.withdrawn_by,
          note: p.note ?? null,
          withdrawn_event: event.event_id,
          withdrawn_at: event.occurred_at,
        };
        break;
      }
      default:
        break;
    }
    return errors;
  }

  getArtifactVersion(artifactId, versionNo) {
    return this.artifacts.get(artifactId)?.versions.get(versionNo) ?? null;
  }

  /**
   * 产物溯源：沿 parent_artifact_refs 向下展开到原始观测。
   * 校验：引用必须存在、层级必须严格更低、不得成环。
   */
  traceArtifact(artifactId, versionNo, seen = new Set()) {
    const node = this.getArtifactVersion(artifactId, versionNo);
    if (!node) return { error: `产物版本不存在：${artifactId} v${versionNo}` };
    const key = `${artifactId}@${versionNo}`;
    if (seen.has(key)) return { error: `产物溯源成环：${key}` };
    const nextSeen = new Set(seen).add(key);

    const parents = [];
    const errors = [];
    for (const ref of node.parent_artifact_refs ?? []) {
      const parent = this.getArtifactVersion(ref.artifact_id, ref.version_no);
      if (!parent) {
        errors.push(`${key} 引用了不存在的产物版本：${ref.artifact_id} v${ref.version_no}`);
        continue;
      }
      if (LAYER_ORDER[parent.layer] >= LAYER_ORDER[node.layer]) {
        errors.push(
          `${key}（${node.layer}）的溯源边必须指向更低层级，却指向 ${ref.artifact_id} v${ref.version_no}（${parent.layer}）`
        );
      }
      const traced = this.traceArtifact(ref.artifact_id, ref.version_no, nextSeen);
      parents.push({ ref: { ...ref }, found: parent, trace: traced });
    }
    return { node, parents, errors };
  }

  /**
   * 把一项科学主张展开为可核查证据包：主张 → 实验（含材料、参数）→ 产物版本链 → 原始观测。
   * 任何断裂都列入 gaps，而不是静默通过。
   */
  resolveClaim(claimId, materialGraph) {
    const claim = this.claims.get(claimId);
    if (!claim) return { error: `主张不存在：${claimId}` };

    const runs = [];
    const gaps = [];

    for (const runId of claim.supporting_run_ids) {
      const run = this.runs.get(runId);
      if (!run) {
        gaps.push(`主张引用了不存在的实验：${runId}`);
        continue;
      }
      runs.push({
        run_id: run.run_id,
        protocol_id: run.protocol_id,
        protocol_name: run.protocol_name,
        outcome: run.outcome,
        failure_category: run.failure_category,
        parameters: run.parameters,
        instrument_ids: run.instrument_ids,
        operator_id: run.operator_id,
        lab_id: run.lab_id,
        source_note: run.source_note,
        materials: run.materials_used.map((m) => {
          const lineage = materialGraph?.lineageOf(m.material_id) ?? null;
          return {
            material_id: m.material_id,
            role: m.role,
            exists: Boolean(lineage),
            vial_label: lineage?.material?.vial_label ?? null,
            strain_designation: lineage?.material?.strain_designation ?? null,
            frozen: lineage?.freeze?.frozen ?? null,
            ancestor_ids: lineage?.ancestor_ids ?? [],
          };
        }),
      });
    }

    const artifacts = claim.supporting_artifact_ids.map((ref) => {
      const trace = this.traceArtifact(ref.artifact_id, ref.version_no);
      if (trace.error) {
        gaps.push(`${claimId}：${trace.error}`);
        return { ref, found: false };
      }
      gaps.push(...trace.errors.map((e) => `${claimId}：${e}`));
      const rawLeaves = [];
      const collectLeaves = (t) => {
        if (!t.node) return;
        if (t.parents.length === 0) {
          if (t.node.layer === "raw_observation") rawLeaves.push(t.node);
          else gaps.push(`${claimId}：解释/分析产物 ${t.node.artifact_id} v${t.node.version_no} 没有溯源到任何下层产物`);
          return;
        }
        t.parents.forEach((parent) => collectLeaves(parent.trace));
      };
      collectLeaves(trace);
      return {
        ref,
        found: true,
        node: trace.node,
        raw_leaves: [...new Map(rawLeaves.map((n) => [`${n.artifact_id}@${n.version_no}`, n])).values()],
      };
    });

    const unknownMaterials = claim.materials_referenced.filter((id) => materialGraph && !materialGraph.materials.has(id));
    unknownMaterials.forEach((id) => gaps.push(`主张点名的材料不存在：${id}`));

    return {
      claim,
      runs,
      artifacts,
      raw_observations: [...new Set(artifacts.flatMap((a) => (a.raw_leaves ?? []).map((n) => `${n.artifact_id}@${n.version_no}`)))],
      gaps,
      sound: gaps.length === 0 && runs.length > 0 && artifacts.length > 0,
    };
  }

  /**
   * 检索实验。失败实验默认仍在结果中（受保留策略约束），不允许只看成功实验。
   */
  searchRuns({ materialId, outcome, protocolId, includeFailures = true } = {}) {
    let out = [...this.runs.values()];
    if (!includeFailures) out = out.filter((r) => r.outcome === "success");
    if (outcome) out = out.filter((r) => r.outcome === outcome);
    if (protocolId) out = out.filter((r) => r.protocol_id === protocolId);
    if (materialId) {
      out = out.filter((r) => r.materials_used.some((m) => m.material_id === materialId));
    }
    return out;
  }

  /** 失败/阴性实验保留检查：按已声明策略核对 retain 年限与可检索性。 */
  retentionStatus(asOfDate = new Date().toISOString().slice(0, 10)) {
    const policies = [...this.retentionPolicies.values()];
    const report = [];
    for (const run of this.runs.values()) {
      if (run.outcome === "success") continue;
      const matching = policies.filter((pol) => pol.applies_to_outcomes.includes(run.outcome));
      const searchable = this.searchRuns({}).some((r) => r.run_id === run.run_id);
      let retainUntil = null;
      if (matching.length && run.completed_at) {
        const years = Math.max(...matching.map((pol) => pol.retain_years));
        const d = new Date(run.completed_at);
        d.setFullYear(d.getFullYear() + years);
        retainUntil = d.toISOString().slice(0, 10);
      }
      report.push({
        run_id: run.run_id,
        outcome: run.outcome,
        retained: run.retained,
        searchable,
        policies: matching.map((pol) => pol.policy_id),
        retain_until: retainUntil,
        within_retention: retainUntil ? retainUntil >= asOfDate : null,
      });
    }
    return report;
  }
}

export function buildResearchRegistry(events) {
  const registry = new ResearchRegistry();
  const errors = [];
  for (const event of events) {
    if (!event || !event.payload) continue;
    errors.push(...registry.apply(event));
  }
  return { registry, errors };
}
