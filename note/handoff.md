# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（需求来源；2026-10-24 起课程获取和 agent 改法见 #165–#175，PRD 待随子项目更新）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行，含已归档的 `v1-delivery`）（没有进行中的 change；下一个是 C-2 `agent-course-reading`，规格未写）；决定看 `note/decisions.md`（#1–#180）；进度看 `note/product/roadmap.md`。

- **最后更新：** 2026-10-24，Claude 会话，分支 `claude/archive-codex-agent`。
- **模式：** C-1 `codex-agent` 已完成并归档（PR #155，你真机验收通过：约 20 秒读出 Ed 主页 3 门课，没有乱点、没有提交）。前端对话现在默认用 Codex（`COURSEWORK_AGENT=claude` 切回 Claude）。下一个是 C-2 `agent-course-reading`，规格开工前写；然后 C-3、C-4（roadmap C-1～C-4）。
- **已归档：** `v1-delivery`（2026-10-24，#175）。它的代码全部在 main 上；未完成的真机任务已转走：10.4 → `codex-agent` 4.2，17.3 → Codex 子项目之后重做，17.2 取消（常驻 Edge 要删），5.6 停掉（接口同步要删）。
- **今天的实验（证据只在会话里，结论记在 `codex-agent` 设计）：** 非交互 `codex exec` 能用电脑操作功能读你的 Edge（23–30 秒）；Edge 的元素树漏掉课程全名，截图读全；`codex exec --json` 只报 token、不报费用。
- **真机同步第一次跑出的 bug：** Ed `/api/user` 的 `year` 是字符串，旧同步因此整个失败。修复在本地分支 `claude/ed-year-string`（d1005fa，未推送）；接口同步会在 C-2 删掉，所以不打算合并，C-2 合并后删这个分支。

## 没合并的工作

- `claude/ed-year-string`：见上，不合并；C-2 删接口同步后删掉这个本地分支。

## 下一步（按顺序）

1. 写 C-2 `agent-course-reading` 规格（三层 JSON #169、读取顺序 #170、单项权重 #171、删接口同步 #172、AI 开关 #180），你审后实现；同时更新 PRD 里受影响的验收项。真机实验已知：Edge 元素树读不到课程全名，需要截图补读。
2. C-2 合并后写 C-3 规格并实现，然后按新流程重做真机验收（原 17.3）。
3. 然后 C-4 长期记忆（#178）。

## 等你决定

- **`plan.read` 会清开始时间（K2 审查）：** `plan.read` 是 L0 读命令，但每次重排都会清掉不再排在当天的开始时间（`src/planning/service.ts:47-56`）。从今天起排 366 天，没做完的工作每天往后挪，开始时间会被悄悄删掉；agent 或 CLI 用别的范围调 `plan.read` 也会清。planner 也不扣已记录的实际用时（`src/planning/planner.ts:29`）。选项：开始时间只在 owner 写入或显式重排时清 / 计划锚定到周一 / planner 扣减实际用时。
- **手动任务必须挂模块：** `manual.create` 要 `moduleId`，没有 `modules.list`，个人模块选不到，没课程时不能加任务。选项：加 `modules.list` / 手动任务允许不挂模块。
- **计划外工作（已提交 / 已出分）的实际用时读不到：** 只有 `plan.read` 的 work 行带 `actualMinutes`。选项：加一个按考核读实际用时的读命令 / 接受现状。
- `metrics.read` 的分页参数（`cursor`、`limit`，每页最多 25）要不要写进 metrics 规格。
- J 第 2 轮审查遗留（PR #134）中和我们浏览器工具有关的两条，会在 C-3 删掉这些工具后失效；「页面正文点名的同学认不出」被 #168 的不脱敏取代。
- 补理由：#127、#158、#159、#161、#172，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- GitHub 设置里勾选「Keep my email addresses private」：main 上旧的 squash 提交作者邮箱是私人邮箱（已推送，不能改写历史）；新提交都用 noreply。
- 常驻 Edge 现在还开着（10-24 12:57 启动，用来测登录时长，已取消）：可以直接关掉那个窗口。

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
