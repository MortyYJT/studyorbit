# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-delivery/`（唯一进行中的 v1 change）；决定看 `note/decisions.md`（#1–#159）。

- **最后更新：** 2026-10-15 12:45，无人值守调度员（#155），分支 `claude/handoff-f-h`。
- **模式：** 开发中。定时调度员每小时一次，按 `v1-delivery` 推进；调度细节在本机 `.local/dispatcher/HANDOFF.md`。
- **已合并：** A（PR #115）、B（PR #116）、C（PR #118）、G（PR #119）、D（PR #121）、F（PR #126：按天 EDF 排期、估时要理由、开始时间和实际用时、只能 owner 改的校外任务、`plan.read` 分页；两轮审查后调度员自修 1 处隐私问题）、H（PR #127：适配器接口、对话存储、可续传 SSE、停止、预设只发一次、每次回复记录轮数和费用；两轮审查后调度员自修 2 处）。tasks 4.x、5.1–5.5、7.x、8.x、9.x 已勾。
- **注意：** F 的 `plan.read` 现在是游标分页，日程行只带 `workId` 引用、完整字段在 `work` 里，K2 周视图要按 `nextCursor` 读完再拼。对话恢复（把上一进程没写完的回复标成已停止）只在 `coursework ui` 启动时做。

## 没合并的工作

| 分支 / clone | 内容 | 下一步 |
| --- | --- | --- |
| `codex/v1-annotations`（`../unimelb-coursework-agent-annotations`，未推送） | E（#103）：实现 + 第 1 轮返工已提交 | 并入最新 main（预计 4 处冲突：production、registry、sqlite、cli 工具数）→ 第 2 轮审查 → PR |
| `codex/v1-ui-shell`（`../unimelb-coursework-agent-ui`，未推送） | K1（#109）：12.1–12.2 已提交，第 1 轮审查在跑 | 看审查 → 返工 → 本机真浏览器检查 12.3（390/1440 px、明暗）→ PR。「把登录页带到前台」后端没有命令，按钮暂时禁用 |

## 下一步（按顺序）

1. 收尾 E、K1。
2. I（#107）、J（#108）可以派了（H 已合并）；I 要装 `@anthropic-ai/claude-agent-sdk`（已预批，钉死版本）。
3. K2（#110）等 K1。

## 等你决定

- 补理由：#127、#158、#159，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- R-B 3.5（任务 17.2）：终端里跑 `node dist/cli.js browser start`，登录 Canvas 和 Ed，跑 `browser status`，放一夜看登录能保持多久。
- 任务 5.6（D 已合并）：在真实 profile 上跑一次 `coursework sync`，把实际数量和问题记进 PR。

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
