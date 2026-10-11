# v1-sync 1.1 合成探针证据（issue #44）

- 范围：只实现 1.1 的合成部分；不运行 1.2，不勾 tasks.md，不修改 handoff，不提交。
- 起点：`codex/v1-sync-spike`，HEAD `0260e75`，工作区干净。旧 handoff 的进度信息落后于当前 Git，以代码与测试为准。
- 路线：已有 OpenSpec → 合成页面 TDD → 最小可注入探针 → 新上下文只读审查 → 项目检查。

基线 `bash .claude/check.sh`（exit 0）：

```text
Test Files  45 passed (45)
Tests       385 passed | 2 skipped (387)
```

Red：加入测试和空实现后，`npx vitest run test/capture/canvas-spike.test.ts`（exit 1）：

```text
Test Files  1 failed (1)
Tests       26 failed (26)
```

Green：实现后同一命令（exit 0），`npx tsc --noEmit` 也通过：

```text
Test Files  1 passed (1)
Tests       26 passed (26)
```

- 合成页面执行真实页面函数，用假 fetch/时钟验证凭据仅在浏览器会话内、GET 范围、无 header、无重试、共享预算与间隔。
- 返回固定字段类型、状态、计数和首屏覆盖；不返回源内容、任意字段名、分页 URL 或错误文本，不写原始快照。
- 候选 owner 读取是 assignments 的 `include[]=submission`，没有全体学生 submission 端点。真权限和 schema 尚未验证。
- 分页只记录 `more/none/unknown`，始终标为 `first_page_only`；生产分页属于 3.1，不在本次范围。
- 真实 JSON、权重规则、owner 成绩字段与模块/文件链接形状仍需 1.2。合成通过不能作为真实 spike 成功。

新上下文只读审查：无正确性或 1.1 要求缺口，结论为 ready to merge（仅限合成范围）。审查者复跑定向测试 26 passed、全量检查 46 files passed / 411 passed / 2 skipped，exit 0。
