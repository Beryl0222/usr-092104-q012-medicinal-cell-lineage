/**
 * 管理审计视图：只统计可核验的实验、谱系与流转记录，
 * 不以奖项或论文数量代替实验真实性。
 */

/** 跨团队复现：同一主张是否有两个及以上团队的成功运行支持。 */
export function reproducibilityReport(claim, runs) {
  const supporting = runs.filter((run) => run.outcome === "success");
  const teams = [...new Set(supporting.map((run) => run.team))];
  return {
    claim_id: claim.claim_id,
    statement: claim.statement,
    supporting_runs: supporting.length,
    teams,
    cross_team_reproducible: teams.length >= 2,
  };
}

/** 材料流转：全部转移协议及其当前状态。 */
export function materialFlowReport(agreements, statusOf) {
  return agreements.map((agreement) => ({
    agreement_id: agreement.agreement_id,
    material_id: agreement.material_id,
    material_state: statusOf(agreement.material_id).state,
    from_team: agreement.from_team,
    to_holder: agreement.to_holder,
    redistribution_allowed: agreement.redistribution_allowed,
    status: agreement.status,
  }));
}

/** 真实性总览：运行、失败留存、证据链完整的主张、冻结支系与有效转移。 */
export function integrityOverview({ runs, claims, frozenBranches, agreements }) {
  const failed = runs.filter((run) => run.outcome === "failed");
  return {
    runs_total: runs.length,
    runs_failed_retained: failed.length,
    claims_registered: claims.length,
    claims_with_complete_evidence: claims.filter((claim) => claim.evidence_complete).length,
    frozen_branches: frozenBranches,
    transfers_active: agreements.filter((agreement) => agreement.status === "active").length,
    basis: "仅统计可核验的实验、谱系与流转记录；不以奖项或论文数量代替实验真实性",
  };
}
