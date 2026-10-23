# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-delivery/`（唯一进行中的 v1 change）；决定看 `note/decisions.md`（#1–#162）；进度看 `note/product/roadmap.md`。

- **最后更新：** 2026-10-23，Claude 会话（#161：本轮不派 Codex，全部由 Claude 子代理在 worktree 里实现），分支 `claude/handoff-v1-ui`。
- **模式：** v1 代码全部完成，等你真机验收。`v1-delivery` 的 tasks 只剩你本人的 5.6、10.4、17.2、17.3 和最后的 17.4 归档。
- **本轮已合并：** 合成数据 UI harness（PR #141）、L 指标面板（#142）、K4 Agent 页（#143）、K2 周视图（#144，含"需要你"里的确认卡片和 review-pending 预设）、CLI 测试超时（#145）、`autonomy.read` 和 `assessments.list` 的 `platform` 提交 / 删除标记（#146）、准确率每条标注只算最新判定（#148，决定 #162）、K3 课程页和抽屉（#147）、M 17.1 端到端测试和 20 秒默认测试超时（#149）。每个 PR 都有新上下文子代理审查；K2、K3 各两轮。
- **注意：** MCP agent 工具数 35（多了 `autonomy.read`）。前端所有读写只走注册表命令；owner 写操作都在 `web/src/client.ts` 的 `writes` 集合里。课程页的等级只来自 `autonomy.read`，每次自治写入后重读。

## 没合并的工作

无（本 PR 合并后）。

## 下一步（按顺序）

1. 你做真机任务（见「等你动手」），结果写进对应 PR 或新 issue。
2. 17.3 验收里的失败项开新 issue，挂到对应用户故事。
3. 全部通过后做 17.4：`openspec validate v1-delivery --strict`、`bash .claude/check.sh`、`npm run build`，归档 `v1-delivery`（带规格），更新 roadmap 和本文件。
4. 下面「等你决定」的项，你选完后再开 issue。

## 等你决定

- **`plan.read` 会清开始时间（K2 审查）：** `plan.read` 是 L0 读命令，但每次重排都会清掉不再排在当天的开始时间（`src/planning/service.ts:47-56`）。前端从今天起排 366 天，没做完的工作每天往后挪，开始时间会被悄悄删掉；agent 或 CLI 用别的范围调 `plan.read` 也会清。planner 也不扣已记录的实际用时（`src/planning/planner.ts:29`）。选项：开始时间只在 owner 写入或显式重排时清 / 计划锚定到周一 / planner 扣减实际用时。
- **手动任务必须挂模块：** `manual.create` 要 `moduleId`，没有 `modules.list`，个人模块选不到，没课程时不能加任务。选项：加 `modules.list` / 手动任务允许不挂模块。
- **课程外工作的实际用时读不到：** 只有 `plan.read` 的 work 行带 `actualMinutes`，已提交 / 已出分的作业在抽屉里只能记、看不到总数。选项：加一个按考核读实际用时的读命令 / 接受现状。
- `metrics.read` 的分页参数（`cursor`、`limit`，每页最多 25）要不要写进 metrics 规格。
- J 第 2 轮审查遗留（PR #134「Out-of-scope findings」）：页面正文点名的同学认不出（同步 Canvas People 名单 / 接受尽力而为）；写操作只核对同一门课（推荐改规格为「页面 URL 必须对应所点名的作业」）；`coursework ui` 会把另一个 `coursework mcp` 进程等待中的确认标成过期（要给确认行加持有进程 id，改表结构）。
- 补理由：#127、#158、#159、#161，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- R-B 3.5（任务 17.2）：终端里跑 `node dist/cli.js browser start`，登录 Canvas 和 Ed，跑 `browser status`，放一夜看登录能保持多久。
- 任务 5.6：在真实 profile 上跑一次 `coursework sync`，把实际数量和问题记进 PR。
- 任务 10.4：先 `claude` 登录，再 `coursework ui` 发一条真实对话，记下步骤数和费用。
- 任务 17.3：按 PRD 的 US-1、2、3、5、6、7 验收项逐条在真实数据上验收。
- GitHub 设置里勾选「Keep my email addresses private」：main 上旧的 squash 提交作者邮箱是私人邮箱（已推送，不能改写历史）；本轮新提交都用 noreply。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js` 和 `dist/ui`。看检查的**退出码**，不要只 grep 输出。
- 规格：`openspec validate v1-delivery --strict`、`openspec validate --specs --strict`。
- 前端真浏览器检查：`npm run build && node test/web/harness.ts`，打印带 owner 会话的本地 URL（别贴进 PR 或日志），Ctrl-C 删临时目录。合成数据：2 门课（一门禁 AI）、9 个考核、引文、批注、排期、复习、同步记录、一条对话、一个待确认提交。Playwright 自带的 chromium 版本和安装的不一致，脚本里用系统 Chrome（`channel: 'chrome'`）。
- 原型：浏览器直接打开 `design/prototype/index.html`。
- 开 socket 的测试在 Codex 沙箱里会 `EPERM`，只能在本机跑。

## 陷阱

- 测试默认超时 20 秒（`vitest.config.ts`）：单跑 1 秒的重测试在全套并行时会超过 5 秒。别为单个测试再加超时。
- 合并后也要看 main 上的 CI（`gh run list --branch main`），PR 通过不等于合并后通过。
- 提交身份：用 `git -c user.name=MortyYJT -c user.email=213947413+MortyYJT@users.noreply.github.com commit`；子代理容易沿用 main 上最后一个提交的私人邮箱，推送前 `git log --format='%ae' main..HEAD` 核对。
- 并行前端分支都会改 `App.tsx`、`client.ts`、`i18n.ts`、`style.css`：合并时两边都留；`i18n.ts` 里重复的键会让 tsc 报 TS1117。
- `web/src/course-contracts.ts` 是服务端契约的浏览器副本（服务端模块引入 Node 内置模块）；改契约时测试 `test/web/course-contracts.test.ts` 会因漂移失败，同步改副本。
- HTTP 鉴权：契约里的写命令无论等级都要凭证；只有读命令匿名可用。`confirmation.list` 是只认会话的读。
- 多个分支同时改 `test/cli.test.ts` 的 MCP 工具数量断言，后合并的按实际数量改并在注释里写清多出来的命令。
- `openspec archive` 遇到 MODIFIED 需求丢了旧场景会拒绝归档：改需求时保留旧场景名；所有需求都被删的规格要手动删目录。
- 对话 agent 有 Bash（#150）：等级设置和提交确认只认内存里的前端会话密钥。别把密钥写盘、写日志或打印给非终端调用者。
- Agent SDK 是 0.x、商业许可：钉死版本，SDK 类型只放 `src/agent/claude.ts`。
- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。验证证据只写进 PR 描述，不进仓库（#90）。
- 旧的变化事件表和旧 L0–L4 授权记录不能删（只加表，#107、#151）。
- 决定记录里的理由要标来源（用户原话 / 理由同 Claude / 理由待补），不替用户编理由。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
