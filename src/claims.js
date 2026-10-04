/** 主张投影：科学主张登记其依赖的样本、参数与原始观测引用。 */
export class ClaimIndex {
  constructor() {
    this.claims = new Map();
  }

  apply(event) {
    if (event.event_type !== "CLAIM_REGISTERED") return;
    const payload = event.payload ?? {};
    this.claims.set(event.aggregate_id, {
      claim_id: event.aggregate_id,
      statement: payload.statement,
      team: payload.team,
      material_ids: payload.material_ids ?? [],
      run_ids: payload.run_ids ?? [],
      parameter_refs: payload.parameter_refs ?? [],
      observation_refs: payload.observation_refs ?? [],
      registered_at: event.occurred_at,
    });
  }

  getClaim(claimId) {
    const claim = this.claims.get(claimId);
    return claim ? structuredClone(claim) : undefined;
  }
}
