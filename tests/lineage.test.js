import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildServiceFromLog, LineageService } from "../src/service.js";
import { validateEvent } from "../src/validator.js";

const LOG = new URL("../data/event-log.json", import.meta.url);

async function load() {
  const text = await readFile(LOG, "utf8");
  const events = JSON.parse(text);
  return { service: (await buildServiceFromLog(LOG)).service, events };
}

test("整份事件日志零拒收，且每个信封单独通过校验", async () => {
  const { events } = await load();
  const { report } = await buildServiceFromLog(LOG);
  assert.equal(report.rejected, 0, JSON.stringify(report.rejections, null, 2));
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `${event.event_id} 校验失败`);
  }
});

test("冻存管 A 可回溯到武川外植体祖先，经历传代与基因构建", async () => {
  const { service } = await load();
  const status = service.statusOf("V-AMCAS-01-A");
  assert.equal(status.found, true);
  assert.equal(status.vial_label, "胡氏-AmCAS-01-A");
  assert.deepEqual(status.ancestor_ids, [
    "MAT-AMCAS-01",
    "MAT-HR-01-P12",
    "MAT-HR-01-P05",
    "MAT-HR-01",
    "MAT-EX-000",
  ]);
  // 祖先链上能读到构建事件与传代参数
  const lineage = service.materials.lineageOf("V-AMCAS-01-A");
  const constructEdge = lineage.ancestor_path.find((s) => s.edge.kind === "construct");
  assert.equal(constructEdge.edge.detail.construct_id, "CN-AMCAS");
  const passageEdge = lineage.ancestor_path.find((s) => s.edge.kind === "passage");
  assert.ok(passageEdge.edge.detail.conditions.shaker_rpm);
});

test("污染只冻结 B 管及其后代，旁支 A/C 不受影响", async () => {
  const { service } = await load();
  assert.equal(service.statusOf("V-AMCAS-01-B").frozen, true);
  assert.equal(service.materials.freezeStatus("MAT-HR-01-B-P13").frozen, true);
  assert.equal(service.statusOf("V-AMCAS-01-A").frozen, false);
  assert.equal(service.statusOf("V-AMCAS-01-C").frozen, false);
  // 母系 MAT-AMCAS-01 不被下游冻存管的冻结反向波及
  assert.equal(service.materials.freezeStatus("MAT-AMCAS-01").frozen, false);
});

test("标签争议仅冻结混样支系，裁定后解除", async () => {
  const { service } = await load();
  const dispute = service.materials.disputes.get("DSP-2026-001");
  assert.equal(dispute.status, "resolved");
  assert.equal(dispute.resolution, "identity_upheld");
  assert.equal(service.materials.freezeStatus("MAT-POOL-09").frozen, false);
  // 污染源冻结仍然有效，与标签争议相互独立
  assert.equal(service.statusOf("V-AMCAS-01-B").frozen, true);
});

test("高产主张返回具体样本、参数与原始观测，且撤回状态可见", async () => {
  const { service } = await load();
  const evidence = service.evidenceFor("CLAIM-2026-HIGH-01");
  assert.equal(evidence.claim.status, "withdrawn");
  assert.equal(evidence.sound, true);
  assert.deepEqual(evidence.gaps, []);
  const run = evidence.runs.find((r) => r.run_id === "RUN-2026-001");
  assert.equal(run.parameters.column, "ZORBAX SB-C18 4.6x250 mm");
  assert.ok(run.materials.some((m) => m.material_id === "MAT-AMCAS-01"));
  assert.deepEqual(evidence.raw_observations, ["ART-HPLC-001@1"]);
});

test("原始数据/分析/解释各自留版：v1 不被 v2 覆盖，只能上层引用下层", async () => {
  const { service } = await load();
  const peakV1 = service.research.getArtifactVersion("ART-PEAK-001", 1);
  const peakV2 = service.research.getArtifactVersion("ART-PEAK-001", 2);
  assert.ok(peakV1 && peakV2);
  assert.notEqual(peakV1.content_hash.value, peakV2.content_hash.value);
  // 分析必须指向原始观测，不能反向
  const trace = service.research.traceArtifact("ART-MEMO-001", 2);
  assert.deepEqual(trace.errors, []);
});

