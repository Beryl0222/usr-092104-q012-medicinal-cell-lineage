import assert from "node:assert/strict";
import test from "node:test";

import { LineageService } from "../src/service.js";

const NOW = "2026-10-01T08:00:00+08:00";

function buildEvidence() {
  const service = new LineageService({ now: () => NOW });
  service.accessionMaterial({ material_id: "M1", strain_name: "黄芪毛状根", team: "代谢组" });
  service.completeRun({ run_id: "R1", team: "代谢组", protocol: "LC-MS 定量", parameters: { 培养天数: 28 }, material_ids: ["M1"], outcome: "success" });
  service.registerRawData({ run_id: "R1", data_ref: "lcms://raw/R1", hash: "sha256:aa", instrument: "LC-MS-02" });
  service.registerRawData({ run_id: "R1", data_ref: "lcms://raw/R1-re", hash: "sha256:bb", instrument: "LC-MS-02" });
  service.versionAnalysis({ run_id: "R1", analysis_ref: "analysis://R1/v1", software: "MS-DIAL 4.9" });
  service.versionAnalysis({ run_id: "R1", analysis_ref: "analysis://R1/v2", software: "MS-DIAL 4.9", parameters: { 峰阈值: 1e4 } });
  service.versionInterpretation({ run_id: "R1", interpretation_ref: "interp://R1/v1", author: "李某", note: "初判升高" });
  service.completeRun({ run_id: "R2", team: "代谢组", protocol: "LC-MS 定量", material_ids: ["M1"], outcome: "failed", failure_reason: "仪器中途掉线" });
  return service;
}

test("原始数据、分析结果、解释各自维护独立版本链", () => {
  const service = buildEvidence();
  const run = service.getRun("R1");
  assert.equal(run.raw_data.length, 2);
  assert.equal(run.analyses.length, 2);
  assert.equal(run.interpretations.length, 1);
  assert.equal(service.evidence.latestOf("R1", "raw_data").version, 2);
  assert.equal(service.evidence.latestOf("R1", "analyses").version, 2);
  assert.equal(service.evidence.latestOf("R1", "interpretations").version, 1);
});

test("失败实验按保留规则留存且可检索，但默认不混入支持性结果", () => {
  const service = buildEvidence();
  const failed = service.getRun("R2");
  assert.equal(failed.retention_class, "failed_retained");

  assert.deepEqual(service.searchRuns({ team: "代谢组" }).map((run) => run.run_id), ["R1"]);
  assert.deepEqual(
    service.searchRuns({ team: "代谢组", include_failed: true }).map((run) => run.run_id),
    ["R1", "R2"],
  );
  assert.deepEqual(service.searchRuns({ outcome: "failed", include_failed: true }).map((run) => run.run_id), ["R2"]);
});

test("失败实验必须记录失败原因", () => {
  const service = new LineageService({ now: () => NOW });
  assert.throws(() => service.completeRun({ run_id: "RX", team: "t", outcome: "failed" }), /failure_reason/);
});

test("主张返回具体样本、参数与原始观测，失败证据单列", () => {
  const service = buildEvidence();
  service.registerClaim({
    claim_id: "C1",
    statement: "AmAS 过表达提高黄芪甲苷产量",
    team: "代谢组",
    material_ids: ["M1"],
    run_ids: ["R1", "R2"],
    parameter_refs: ["培养天数"],
    observation_refs: ["lcms://raw/R1", "lcms://raw/不存在"],
  });
  const evidence = service.claimEvidence("C1");
  assert.deepEqual(evidence.materials, [{ material_id: "M1", state: "available" }]);
  assert.deepEqual(evidence.parameters["培养天数"], [28]);
  assert.equal(evidence.observations.length, 1);
  assert.equal(evidence.observations[0].run_id, "R1");
  assert.deepEqual(evidence.missing_observations, ["lcms://raw/不存在"]);
  assert.deepEqual(evidence.failed_runs.map((run) => run.run_id), ["R2"]);
  assert.equal(evidence.at_risk, false);
});

test("主张依赖的样本被冻结时标记 at_risk", () => {
  const service = buildEvidence();
  service.registerClaim({ claim_id: "C2", statement: "s", team: "代谢组", material_ids: ["M1"], run_ids: ["R1"] });
  service.freezeBranch({ material_id: "M1", reason: "mix_up", detail: "两批冻存管疑似混样" });
  assert.equal(service.claimEvidence("C2").at_risk, true);
});
