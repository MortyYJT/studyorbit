# Issue C 审批复审修复

- 分支：`codex/quiz-review`；起点：`017703d`；OpenSpec：`ed-quiz-assist`，任务 3.2 / 3.4。
- 用户要求：激活前取消不留下可用审批；先审计意图，持久化后记录成功；不提交、不改 `note/handoff.md`。
- 执行顺序：回归测试 RED → 存储激活边界与审计时序修复 → GREEN → 独立只读复审 → 项目检查。
- RED：`npx vitest run test/quiz/review.test.ts test/quiz/files.test.ts`，6 failed / 58 passed；验证取消与成功审计提前的问题。
- GREEN：同一命令，64 passed；`npx tsc --noEmit`，exit 0。
- 修复：异步准备期间保留 pending；最终取消检查与 rename / 目录 sync 同步完成；确认 intent 在保存前，成功 outcome 在保存后；保存失败不标记 approved。
- 复审范围：仅检查上述取消、持久化、审计顺序与失败处理的正确性；代码和合成测试见本次 diff。输出 correctness gaps、file:line、verdict。
- 第一次独立复审：changes needed；发现 rename 后目录 sync 失败仍留下 approved。
- 补充 RED：目录 sync 注入 EIO，1 failed / 17 passed；修复后同步移除未完成替换并 sync 目录，再报错，不让锁外预检接受该审批。
- 最新 GREEN：定向 65 passed，TypeScript exit 0。
- 第二次独立只读复审：ready to merge（仅本次修复范围），未发现正确性缺口；复审另跑定向测试 65 passed。
- `bash .claude/check.sh`：exit 0；55 files passed；557 passed / 2 skipped。`openspec validate ed-quiz-assist --strict`：valid；`git diff --check`：通过。
- 未提交、未推送；`note/handoff.md` 未修改。
- 后续 Q1 工作与真实平台验收不在本次范围；整个 change 尚未完成，不归档。
