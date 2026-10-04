# 中药细胞株科研谱系

本仓库保存中药细胞株科研谱系的领域词汇、事件约定与基础校验代码，供相关单位统一对象身份、事件顺序和版本语义，并提供完整的谱系服务实现：任一冻存管都能确认祖先与当前可用状态，任一科学主张都能回到具体样本、参数与原始观测。

## 目录

- `contracts/domain.schema.json`：领域事件信封与稳定枚举。
- `data/sample.json`：一条中文联调样例。
- `data/huangqi-scenario.json`：黄芪毛状根（登记别名“胡氏细胞株后代”）完整事件流样例。
- `src/`：事件校验、事件存储、投影与服务门面。
- `tests/`：领域资料一致性检查与服务行为测试。

## 事件模型

所有状态变更都以统一信封落账：`event_id / event_type / aggregate_type / aggregate_id / occurred_at / version / summary / payload`，其中 `version` 按聚合连续递增，实验室之间用 `exportEvents()` / `importEvents()` 交换同一信封（按 `event_id` 去重）。

聚合类型：`biological_material`、`culture_passage`、`experiment_run`、`research_claim`、`transfer_agreement`、`personnel`。

事件目录：

| 类别 | 事件 |
| --- | --- |
| 谱系 | `MATERIAL_ACCESSIONED`、`PASSAGE_RECORDED`、`ALIQUOT_CREATED`、`CONSTRUCT_INTRODUCED`、`CONTAMINATION_CHECK_RECORDED`、`BRANCH_FROZEN`、`BRANCH_RELEASED`、`MATERIAL_DISCARDED` |
| 证据 | `RUN_COMPLETED`、`RAW_DATA_REGISTERED`、`ANALYSIS_VERSIONED`、`INTERPRETATION_VERSIONED` |
| 主张 | `CLAIM_REGISTERED` |
| 治理 | `TRANSFER_APPROVED`、`TRANSFER_WITHDRAWN`、`PERSONNEL_AUTHORIZED`、`PERSONNEL_AUTHORIZATION_REVOKED`、`PERSONNEL_OFFBOARDED` |

## 服务约定（`src/service.js` 的 `LineageService`）

- **谱系**：传代、分装、基因构建形成父子边；`vialReport(id)` 返回任一冻存管的祖先、后代、污染检查与当前状态（`available / frozen / discarded / unknown`）。
- **支系冻结**：混样（`mix_up`）、污染（`contamination`）、标签争议（`label_dispute`）只冻结被标记材料及其后代，亲本与姊妹支系保持可用；`releaseBranch` 解冻。
- **证据留版**：原始数据、分析结果、解释各自维护独立版本链；失败实验必须记录失败原因，按保留等级（默认 `failed_retained`）留存，`searchRuns({ include_failed: true })` 始终可检索。
- **主张回溯**：`claimEvidence(id)` 返回具体样本及其状态、参数取值与原始观测；失败证据单列，依赖样本异常时标记 `at_risk`。
- **对外转移**：`approveTransfer` 前强制核对用途、期限、署名与再分发限制，冻结或未登记材料不得外转；`withdrawTransfer` 返回受影响的全部持有方（含再分发链）与相关研究。
- **人员离岗**：`offboardPersonnel` 回收全部授权、列出必须归还的在管材料，离岗后 `accessCheck` 一律拒绝。
- **管理审计**：`reproducibilityReport`（跨团队复现）、`materialFlowReport`（材料流转）、`integrityOverview`（真实性总览）只统计可核验的实验、谱系与流转记录，不以奖项或论文数量代替实验真实性。

## 本地检查

```bash
npm test
```
