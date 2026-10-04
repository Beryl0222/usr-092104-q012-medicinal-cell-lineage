import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

const base = {
  event_id: "e-1",
  event_type: "MATERIAL_ACCESSIONED",
  aggregate_type: "biological_material",
  aggregate_id: "m-1",
  occurred_at: "2026-10-01T08:00:00+08:00",
  version: 1,
  summary: "测试事件",
};

test("合法事件通过校验", () => {
  assert.deepEqual(validateEvent(base), []);
  assert.deepEqual(validateEvent({ ...base, payload: { species: "Astragalus membranaceus" } }), []);
});

test("缺少字段、非法版本与未知类型被拒绝", () => {
  const { event_id: _omit, ...missing } = base;
  assert.ok(validateEvent(missing).some((msg) => msg.includes("event_id")));
  assert.ok(validateEvent({ ...base, version: 0 }).some((msg) => msg.includes("version")));
  assert.ok(validateEvent({ ...base, event_type: "PAPER_PUBLISHED" }).some((msg) => msg.includes("未知事件类型")));
  assert.ok(validateEvent({ ...base, aggregate_type: "award" }).some((msg) => msg.includes("未知聚合类型")));
  assert.ok(validateEvent({ ...base, occurred_at: "不是时间" }).some((msg) => msg.includes("occurred_at")));
  assert.ok(validateEvent({ ...base, payload: [1, 2] }).some((msg) => msg.includes("payload")));
});
