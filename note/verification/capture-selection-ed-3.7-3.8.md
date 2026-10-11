# capture-selection-ed 3.7–3.8 验证记录

日期：2026-10-12。基线：`f5a9209`；分支：`codex/ed-orchestration`。修改未提交。

## 已配置

- 生产编排接入已合并的 Canvas runner，Canvas 与 Ed 复用同一个 limiter。
- 前台 Ed 不阻止选择后台合格 Canvas 标签；交互缺少 Canvas 标签时保留明确恢复提示。
- 首次发现的 Canvas 页面在同一次限速尝试内等待就绪并保存，后续 crawl 复用页面及发现结果。
- 两来源结束后保存并打印同一份统一摘要；包括来源状态、共享 cap/abort、失败 URL、缺失课程及重定向。诊断列表最多 30 项，并记录遗漏数量。
- 第二次 crawl、运行中重新选择被拒绝；手动保存可用；退出时等待当前快照工作完成再清理和释放锁。

## 合成数据已测试

新增 `test/capture/orchestration.test.ts`，使用合成页面和真实发现、适配器、快照 writer；仅 CDP 创建隐藏页替换为 fake，该边界已有专门测试。

TDD 证据：首轮 9 项测试得到 `5 failed | 4 passed`，接入实现后 `9 passed`。审查后先增加摘要持久化和发现快照的失败测试；失败 URL 测试也先观察到空列表失败，再修复。最终新增集成测试共 16 项。

最终命令与输出（均 exit 0）：

```text
npx vitest run test/capture/orchestration.test.ts test/capture/capture-selection-command.test.ts test/capture/session.test.ts
Test Files  3 passed (3)
Tests       57 passed (57)

bash .claude/check.sh
> tsc --noEmit && vitest run
Test Files  40 passed (40)
Tests       312 passed | 2 skipped (314)

npm run build
> tsc -p tsconfig.build.json

openspec validate capture-selection-ed --strict
Change 'capture-selection-ed' is valid
```

两个跳过项是已有的 SQLite 默认路径及环境覆盖占位测试，本次未改动。

隐私及差异检查：`git diff --check` 通过；`git check-ignore` 确认 selection、Ed snapshot、crawl summary 的 `.local/` 路径均被忽略；检查全部修改文件，未发现识别性本机路径、私钥或常见真实令牌格式；夹具全部为合成数据。未读取真实 profile 或课程内容。

独立新上下文只读审查：发现并修复统一摘要未落盘、发现快照缺失、Canvas 恢复提示丢失、失败 URL 丢失及打印基础字段遗漏。最终结论 `ready to merge`；审查者没有独立重跑测试。

## 未做实测

- 本轮没有运行真实浏览器登录、MFA 或 Canvas/Ed 网络请求。
- 真实当前学期发现、排除未选课程、Canvas 重定向、Ed no-view slides、登录保持时间/MFA 仍需 3.9 用户操作验收。
- CI、提交、推送、PR、归档均未执行。3.10 仍需先满足验收及 v1-foundation 归档前置条件。
- 按用户要求未修改 `note/handoff.md` 或 `tasks.md` 勾选。

建议提交：

```text
feat(capture): orchestrate selected Canvas and Ed capture

- Wire the Canvas adapter into the shared discovery and capture budget
- Preserve source outcomes and settle in-flight snapshots before cleanup
- Save bounded, content-free summaries for dual-source and Ed-only runs

test(capture): record orchestration verification evidence

- Cover authentication isolation, shared limits and shutdown with synthetic integration data
- Record strict validation, privacy checks and live verification gaps
```

## 2026-10-12 新上下文审查返工：登录过期与外部重定向

基线：`384ec04`；分支：`codex/ed-orchestration`。范围限于两个 P2 发现，不修改 handoff，也不提交。

- Canvas 发现阶段跳转到 `/login` 或外部 HTTP(S) 登录页时保留 `AUTH_EXPIRED`；导航抛错但 URL 已改变时也保留认证过期结果。
- crawl 复用过期发现时保留 `signedOut`，记录已经发生的 `/courses` 重定向，不再次导航；统一摘要保留重新登录提示，Ed 继续。
- 重定向的 requested URL 仍限制 Canvas 同源；final URL 允许外部 HTTP(S)，移除凭据、查询、片段和等价尾斜杠后报告。
- 新增 4 项合成编排回归测试：普通／抛错导航的外部 SSO 摘要、同源／外部登录页的重新选择。打印数据与落盘摘要一致，外部凭据不进入摘要。

TDD 红阶段：`npx vitest run test/capture/orchestration.test.ts` 得到 `4 failed | 16 passed (20)`；失败分别确认外部 URL 对被丢弃，以及重新选择后 `AUTH_EXPIRED`／`signedOut` 被降为 `SOURCE_UNAVAILABLE`／`completed`。

绿阶段与验证（均 exit 0）：

```text
npx vitest run test/capture/orchestration.test.ts test/capture/crawl.test.ts test/capture/discovery-adapters.test.ts
Test Files  3 passed (3)
Tests       72 passed (72)

bash .claude/check.sh
> tsc --noEmit && vitest run
Test Files  40 passed (40)
Tests       316 passed | 2 skipped (318)

npm run build
> tsc -p tsconfig.build.json

openspec validate capture-selection-ed --strict
Change 'capture-selection-ed' is valid
```

已有两个 SQLite 占位测试仍跳过。本轮未做真实浏览器／网络验收，3.9 与归档前置条件仍未完成。

独立新上下文只读复审结论：`ready to merge`，无正确性／规格缺口；审查者独立运行 `bash .claude/check.sh`，同样得到 40 个文件通过、316 项通过、2 项跳过。`git diff --check` 通过；所有新增测试数据均为合成数据，未引入真实身份、课程或认证材料。

建议提交：

```text
fix(capture): preserve discovery auth expiry and SSO redirects

- Retain signed-out discovery outcomes and login hints during reselection
- Include sanitized external final URLs in unified redirect summaries
- Cover both review findings with failing-first orchestration tests
```
