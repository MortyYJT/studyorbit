# Issue #43 实现证据

- 日期：2026-10-12；分支：`codex/quiz-policy`；基线：`0260e75`。
- 范围：`ed-quiz-assist` 2.1–2.5；沿用中断前工作树，不提交、不修改 handoff、不勾任务。
- GitHub issue 读取因 API 网络不可达失败；以用户给定范围和本地 OpenSpec 为依据。
- 已阅读 AGENTS、v1 技术设计、change proposal/design/spec/tasks 和相关工程规则。

## 本轮 TDD 证据

初次 `npx vitest run test/quiz`：2 failed / 104 passed。
旧失败分别是较高 L4 grant/cap 的低级授权，以及读取未返回 sourceRevision/保存可信快照。
上次运行的其他测试最初已经为绿，不能据此宣称它们在本轮经历过红灯。

| 任务 | 本轮观察到的红灯 | 绿灯验证 |
| --- | --- | --- |
| 2.1 | L4 grant/cap 无法授权 L3 | policy 6 tests passed；Q1 仅开放 L2/L3 检查，不实现提交 |
| 2.2 | read 接受多余 revision 元数据；输入文件失败无审计；四个 B 子命令缺参数被记成 read；ledger 失败残留成功 data | audit 10 tests passed；proposal 入口回归通过；只存安全元数据 |
| 2.3 | 可信题目身份不一致未拒绝；省略材料引用并标为 reasoning 可通过；短材料复制漏检 | citations 9 tests passed；材料声明在 answer/rationale 的拒绝、旧 revision 和安全 ledger 回归通过 |
| 2.4 | sourceRevision/可信快照缺失；读取已有记录未收紧文件权限 | files 10 tests passed；read-evidence 2 tests passed；原子替换失败、私有路径、symlink、旧 revision 回归通过 |
| 2.5 | 验证任务，无人为失败测试 | quiz 11 files / 122 tests passed；两轮独立只读审查，最终 ready to merge |

## 最终验证

`bash .claude/check.sh`，退出码 0：
```text
> coursework@0.1.0 check
> tsc --noEmit && vitest run
Test Files  51 passed (51)
Tests       439 passed | 2 skipped (441)
```

`npm run build` 退出码 0；`git diff --check` 通过。
domain/store、依赖、CI、handoff、tasks 未修改。夹具均为 test/ 下合成数据。
新模块无模型请求、SQLite 操作或真实课程政策/grant。真实 Ed 结构和实际授权未验证。

## 建议提交（由 Claude 执行）

1. `feat(quiz): validate explicit local policy and assessment grants`
   - Record owner authorization and gate real Q1 prerequisites without implicit consent.
2. `feat(quiz): audit read and authorization outcomes privately`
   - Append sanitized intent and outcome events, including CLI failures.
3. `feat(quiz): validate question and material citations for proposals`
   - Reject missing or mismatched evidence and preserve accepted revisions.
4. `feat(quiz): persist private versioned cited proposals`
   - Bind trusted read revisions and write atomic owner-only local records.
5. `test(quiz): record issue B verification and review evidence`
   - Record synthetic checks, independent review and remaining live validation.

## 未解决事项

- 未发现需要新增共享 domain/SQLite schema 的具体需求。
- 实际课程政策、私有仓库 prerequisite、非考试绑定和 grant 仍须由 owner 单独记录；本轮未记录真实数据。
- 真实 JSON/DOM/attempt 和材料导入由后续任务验证；本轮材料使用可信私有 operational records。
- 引用验证检查声明、来源和文本匹配，不证明答案正确，也不能语义识别所有被误标为 reasoning 的改写；后续终端人工 review 仍必要。
- GitHub CI、远程私有可见性和真实课程验收未验证；Claude 在推送前复核私有可见性。
