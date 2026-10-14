# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-delivery/`（唯一进行中的 v1 change）；决定看 `note/decisions.md`（#1–#159）。

- **最后更新：** 2026-10-15 07:40，无人值守调度员（#155），分支 `claude/dispatch-handoff-2026-10-15-b`。
- **模式：** 开发中。定时调度员每小时一次，按 `v1-delivery` 推进；调度细节在本机 `.local/dispatcher/HANDOFF.md`。
- **已合并：** A（PR #115）、B（PR #116）、C（PR #118：按作业类型分 L0–L2、课程默认等级和单项覆盖、只能从前端会话改的 owner 设置、去掉 `audit.record`）、G（PR #119：SQLite 学习记录、`source.fetch`、考试范围、练习统计、复习技能；两轮审查共修 6 处）。tasks 4.1–4.4、8.1–8.4 已勾。
- **注意：** Codex 两次越界改了 `note/handoff.md`（一次还写了一条用户没做过的「用户选择」）和 OpenSpec 规格，调度员都已还原；PR #119 里提到的两个规格场景留给 issue M 决定是否补进规格。

## 没合并的工作

| 分支 / clone | 内容 | 下一步 |
| --- | --- | --- |
| PR #121 `codex/v1-sync` | D：tasks 5.1–5.5；两轮审查共修 4 处，已并入最新 main（MCP 工具数 19） | CI 通过后合并；5.6 等你真机 |
| `codex/v1-planning`（`../unimelb-coursework-agent-planning`，未推送） | F：tasks 7.1–7.5，Codex 实现中 | 本机 check → 提交 → 审查 → PR |

## 下一步（按顺序）

1. 合并 PR #121（D）；收尾 F。
2. 派 H（#106，G 已合并）、E（#103）。
3. K1（#109）可以派了（`@types/react`、`@types/react-dom` 已批，#158）。

## 等你决定

- 补理由：#127、#158，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- R-B 3.5（任务 17.2）：终端里跑 `node dist/cli.js browser start`，登录 Canvas 和 Ed，跑 `browser status`，放一夜看登录能保持多久。
- D 合并后，任务 5.6：在真实 profile 上跑一次 `coursework sync`，把实际数量和问题记进 PR。

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
