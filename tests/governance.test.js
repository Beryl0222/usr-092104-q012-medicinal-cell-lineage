import assert from "node:assert/strict";
import test from "node:test";

import { LineageService } from "../src/service.js";

const NOW = "2026-10-01T08:00:00+08:00";

function buildGovernance() {
  const service = new LineageService({ now: () => NOW });
  service.accessionMaterial({ material_id: "M1", strain_name: "黄芪毛状根", team: "种质组" });
  service.completeRun({ run_id: "R-EXT", team: "外部合作所", protocol: "复测", material_ids: ["M1"], outcome: "success" });
  service.registerClaim({ claim_id: "C-EXT", statement: "外部复测结论", team: "外部合作所", material_ids: ["M1"], run_ids: ["R-EXT"] });
  return service;
}

const terms = {
  purpose: "黄芪甲苷复测",
  term_end: "2027-12-31",
  attribution: "署名：本所种质组",
  redistribution_allowed: false,
};

test("转移前必须核对用途、期限、署名与再分发限制", () => {
  const service = buildGovernance();
  const violations = service.transferPreflight("M1", { purpose: "复测" });
  assert.ok(violations.some((msg) => msg.includes("term_end")));
  assert.ok(violations.some((msg) => msg.includes("attribution")));
  assert.ok(violations.some((msg) => msg.includes("redistribution_allowed")));
  assert.throws(() => service.approveTransfer({ agreement_id: "T1", material_id: "M1", from_team: "种质组", to_holder: "外部合作所", purpose: "复测" }), /转移核对未通过/);
});

test("冻结或未知材料不得外转", () => {
  const service = buildGovernance();
  service.freezeBranch({ material_id: "M1", reason: "contamination", detail: "待复检" });
  assert.ok(service.transferPreflight("M1", terms).some((msg) => msg.includes("不可用")));
  assert.ok(service.transferPreflight("GHOST", terms).some((msg) => msg.includes("未登记")));
});

test("撤回指出受影响的持有方（含再分发链）与研究", () => {
  const service = buildGovernance();
  service.approveTransfer({ agreement_id: "T1", material_id: "M1", from_team: "种质组", to_holder: "外部合作所", custodian: "陈某", ...terms });
  service.approveTransfer({
    agreement_id: "T2",
    material_id: "M1",
    from_team: "外部合作所",
    to_holder: "第三方平台",
    ...terms,
    redistribution_allowed: true,
  });

  const impact = service.withdrawTransfer({ agreement_id: "T1", reason: "用途超出原协议" });
  assert.deepEqual([...impact.holders].sort(), ["第三方平台", "外部合作所"].sort());
  assert.deepEqual(impact.affected_claims, ["C-EXT"]);
  assert.deepEqual(impact.affected_runs, ["R-EXT"]);
  assert.equal(service.transfers.getAgreement("T1").status, "withdrawn");
});

test("人员离岗回收全部授权并列出在管材料，离岗后不得访问", () => {
  const service = buildGovernance();
  service.authorizePersonnel({ person_id: "陈某", scope: "freezer:A-3", resource: "液氮罐 A-3" });
  service.authorizePersonnel({ person_id: "陈某", scope: "data:lcms", resource: "LC-MS 原始数据" });
  service.approveTransfer({ agreement_id: "T9", material_id: "M1", from_team: "种质组", to_holder: "外部合作所", custodian: "陈某", ...terms });
  assert.equal(service.accessCheck("陈某", "data:lcms"), true);

  const report = service.offboardPersonnel("陈某");
  assert.deepEqual(report.revoked_scopes.sort(), ["data:lcms", "freezer:A-3"]);
  assert.deepEqual(report.must_return, [{ agreement_id: "T9", material_id: "M1", holder: "外部合作所" }]);
  assert.equal(service.accessCheck("陈某", "data:lcms"), false, "离岗后授权一律失效");
  assert.throws(() => service.offboardPersonnel("陈某"), /已离岗/);
});
