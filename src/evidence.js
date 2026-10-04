export const RETENTION_CLASSES = ["standard", "failed_retained", "long_term"];

/**
 * 证据投影：原始数据、分析结果、解释各自维护独立版本链；
 * 失败实验按保留规则留存，始终可检索。
 */
export class EvidenceIndex {
  constructor() {
    this.runs = new Map();
  }

  apply(event) {
    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "RUN_COMPLETED":
        this.runs.set(event.aggregate_id, {
          run_id: event.aggregate_id,
          team: payload.team,
          protocol: payload.protocol,
          parameters: payload.parameters ?? {},
          material_ids: payload.material_ids ?? [],
          outcome: payload.outcome,
          failure_reason: payload.failure_reason,
          retention_class: payload.retention_class,
          completed_at: event.occurred_at,
          raw_data: [],
          analyses: [],
          interpretations: [],
        });
        break;
      case "RAW_DATA_REGISTERED":
        this.#run(event.aggregate_id).raw_data.push({
          version: payload.version,
          data_ref: payload.data_ref,
          hash: payload.hash,
          instrument: payload.instrument,
          registered_at: event.occurred_at,
        });
        break;
      case "ANALYSIS_VERSIONED":
        this.#run(event.aggregate_id).analyses.push({
          version: payload.version,
          analysis_ref: payload.analysis_ref,
          software: payload.software,
          parameters: payload.parameters ?? {},
          registered_at: event.occurred_at,
        });
        break;
      case "INTERPRETATION_VERSIONED":
        this.#run(event.aggregate_id).interpretations.push({
          version: payload.version,
          interpretation_ref: payload.interpretation_ref,
          author: payload.author,
          note: payload.note,
          registered_at: event.occurred_at,
        });
        break;
      default:
        break;
    }
  }

  #run(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`未登记的实验运行：${runId}`);
    return run;
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  /** 某一类留版链的最新版本。kind ∈ raw_data | analyses | interpretations */
  latestOf(runId, kind) {
    const chain = this.#run(runId)[kind];
    if (chain.length === 0) return undefined;
    return structuredClone(chain.reduce((a, b) => (b.version > a.version ? b : a)));
  }

  /** 按 data_ref 定位一条原始观测，返回所属运行与版本。 */
  findRawData(dataRef) {
    for (const run of this.runs.values()) {
      const hit = run.raw_data.find((entry) => entry.data_ref === dataRef);
      if (hit) return { run_id: run.run_id, ...structuredClone(hit) };
    }
    return undefined;
  }

  /**
   * 检索实验运行。失败实验默认不出现在支持性结果里，
   * 但按保留规则留存，include_failed: true 时始终可检索。
   */
  searchRuns({ team, outcome, retention_class, material_id, include_failed = false } = {}) {
    return [...this.runs.values()]
      .filter((run) => include_failed || run.outcome !== "failed")
      .filter((run) => !team || run.team === team)
      .filter((run) => !outcome || run.outcome === outcome)
      .filter((run) => !retention_class || run.retention_class === retention_class)
      .filter((run) => !material_id || run.material_ids.includes(material_id))
      .map((run) => structuredClone(run));
  }
}
