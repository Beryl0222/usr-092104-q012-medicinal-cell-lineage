# 中药细胞株科研谱系服务

让任一冻存管都能确认祖先与当前可用状态，让一项科学主张返回具体样本、参数与原始观测；
污染、混样、标签争议只冻结受影响支系；材料对外转移前核对用途、期限、署名与再分发限制；
撤回主张时指出受影响的持有方与下游研究。实验室之间仍以**事件信封**交换记录。

## 设计原则

1. **只追加的事件信封**：事实以事件记录，`event_id` 全局唯一（跨团队重放幂等），同一 `aggregate_id` 的 `version` 严格递增；不回改、不删除，纸质笔记以 `occurred_at`（发生时间）+ `recorded_at`（补录时间）区分。
2. **材料是一张有向图**：传代、分装、基因构建、混样形成后代边。任一冻存管向上可回溯全部祖先（外植体 → Ri 诱导毛状根 → 传代 → 过表达构建 → 冻存管）。
3. **冻结沿后代边传播**：污染/混样/标签争议以支系根冻结，根及其后代不可用、不可转出，旁支与母系不受影响；可解除。
4. **证据三层各自留版**：`raw_observation`（仪器原始观测）→ `analysis`（分析结果）→ `interpretation`（解释）。版本不可覆盖，溯源边只能从上层指向较低层。
5. **失败实验照样留存与检索**：保留策略声明年限，失败/无定论实验不被藏起。
6. **主张必须落到证据**：主张解析为实验（材料、参数、仪器、操作人）+ 具体版本产物 + 原始观测；任何断裂列为 gaps，不静默通过。
7. **真实性指标**：管理报告统计跨团队复现、材料流转、证据完整度、失败保留，不含奖项或论文数量。

## 目录

- `contracts/domain.schema.json`：事件信封（七必填字段为最低交换边界，新增字段可选，旧事件仍有效）。
- `contracts/payloads.schema.json`：19 类事件的类型化载荷定义（按 `event_type` 索引）。
- `data/event-log.json`：黄芪毛状根「胡氏细胞株」完整联调场景（40 个信封，2 个实验室）。
- `src/validator.js`：信封 + 载荷校验（零依赖，规则表与 schema 由测试比对防漂移）。
- `src/materials.js`：材料谱系图、祖先/后代、支系冻结与解除、标签争议。
- `src/research.js`：实验登记、产物三层留版、主张证据解析、失败保留检索。
- `src/compliance.js`：转移四要素核对、持有方/在途跟踪、撤回影响面、离岗检查。
- `src/service.js`：收录规则（校验、幂等、版本顺序、拒收清单）与管理报告。
- `src/cli.js`：命令行查询入口。
- `tests/`：契约一致性 + 谱系/证据/合规场景测试。

## 事件类型

| 类别 | 事件 |
| --- | --- |
| 材料 | `MATERIAL_ACCESSIONED` `PASSAGE_RECORDED` `MATERIAL_ALIQUOTED` `MATERIAL_POOLED` `CONSTRUCT_INTRODUCED` |
| 质量/争议 | `QC_PERFORMED` `LINEAGE_QUARANTINED` `LINEAGE_RELEASED` `LABEL_DISPUTE_FILED` `LABEL_DISPUTE_RESOLVED` |
| 科研 | `RUN_COMPLETED` `ARTIFACT_VERSIONED` `CLAIM_REGISTERED` `CLAIM_WITHDRAWN` `RETENTION_POLICY_DECLARED` |
| 转移/人员 | `TRANSFER_APPROVED` `MATERIAL_SHIPPED` `MATERIAL_RECEIVED` `PERSONNEL_DEPARTURE_CHECKED` |

转移条款四要素（`terms`）：`intended_use`（用途）、`valid_until`（期限）、`attribution`（署名）、`redistribution`（再分发：`prohibited` / `allowed_with_written_consent`）。

## 命令行

```bash
# 冻存管：祖先、质检、持有方、冻结状态
node src/cli.js status V-AMCAS-01-A
node src/cli.js ancestors V-AMCAS-01-A

# 科学主张 -> 实验/样本/参数/原始观测
node src/cli.js claim CLAIM-2026-HIGH-01

# 实验检索（默认含失败实验）
node src/cli.js runs --material MAT-AMCAS-01
node src/cli.js runs --outcome failure

# 转出前核对（四要素、期限、冻结支系、当前持有方）
node src/cli.js transfer TR-2026-007

# 撤回影响面（持有方、在途转移、下游研究）
node src/cli.js withdraw CLAIM-2026-HIGH-01

# 人员离岗放行检查
node src/cli.js departure H02

# 管理者跨团队复现与材料流转报告
node src/cli.js report
```

也可指定其他团队的事件日志：`node src/cli.js report --log /path/to/lab-events.jsonl`（支持 JSON 数组与 JSONL）。

## 联调场景（data/event-log.json）

武川蒙古黄芪外植体 → C58C1（Ri 质粒）诱导胡氏 HR-01 毛状根 → 传代至 P12 → 引入 AmCAS 过表达构建 → 冻存管 A/B/C：

- B 管复苏污染，**仅 B 及其后代 B-P13 冻结**，A/C 旁支继续可用；
- C 管与对照混样 POOL-09 引发标签争议，仅冻结混样支系，SSR 判型确认身份后解除；
- HPLC-ELSD 测产：原始色谱、峰面积定量 v1/v2、解释备忘录 v1/v2 全部留版，主张按 v2 登记；
- 摇床温控失败批次按 10 年保留规则留存且可检索；
- A 管转移 LAB-C：四要素齐全，但发运核对拦截了同单冻结的 B 管；
- LAB-C 同方案独立复测（跨团队复现，绝对值偏低）；
- H02 离岗 U 盘检出未授权原始数据 → 拒绝放行；A10 清点齐全 → 放行；
- 标准品配制偏差导致撤回高产主张 → 影响面指出持有方 LAB-A/LAB-C、转移单、放大下游主张与两实验室相关实验。

## 本地检查

```bash
npm test
```

测试包含：schema 与校验代码枚举/必填字段一致性、整份日志零拒收、祖先回溯、支系隔离、证据三层解析、失败保留、转移拦截、撤回影响面、离岗拦截、幂等与版本顺序、跨实验室复现报告。
