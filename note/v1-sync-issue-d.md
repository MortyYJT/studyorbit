# v1-sync issue D 实施证据

- 范围：GitHub #48，tasks 4.1–4.5；分支 `codex/v1-sync-ed`，基线 `0254274`。
- 直接消费 EdReader / merged EdTransport，复用 runEdCapture 与 Q1 问题引用；不增加端点、依赖、模型调用、schema 或存储。
- 只输出验证且脱敏的 SourceItems 与字段引文；不发布缺少已验证权重、考试/final/hurdle 分类的 Assessment。
- 共享 SourceItem 出口支持 Canvas/Ed；Canvas 仅合成输入验证，真实生产适配器由 issue C 接入。事件消费者须使用出口返回值，不得重新使用原始输入。
- 原始 snapshot 回调仍限私有 capture 存储。完整验证范围先采集嵌套作者/people 姓名，再处理所有出口正文、标题、URL；保留 Q1 问题 ref。

| 任务 | Red 证据 | Green 证据 |
| --- | --- | --- |
| 4.1 | 新适配器缺失，suite 导入失败（修复测试语法后重跑） | ed-adapter：5 passed |
| 4.2 | attempt 字段证据缺失：5 failed / 1 passed | ed-facts：6 passed |
| 4.3 | 共享 redactor 缺失，suite 导入失败；审查回归 staff allow-list：1 failed | redaction：5 passed |
| 4.4 | 共用出口缺失，suite 导入失败；审查回归 URL 异常：1 failed | privacy-boundary：16 passed |
| 4.5 | 六位标注学号/slide 归属回归：2 failed / 1 passed | ed-safety-regression：3 passed |

- 定点最终验证：`npx vitest run test/sync`，5 files / 35 passed；`npx tsc --noEmit` 通过。
- 项目基线：`bash .claude/check.sh`，48 files / 428 passed / 2 skipped。
- 项目最终：`bash .claude/check.sh`，53 files / 463 passed / 2 skipped，exit 0；两个 skipped 为已有测试。
- 独立只读新上下文审查：第一轮 changes needed（URL 异常清洗、staff 二次脱敏）；两个发现均补失败回归后修复，第二轮 ready to merge（限此范围）。
- diff/privacy 检查通过；没有提交，handoff/tasks 未修改。未运行真实平台访问、CI、部署或完整 M1 验收；未归档 change。

## 开放问题（不实现额外模型/存储）

1. 真实 Ed no-view/quiz/thread/resource JSON 字段结构仍未验证；当前 plain-text Q1 与成绩字段只经过合成测试。实际富文本/未知形状被拒绝或报告缺口，无 raw fallback。
2. Ed 权重、exam/final/hurdle 分类、owner-only score/max_score 形状如何映射到 Assessment？没有已验证映射，保留安全来源证据，Assessment 为空。
3. Ed/Canvas 课程与既有 owner module 的显式映射尚无已批准合同；不自动合并 provider，不发布猜测 Course/module 关系。是否需要额外领域字段/表须另议。
4. 资源 PDF 是否要求跨域/CDN 跳转？本次仅保留安全链接证据，下载由 issue E 处理；不增加 transport。
5. Canvas 生产适配器和后续事件写入需接入共享出口；issue C/F/G/H 的持久化、完整性删除、ledger 与 Q1 审批哈希失效集成不在此 issue。

## 每任务建议提交（交给 Claude，不在此会话提交）

```text
feat(sync): consume bounded Ed capture for source normalization

- Reuse the merged Ed transport and Q1 references without expanding endpoint scope

feat(sync): retain evidenced Ed deadlines and owner grade facts

- Preserve field citations and withhold assessments with unsupported weight or classification

feat(privacy): add scope-wide deterministic redaction

- Harvest nested identities before projection and preserve staff-name exceptions only

fix(privacy): enforce validated Canvas and Ed source boundaries

- Reject malformed rules and sanitize unsafe output failures without raw fallback

test(sync): verify Ed normalization and privacy regressions

- Cover scope conflicts and record synthetic verification and unresolved live mappings
```
