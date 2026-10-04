import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateEvent,
  KNOWN_EVENT_TYPES,
  KNOWN_AGGREGATE_TYPES,
  PAYLOAD_RULES,
} from "../src/validator.js";

const readJson = (name) =>
  readFile(new URL(`../contracts/${name}`, import.meta.url), "utf8").then(JSON.parse);

test("旧版七字段样例无需 payload 仍通过信封校验（向后兼容）", async () => {
  const sample = JSON.parse(
    await readFile(new URL("../data/sample.json", import.meta.url), "utf8")
  );
  assert.deepEqual(validateEvent(sample), []);
});

test("校验代码与信封 schema 的枚举保持一致（防漂移）", async () => {
  const schema = await readJson("domain.schema.json");
  assert.deepEqual(
    [...KNOWN_EVENT_TYPES].sort(),
    [...schema.properties.event_type.enum].sort()
  );
  assert.deepEqual(
    [...KNOWN_AGGREGATE_TYPES].sort(),
    [...schema.properties.aggregate_type.enum].sort()
  );
});

test("每类事件载荷规则都能在 payloads schema 找到对应 \$def，且必填字段一致", async () => {
  const schema = await readJson("payloads.schema.json");
  for (const eventType of KNOWN_EVENT_TYPES) {
    const def = schema.$defs[eventType];
    assert.ok(def, `payloads.schema.json 缺少 $defs.${eventType}`);
    const rules = PAYLOAD_RULES[eventType];
    assert.ok(rules, `validator.js 缺少 ${eventType} 的载荷规则`);
    assert.deepEqual(
      [...(rules.required ?? [])].sort(),
      [...(def.required ?? [])].sort(),
      `${eventType} 必填字段与 schema 不一致`
    );
  }
});

test("载荷枚举值与 schema 内联枚举一致", async () => {
  const schema = await readJson("payloads.schema.json");
  for (const [eventType, rules] of Object.entries(PAYLOAD_RULES)) {
    const def = schema.$defs[eventType];
    for (const [field, allowed] of Object.entries(rules.enums ?? {})) {
      const prop = def.properties?.[field];
      if (prop?.enum) assert.deepEqual([...allowed].sort(), [...prop.enum].sort(), `${eventType}.${field}`);
    }
  }
});

test("缺字段、坏枚举、坏时间的信封被拒", () => {
  assert.ok(validateEvent({ event_id: "x" }).length > 0);
  assert.ok(
    validateEvent({
      event_id: "x",
      event_type: "NOPE",
      aggregate_type: "biological_material",
      aggregate_id: "m",
      occurred_at: "2026-01-01T00:00:00+08:00",
      version: 1,
      summary: "s",
    }).some((e) => e.includes("未知 event_type"))
  );
  assert.ok(
    validateEvent({
      event_id: "x",
      event_type: "MATERIAL_ACCESSIONED",
      aggregate_type: "biological_material",
      aggregate_id: "m",
      occurred_at: "2026-01-01 00:00:00",
      version: 1,
      summary: "s",
    }).some((e) => e.includes("RFC3339"))
  );
});

test("载荷校验：转移条款四要素缺一即报错", () => {
  const base = {
    event_id: "x",
    event_type: "TRANSFER_APPROVED",
    aggregate_type: "material_transfer",
    aggregate_id: "t",
    occurred_at: "2026-02-01T00:00:00+08:00",
    version: 1,
    summary: "s",
    payload: {
      transfer_id: "t",
      material_ids: ["v1"],
      from_lab: "A",
      to_lab: "B",
      approver_id: "p",
      terms: {
        intended_use: "u",
        valid_until: "2027-01-01",
        attribution: "attr",
        redistribution: "prohibited",
      },
    },
  };
  assert.deepEqual(validateEvent(base), []);
  const broken = JSON.parse(JSON.stringify(base));
  delete broken.payload.terms.redistribution;
  assert.ok(validateEvent(broken).some((e) => e.includes("redistribution")));
});
