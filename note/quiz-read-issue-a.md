# ed-quiz-assist issue A 实现证据

范围：任务 1.1–1.4；2026-10-12；分支 `codex/quiz-read`；基线 `58b2ec2`。
未提交；不改任务勾选、handoff、CI、依赖、领域 schema 或 SQLite 迁移。

## 基线与接口（1.1）

实际 Git 已含 S0 issue C（`f5a9209`），handoff 的旧状态不再作为依据。
当前没有 `openspec/specs/`；使用 `v1-foundation` 与 `capture-selection-ed` 的 delta specs 对照源码。

- Transport：`EdReader.read(endpoint, { snapshot? }) -> EdResponse`。Q1 不传 snapshot，不导出原始 payload。
- Auth：`EdTransport` 只在页面内读取 `authToken:au`；GET 使用 `x-token`、same-origin、redirect:error；Q1 不触碰令牌。
- Limiter：一个 `RequestLimiter` 覆盖 bootstrap、选定课程 lessons discovery、lesson、slide；300 次上限，完成后间隔一秒；不包第二层 limiter。
- Selection：`SelectionPersistence.load()` 与 `validateSelection()`；Q1 永不自动选课或提示凭据。
- Lock/lifecycle：`acquireProfileLock() -> release()`；复用 `launchSettings`、`activePage`、`openHiddenPage`，最后关闭 context、释放锁。
- Envelope：`run('quiz.read', handler)`，既有 `coursework.agent/v1` 和 64 KiB 字节上限（含 metadata），不截断。
- Adapter refs：`ed:<course>:<lesson>` 与 `ed:<course>:<lesson>:<slide>:<question>` 是命令层来源引用，不创建领域 Assessment。

基线 `bash .claude/check.sh`（exit 0）：

```text
> tsc --noEmit && vitest run
Test Files  39 passed (39)
Tests       296 passed | 2 skipped (298)
```

## 逐项 red → green

所有夹具均为 `test/quiz/` 内独立合成数据；没有访问真实 Ed、课程内容或登录 profile。
原始运行日志仅在临时目录；本记录保留不含本机身份的摘要。

| 任务 | 命令 | Red 证据 | Green 证据 |
| --- | --- | --- | --- |
| 1.1 | `npx vitest run test/quiz/contracts.test.ts` | 1 failed suite：尚不存在 contracts 模块 | 1 passed |
| 1.2 | `npx vitest run test/quiz/transport.test.ts` | 占位 adapter：13 failed | 13 passed |
| 1.3 | `npx vitest run test/quiz/questions.test.ts` | 占位 normalize：13 failed、1 passed；复查发现参数表传参错误，纠正后大小写身份提示回归暴露 1 failed | 19 passed（含审查回归） |
| 1.4 | `npx vitest run test/quiz/command.test.ts test/quiz/session.test.ts` | 占位 handler/parser/session：14 failed | 16 passed（含退出信号回归） |

1.4 的多字节 64 KiB 用例还暴露长文本邮件正则回溯导致 timeout；改为线性分词脱敏后通过，未延长测试超时。
1.3 明确拒绝 markup、凭据标记、缺失身份、重复题目/选项、未知关联；未知 widget 只返回 ref 与 unsupported。
1.4 验证输入/选课失败不启动 session，LOCKED、认证、来源、限额错误无原始消息，清理失败不报告成功。

## 独立审查与最终检查

按 AGENTS.md 要求，执行两轮 fresh-context/read-only 子代理审查，只报告正确性缺口。
第一轮发现字符串 author/people 姓名遗漏与挂起 GET 取消不释放锁；新回归 red 为 5 failed、19 passed，修复后 24 passed。
第二轮确认取消修复，同时指出人员 ID、答案、成绩误当姓名会破坏安全题目；新回归 red 为 1 failed、18 passed，限定姓名字段和词边界后 19 passed。
第二轮 verdict 为 changes needed；该末项已由本会话修复并验证，未做第三轮独立审查，不宣称已获 ready-to-merge verdict。

