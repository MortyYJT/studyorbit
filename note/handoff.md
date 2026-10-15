# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-delivery/`（唯一进行中的 v1 change）；决定看 `note/decisions.md`（#1–#160）。

- **最后更新：** 2026-10-15 22:45，无人值守调度员（#155），分支 `claude/handoff-j2-k1`。
- **模式：** 开发中。定时调度员每小时一次，按 `v1-delivery` 推进；调度细节在本机 `.local/dispatcher/HANDOFF.md`。
- **已合并：** A（PR #115）、B（PR #116）、C（PR #118）、G（PR #119）、D（PR #121）、F（PR #126）、H（PR #127）、E（PR #129）、I（PR #131：Claude Agent SDK 0.3.300 适配器、PreToolUse 策略、生产接线；两轮审查后调度员自修 3 处 + 子代理复核 1 处）、L 后端（PR #132：`metrics.read`，对话明细分页）、J（PR #134：7 个浏览器工具、红框 + 1 秒、审计、提交前 owner 确认；第 2 轮审查 4 处中 1 处由调度员自修，3 处需你决定）、J2（PR #138：owner 命令 `browser.signin`，把常驻浏览器的登录页带到前台，决定 #160）、K1（PR #139：`web/` 前端外壳、顶栏、头像菜单各面板、登录页按钮；本机空数据目录真浏览器检查 390/1440、明暗）。tasks 4.x、5.1–5.5、6.x、7.x、8.x、9.x、10.1–10.3、11.x、12.x、16.1 已勾。
- **注意：** 生产对话现在默认启动已登录的 Claude（`ClaudeAdapter`），工具集取自 `registry.agentTools()`（与 MCP 同一条无 owner 权限的 dispatch 路径）；策略钩子每次调用时读 UI 端口（UI/HTTP 宿主监听后写入 `agentRuntime`）和常驻浏览器调试端口。`metrics.read` 的对话明细是偏移游标分页（每页最多 25），但这个分页参数还没写进 metrics 规格。F 的 `plan.read` 是游标分页，K2 要读完再拼。MCP agent 工具数：main 上 34（27 + 7 个浏览器工具）。测验 / workshop 页的 `browser.read` 只遮同学身份和联系方式，不再因为普通题干（如 password、student）整页拒绝。

## 没合并的工作

无。

## 下一步（按顺序）

1. K2（#110）、K3（#111）、K4（#112）、L 面板 16.2（#113）都已不受阻（K1 已合并），最多 3 条 Codex 线并行；M（#114）最后。
2. J 的 3 处遗留问题等你决定后再开 issue（见下）。

## 等你决定

- `metrics.read` 的分页参数（`cursor`、`limit`，每页最多 25）要不要写进 metrics 规格（调度员撤回了 Codex 擅自加的规格场景）。
- J 第 2 轮审查遗留（PR #134「Out-of-scope findings」）：
  - 页面正文里点名的同学（没有作者元素）认不出：生产环境没有同学名单来源。选项：从 Canvas People 页同步名单作脱敏范围 / 接受「尽力而为」。
  - 写操作只核对「同一门课」（规格原文如此）：L1 授权的测验可被用来在同课 L2 作业页上填写。推荐改规格为「页面 URL 必须对应所点名的作业」，无法对应的页面拒绝。
  - 打开 `coursework ui` 会把另一个 `coursework mcp` 进程还在等的确认标成过期（安全但会丢请求）。修法要给确认行加持有进程 id（改表结构）。
  - （低风险，不需决定）没有 `<form>`、靠脚本驱动的提交控件只靠按钮文字正则识别。
- 补理由：#127、#158、#159，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- R-B 3.5（任务 17.2）：终端里跑 `node dist/cli.js browser start`，登录 Canvas 和 Ed，跑 `browser status`，放一夜看登录能保持多久。
- 任务 5.6（D 已合并）：在真实 profile 上跑一次 `coursework sync`，把实际数量和问题记进 PR。
- 任务 10.4（I 已合并）：先 `claude` 登录，再 `coursework ui` 发一条真实对话，记下步骤数和费用。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。
- 规格：`openspec validate v1-delivery --strict`、`openspec validate --specs --strict`。
- 原型：浏览器直接打开 `design/prototype/index.html`。
- 开 socket 的测试（`test/protocol/http*.test.ts`）在 Codex 沙箱里会 `EPERM`，只能在本机跑；Codex 报告里的 HTTP 结论一律在本机复核。

## 陷阱

- HTTP 鉴权：契约里的写命令无论等级都要凭证（L0 的复习写入也一样）；只有读命令匿名可用。G 里定的规则，改 `src/protocol/http.ts` 时别丢。
- 多个分支同时改 `test/cli.test.ts` 的 MCP 工具数量断言，后合并的要按实际数量改并在注释里写清多出来的是哪些命令。
- `openspec archive` 遇到 MODIFIED 需求丢了旧场景会拒绝归档：改需求时保留旧场景名（可以改内容）；所有需求都被删的规格要手动删目录。
- 对话 agent 有 Bash（#150）：等级设置和提交确认只认内存里的前端会话密钥；其他 owner 命令接受会话或终端（TTY）。别把密钥写盘、写日志或打印给非终端调用者。
- Agent SDK 是 0.x、商业许可：钉死版本，SDK 类型只放 `src/agent/claude.ts`。
- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 旧的变化事件表和旧 L0–L4 授权记录不能删（只加表，#107、#151）。
- 本机全局 git 身份不是公开身份：新 clone 先设 local 身份，推送前 `git log --format='%an %ae' -1` 核对。
- 验证证据只写进 PR 描述，不进仓库（#90）。
- 决定记录里的理由要标来源（用户原话 / 理由同 Claude / 理由待补），不替用户编理由。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