test("失败实验按保留规则仍可检索", async () => {
  const { service } = await load();
  const all = service.research.searchRuns({});
  assert.ok(all.some((r) => r.run_id === "RUN-2026-002" && r.outcome === "failure"));
  const onlySuccess = service.research.searchRuns({ includeFailures: false });
  assert.ok(!onlySuccess.some((r) => r.run_id === "RUN-2026-002"));
  const retention = service.research.retentionStatus("2026-10-04");
  const failed = retention.find((r) => r.run_id === "RUN-2026-002");
  assert.equal(failed.within_retention, true);
  assert.equal(failed.retain_until, "2036-03-18");
  assert.equal(failed.searchable, true);
});

test("转出前核对：条款齐全但冻结管不可转出", async () => {
  const { service } = await load();
  const check = service.compliance.verifyTransfer("TR-2026-007", service.materials, {
    asOf: "2026-02-09",
  });
  assert.equal(check.terms_complete, true);
  assert.equal(check.shippable, false);
  assert.ok(check.problems.some((p) => p.includes("V-AMCAS-01-B") && p.includes("冻结")));
});

test("撤回指出受影响持有方、转移与下游研究", async () => {
  const { service } = await load();
  const claim = service.research.claims.get("CLAIM-2026-HIGH-01");
  const impact = service.compliance.withdrawalImpact(claim, service.research, service.materials);
  assert.deepEqual(impact.holders_to_notify.sort(), ["LAB-A", "LAB-C"]);
  assert.ok(impact.affected_transfers.some((t) => t.transfer_id === "TR-2026-007" && t.to_lab === "LAB-C"));
  assert.ok(impact.downstream_claims.some((c) => c.claim_id === "CLAIM-2026-SCALE-02"));
  assert.ok(impact.affected_runs.some((r) => r.run_id === "RUN-LABC-2026-003"));
});

test("人员离岗：有未授权带走记录不得放行；清白者放行", async () => {
  const { service } = await load();
  const h02 = service.compliance.departureStatus("H02");
  assert.equal(h02.clear, false);
  assert.ok(h02.problems.some((p) => p.includes("未授权带走")));
  assert.equal(service.compliance.departureStatus("A10").clear, true);
});

test("管理者报告按跨团队复现与实验真实性统计，而非奖项/论文数量", async () => {
  const { service } = await load();
  const report = service.managementReport();
  const repro = report.cross_lab_reproduction.find((x) => x.protocol_id === "PR-CONTENT-HPLC-01");
  assert.equal(repro.reproduced_across_labs, true);
  assert.deepEqual(repro.reproducing_labs.sort(), ["LAB-A", "LAB-C"]);
  assert.ok(!("awards" in report) && !("paper_count" in report));
  assert.equal(report.experiments.failed_or_inconclusive, 1);
  assert.equal(report.experiments.failed_kept_searchable, 1);
  assert.equal(report.claims.withdrawn, 1);
});

test("收录规则：event_id 幂等、版本只追加、坏信封进拒收清单", async () => {
  const service = new LineageService();
  const good = {
    event_id: "E1",
    event_type: "MATERIAL_ACCESSIONED",
    aggregate_type: "biological_material",
    aggregate_id: "M1",
    occurred_at: "2026-01-01T00:00:00+08:00",
    version: 1,
    summary: "s",
    lab_id: "LAB-X",
    payload: { material_id: "M1", kind: "explant", species: "Astragalus", custodian_lab: "LAB-X" },
  };
  assert.equal(service.ingest(good).accepted, true);
  assert.equal(service.ingest(good).duplicated, true);
  assert.equal(service.materials.materials.size, 1);

  const reordered = { ...good, event_id: "E2", version: 1 };
  const r2 = service.ingest(reordered);
  assert.equal(r2.accepted, false);
  assert.ok(r2.reasons.some((x) => x.includes("版本乱序")));

  const malformed = { event_id: "E3" };
  assert.equal(service.ingest(malformed).accepted, false);
  assert.equal(service.rejections.length, 2);
});

test("跨实验室信封收录：LAB-C 的复现实验以同一交换边界进入", async () => {
  const { service } = await load();
  assert.equal(service.eventsByLab.get("LAB-C"), 3);
  const labCRun = service.research.runs.get("RUN-LABC-2026-003");
  assert.equal(labCRun.lab_id, "LAB-C");
  assert.equal(labCRun.outcome, "success");
});