最终 `npx vitest run test/quiz`（exit 0）：

```text
Test Files  5 passed (5)
Tests       49 passed (49)
```

最终 `bash .claude/check.sh`（exit 0）：

```text
> coursework@0.1.0 check
> tsc --noEmit && vitest run
Test Files  44 passed (44)
Tests       345 passed | 2 skipped (347)
```

现有 CLI 测试在全量 check 中执行生产 build；built CLI 的两次独立 non-TTY 冒烟验证：缺选课与未知参数各仅输出一个 INVALID_INPUT envelope；未知参数无原始输入 stderr，未提示凭据。
`git diff --check` 通过；新增文件身份路径扫描无匹配；全部新增夹具仅在 `test/quiz/`。

## 文件分组

- 1.1：`src/quiz/read/contracts.ts`，`test/quiz/contracts.test.ts`，`test/quiz/synthetic.ts`。
- 1.2：`src/quiz/read/adapter.ts`，`test/quiz/transport.test.ts`。
- 1.3：`src/quiz/read/questions.ts`，`test/quiz/questions.test.ts`。
- 1.4：`src/quiz/read/command.ts`，`src/quiz/read/session.ts`，`src/quiz/cli.ts`，`src/cli.ts`，`test/quiz/command.test.ts`，`test/quiz/session.test.ts`。
- 交付记录：本文件；`note/handoff.md` 与 OpenSpec 任务勾选保持原样。

## 尚未验证与开放问题

- 没有发现需要 CI、依赖、领域 schema 或迁移变更的事项。
- 真实 Ed question/slide 的 JSON/XML 格式、题目 ids 与 attempt 身份仍未验证。当前 plain-text question 合约仅由合成测试建立；未知真实格式关闭输出，后续结构验证从独立合成回归开始。
- Issue B 尚未提供实际课程政策与私有仓库验证。默认真实会话在任何 browser/profile 操作前拒绝；`openManagedQuizSession` 的 `verifyPrerequisites(target)` 接口供 B 集成，CLI 无跳过开关。合成注入 session 可验证完整 A 行为。
- 审计与政策/assessment 本地绑定属于 issue B；A 返回来源 assessmentRef，不创建虚构 Assessment 或写本地审计。
- 未执行真实账号、登录/MFA、真实 Q1 接受测试、提交观察、GitHub/CI、提交/推送或 archive。

## 建议逐任务提交

```text
feat(quiz): validate selected Ed quiz read contracts
- Reconcile S0 transport, selection and envelope contracts without domain changes.

feat(quiz): read discovered Ed quiz lessons through the shared transport
- Bound lesson and slide GETs to selected references without view or retries.

feat(quiz): validate and redact question sources before agent exposure
- Project stable references and explicit unsupported coverage from synthetic contracts.

feat(quiz): expose bounded quiz read envelopes through the CLI
- Reuse managed-profile lifecycle and fail closed pending real-read prerequisites.
```

## 隐私审查修复（2026-10-12，基线 `5d590ab`）

修复任务 1.3 的三项 P1：收集人员 username 与结构化 student_number（含安全整数），
在题干、选项及引文中脱敏；已知中文姓名匹配连续文本。身份字段格式不安全或替换后仍有
已知标识时返回 `SOURCE_UNAVAILABLE`，不输出原文。无新依赖或领域/storage schema 修改。

- TDD：新增身份回归先红，`questions.test.ts` 为 8 failed / 21 passed；修复后 29 passed。
- 脱敏标记碰撞回归先红，1 failed / 29 passed；补回残留检查后 `test/quiz` 为 5 files / 60 passed。
- fresh-context 只读子代理复审：ready to merge；独立执行 `questions.test.ts` 为 30 passed。
- `bash .claude/check.sh`：exit 0，44 files passed；356 passed / 2 skipped（358）。
- `git diff --check` 通过；未提交，`note/handoff.md` 未修改；仅验证合成数据，未运行真实 Ed。

建议提交：`fix(quiz): redact known usernames, student numbers and Chinese names`。
