# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-delivery/`（唯一进行中的 v1 change）；决定看 `note/decisions.md`（#1–#159）。

- **最后更新：** 2026-10-15 18:05，无人值守调度员（#155），分支 `claude/handoff-i-l`。
- **模式：** 开发中。定时调度员每小时一次，按 `v1-delivery` 推进；调度细节在本机 `.local/dispatcher/HANDOFF.md`。
- **已合并：** A（PR #115）、B（PR #116）、C（PR #118）、G（PR #119）、D（PR #121）、F（PR #126）、H（PR #127）、E（PR #129）、I（PR #131：Claude Agent SDK 0.3.300 适配器、PreToolUse 策略、生产接线；两轮审查后调度员自修 3 处 + 子代理复核 1 处）、L 后端（PR #132：`metrics.read`，对话明细分页）。tasks 4.x、5.1–5.5、6.x、7.x、8.x、9.x、10.1–10.3、16.1 已勾。
- **注意：** 生产对话现在默认启动已登录的 Claude（`ClaudeAdapter`），工具集取自 `registry.agentTools()`（与 MCP 同一条无 owner 权限的 dispatch 路径）；策略钩子每次调用时读 UI 端口（UI/HTTP 宿主监听后写入 `agentRuntime`）和常驻浏览器调试端口。`metrics.read` 的对话明细是偏移游标分页（每页最多 25），但这个分页参数还没写进 metrics 规格。F 的 `plan.read` 是游标分页，K2 要读完再拼。MCP agent 工具数：main 上 27（26 + `metrics.read`），J 合并后再加 7 个浏览器工具。

## 没合并的工作

| 分支 / clone | 内容 | 下一步 |
| --- | --- | --- |
| `codex/v1-browser-tools`（`../unimelb-coursework-agent-browser-tools`，未推送，HEAD 0816dd2） | J（#108）：11.1–11.5 已实现并提交，已把 main（含 I，4fcd269）合进本分支；第 1 轮审查 4 处已返工；第 2 轮审查撞 Codex 额度没出结论 | 只读 Claude 子代理做第 2 轮审查 → 修 → 并 main（会和 L 的 registry / cli 工具数冲突）→ PR；真浏览器检查未做 |
| `codex/v1-ui-shell`（`../unimelb-coursework-agent-ui`，未推送） | K1（#109）：12.1–12.2 已提交；第 1 轮审查唯一问题：「把登录页带到前台」按钮没接后端 | 等你决定后端命令放哪 → 返工 → 并 main → 本机真浏览器检查 12.3 → PR |

## 下一步（按顺序）

1. J 第 2 轮审查（Codex 22:21 恢复前用只读 Claude 子代理）→ PR → 合并。
2. K1 等你决定登录页按钮的后端命令。
3. K2（#110）、K3（#111）等 K1；K4（#112）等 J、K1；L 面板 16.2 等 K1；M（#114）最后。

## 等你决定

- K1「把登录页带到前台」需要一个新的后端 owner 命令（规格 web-ui 要求有按钮）：放进 J（#108）还是 K1 自己做？调度员推荐放进 J（它管常驻浏览器的标签页）。
- `metrics.read` 的分页参数（`cursor`、`limit`，每页最多 25）要不要写进 metrics 规格（调度员撤回了 Codex 擅自加的规格场景）。
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
