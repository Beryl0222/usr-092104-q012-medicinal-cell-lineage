import assert from "node:assert/strict";
import test from "node:test";

import { LineageService } from "../src/service.js";

const NOW = "2026-10-01T08:00:00+08:00";

function buildAudit() {
  const service = new LineageService({ now: () => NOW });
  service.accessionMaterial({ material_id: "M1", strain_name: "黄芪毛状根", team: "种质组" });
  service.completeRun({ run_id: "R-A", team: "代谢组", protocol: "p", material_ids: ["M1"], outcome: "success" });
  service.completeRun({ run_id: "R-B", team: "药理组", protocol: "p", material_ids: ["M1"], outcome: "success" });
  service.completeRun({ run_id: "R-C", team: "代谢组", protocol: "p", material_ids: ["M1"], outcome: "failed", failure_reason: "污染" });
  service.registerClaim({ claim_id: "C1", statement: "s", team: "代谢组", material_ids: ["M1"], run_ids: ["R-A", "R-B"] });
  service.registerClaim({ claim_id: "C2", statement: "单团队结论", team: "代谢组", material_ids: ["M1"], run_ids: ["R-A"] });
  service.approveTransfer({
    agreement_id: "T1",
    material_id: "M1",
    from_team: "种质组",
    to_holder: "外部合作所",
    purpose: "复测",
    term_end: "2027-12-31",
    attribution: "署名：种质组",
    redistribution_allowed: false,
  });
  return service;
}

test("跨团队复现按成功运行的团队数判定", () => {
  const service = buildAudit();
  const cross = service.reproducibilityReport("C1");
  assert.equal(cross.cross_team_reproducible, true);
  assert.deepEqual(cross.teams.sort(), ["代谢组", "药理组"]);
  assert.equal(service.reproducibilityReport("C2").cross_team_reproducible, false);
});

test("材料流转报告列出全部协议与材料当前状态", () => {
  const service = buildAudit();
  const flow = service.materialFlowReport();
  assert.equal(flow.length, 1);
  assert.deepEqual(flow[0], {
    agreement_id: "T1",
    material_id: "M1",
    material_state: "available",
    from_team: "种质组",
    to_holder: "外部合作所",
    redistribution_allowed: false,
    status: "active",
  });
});

test("真实性总览只统计可核验记录，失败实验计入留存", () => {
  const service = buildAudit();
  const overview = service.integrityOverview();
  assert.equal(overview.runs_total, 3);
  assert.equal(overview.runs_failed_retained, 1);
  assert.equal(overview.claims_registered, 2);
  assert.equal(overview.transfers_active, 1);
  assert.match(overview.basis, /不以奖项或论文数量/);
});

test("实验室之间用事件信封交换记录，导入方得到相同谱系且去重", () => {
  const source = buildAudit();
  source.recordAliquot({ child_material_id: "M1-V1", parent_material_id: "M1", vial_count: 3, freezer_location: "A-3" });
  const envelope = source.exportEvents();

  const replica = LineageService.fromEvents(envelope);
  assert.deepEqual(replica.ancestry("M1-V1"), ["M1"]);
  assert.equal(replica.vialStatus("M1-V1").state, "available");
  assert.equal(replica.exportEvents().length, envelope.length);

  const again = replica.importEvents(envelope);
  assert.equal(again.length, 0, "重复导入按 event_id 去重");

  replica.recordContaminationCheck({ material_id: "M1-V1", check_type: "支原体", result: "pass", method: "PCR", lab: "本所" });
  assert.equal(replica.exportEvents().length, envelope.length + 1, "导入后仍可继续落账");
});

test("版本不连续或未知类型的事件被拒绝入账", () => {
  const service = new LineageService({ now: () => NOW });
  service.accessionMaterial({ material_id: "M1", strain_name: "s", team: "t" });
  assert.throws(
    () =>
      service.ingest({
        event_id: "bad-1",
        event_type: "MATERIAL_DISCARDED",
        aggregate_type: "biological_material",
        aggregate_id: "M1",
        occurred_at: NOW,
        version: 5,
        summary: "跳号事件",
      }),
    /版本不连续/,
  );
});
