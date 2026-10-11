# v1-sync issue F（#52）实现证据

范围：tasks 6.1–6.5；基线 `d1f330e`，分支 `codex/v1-sync-reconcile`。仅合成、已脱敏的 normalized 输入和覆盖；无网络、适配器、依赖或数据库结构变更。未提交，未修改 handoff 或 tasks 勾选。

## TDD 和提交建议

| 任务 | Red | Green | 建议提交标题 |
| --- | --- | --- | --- |
| 6.1 | 新 diff 模块缺失；补充 owner 字段回归后 1 项失败 | diff 5 passed | `feat(sync): compare canonical adapter-owned fields` |
| 6.2 | 覆盖模块缺失；认证失败仍替换旧状态的回归 1 项失败 | coverage 10 passed；数据库覆盖回归通过 | `feat(sync): gate reconciliation by authoritative coverage` |
| 6.3 | repository reconcile 未实现，数据库测试 5 项失败 | reconciliation 8 passed（含 6.2 集成场景） | `feat(store): reconcile state and events transactionally` |
| 6.4 | changes handler 模块缺失 | changes-handler 15 passed | `feat(sync): expose bounded exclusive change cursors` |
| 6.5 | 验证门，无人为构造的 Red | 新上下文只读审查 ready to merge；38 项针对性测试通过；完整检查见最终报告 | `docs(sync): record reconciliation verification evidence` |

建议提交正文（按对应任务使用）：

- 6.1: `- Compare canonical fields and preserve owner values with complete change snapshots`
- 6.2: `- Require complete selected scope coverage before deleting bound adapter entities`
- 6.3: `- Compare and publish state with append-only events under one writer transaction`
- 6.4: `- Validate cursors and page envelopes without skipping oversized events`
- 6.5: `- Record synthetic TDD, review evidence and deferred ownership integration`

## 已验证的边界

- source fetchedAt、对象键顺序和等价 due 日期不会产生事件；同一次更新包含所有字段变化，支持可选 due/score 移除。字段比较不依赖 hash。
- 归属由可信适配器提供精确 ownedIds（历史绑定加本次 id），字段所有权由 fields 提供。仅课程、assessment、source_item；任务和 module 不进入 reconciliation。course moduleId 和 assessmentsComplete 由当前存量值保留。
- threads 永不以第一页证明删除。PDF scope 应是一份文件的全部页；normalizationComplete 包含全部页替换校验。失败、不完整和未选择范围保留缺失项；认证等失败码同时阻止更新。
- BEGIN IMMEDIATE 后才读现状并比较；两个独立连接重复发布不会重复发事件。重开数据库、删除实体后 seq 保留递增；no-op 和回滚不推进可见游标。
- 合成失败注入覆盖已插入事件后的 append 失败、事务内事件 schema 失败、后续 scope 验证失败；没有触碰真实数据库。两个连接测试是独立连接交替写入，不是多进程压力测试。
- changes handler 使用现有 envelope，按实际 UTF-8 序列化大小分页；超大事件停在下一个游标并返回 LIMIT_EXCEEDED，不跳过、不截断。CLI/registry/MCP/HTTP 未接线。
- `npm run build`、`openspec validate v1-sync --strict`、`git diff --check` 通过。审查独立复跑 38 项测试。

## 开放问题与未验证

- C/E/G 接线时如何从可信的 provider/course/collection（PDF 为 file）操作绑定恢复历史 ownedIds 和 fields？现有实体不记录完整 collection/file 归属。本次只消费显式合成绑定，不推断归属、不建立持久化绑定表；若需要新表/字段，须单独提出设计问题，不能扩展本次 schema。
- 新输入须已经通过现有 adapter privacy boundary；这里不接受 raw capture 作为输入，也不替代 scope-wide redaction。真实 Canvas、PDF 适配器和 live 数据未验证。
- 不做迁移或重建；旧迁移游标回归由现有 test/store/sync-upgrade.test.ts 在完整检查中验证。
