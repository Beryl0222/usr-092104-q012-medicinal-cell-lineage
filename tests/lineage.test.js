import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LineageService } from "../src/service.js";

const NOW = "2026-10-01T08:00:00+08:00";
const makeService = () => new LineageService({ now: () => NOW });

function buildLineage() {
  const service = makeService();
  service.accessionMaterial({ material_id: "ROOT", species: "Astragalus membranaceus", strain_name: "黄芪毛状根", team: "种质组" });
  service.recordPassage({ passage_id: "PS-1", parent_material_id: "ROOT", child_material_id: "P1", passage_number: 1, operator: "王某", team: "种质组" });
  service.recordAliquot({ child_material_id: "P1-A", parent_material_id: "P1", vial_count: 6, freezer_location: "液氮罐 A-3" });
  service.recordAliquot({ child_material_id: "P1-B", parent_material_id: "P1", vial_count: 6, freezer_location: "液氮罐 B-1" });
  service.introduceConstruct({ child_material_id: "OE", parent_material_id: "P1-A", construct: { vector: "pCAMBIA1301", gene: "AmAS" } });
  return service;
}

test("传代、分装、基因构建形成祖先与后代关系", () => {
  const service = buildLineage();
  assert.deepEqual(service.ancestry("OE"), ["P1-A", "P1", "ROOT"]);
  assert.deepEqual(
    service.descendantsOf("P1").map((entry) => entry.material_id).sort(),
    ["OE", "P1-A", "P1-B"],
  );
  assert.equal(service.vialStatus("OE").state, "available");
});

test("冻存管档案回答祖先、污染检查与当前可用状态", () => {
  const service = buildLineage();
  service.recordContaminationCheck({ material_id: "P1-A", check_type: "支原体", result: "pass", method: "PCR", lab: "平台检测室" });
  const report = service.vialReport("P1-A");
  assert.deepEqual(report.ancestry, ["P1", "ROOT"]);
  assert.equal(report.contamination_checks.length, 1);
  assert.equal(report.status.state, "available");
});

test("污染只冻结受影响支系，姊妹支系与亲本保持可用", () => {
  const service = buildLineage();
  service.recordContaminationCheck({ material_id: "P1-A", check_type: "支原体", result: "fail", method: "PCR", lab: "平台检测室" });
  service.freezeBranch({ material_id: "P1-A", reason: "contamination", detail: "支原体阳性" });

  assert.equal(service.vialStatus("P1-A").state, "frozen");
  assert.equal(service.vialStatus("OE").state, "frozen", "后代随支系冻结");
  assert.equal(service.vialStatus("OE").frozen_at_branch, "P1-A");
  assert.equal(service.vialStatus("P1-B").state, "available", "姊妹支系不受影响");
  assert.equal(service.vialStatus("P1").state, "available", "亲本不受影响");
  assert.equal(service.vialStatus("ROOT").state, "available");

  service.releaseBranch({ material_id: "P1-A", resolution: "复检阴性，解冻" });
  assert.equal(service.vialStatus("OE").state, "available");
});

test("混样与标签争议同样按支系冻结，非法原因被拒绝", () => {
  const service = buildLineage();
  service.freezeBranch({ material_id: "P1-B", reason: "label_dispute", detail: "冻存管标签与记录不符" });
  assert.equal(service.vialStatus("P1-B").state, "frozen");
  assert.equal(service.vialStatus("P1-A").state, "available");
  assert.throws(() => service.freezeBranch({ material_id: "P1", reason: "其他" }), /冻结原因/);
});

test("销毁状态优先，未知材料为 unknown", () => {
  const service = buildLineage();
  service.discardMaterial({ material_id: "P1-B", reason: "复苏失败" });
  assert.equal(service.vialStatus("P1-B").state, "discarded");
  assert.equal(service.vialStatus("NOPE").state, "unknown");
});

test("黄芪场景样例可完整回放并回答谱系问题", async () => {
  const events = JSON.parse(await readFile(new URL("../data/huangqi-scenario.json", import.meta.url), "utf8"));
  const service = LineageService.fromEvents(events);

  const report = service.vialReport("HQ-OE-AS");
  assert.deepEqual(report.ancestry, ["HQ-P1-002", "HQ-ROOT-001"]);
  assert.equal(report.status.state, "available");

  const aliquot = service.vialReport("HQ-P1-002-A");
  assert.equal(aliquot.derived_by, "aliquot");

  const evidence = service.claimEvidence("CLM-ASG-01");
  assert.equal(evidence.materials[0].state, "available");
  assert.deepEqual(evidence.parameters["培养天数"], [28]);
  assert.equal(evidence.observations[0].data_ref, "lcms://raw/RUN-2026-014");
  assert.equal(evidence.at_risk, false);
});
