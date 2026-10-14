# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-delivery/`（唯一进行中的 v1 change）；决定看 `note/decisions.md`（#1–#157）。

- **最后更新：** 2026-10-15，无人值守调度员（#155），分支 `claude/dispatch-handoff-2026-10-15`。
- **模式：** 开发中。定时调度员每小时一次，按 `v1-delivery` 推进；调度细节在本机 `.local/dispatcher/HANDOFF.md`。
- **本轮做了什么：**
  - 任务 1.4：建 issue #99–#114（每组一个），关闭被取代的 #31、#44、#46、#55、#77、#79、#92。
  - issue A（#99）→ PR #115 已合并：新实体 schema、未知权重、迁移 003（只加表加列）、仓储读写、私有数据目录。
  - issue B（#100）→ PR #116 已合并：内存里的前端会话密钥、`dist/ui` 静态托管、agent 工具集（不含 owner 命令、`sync.run`、`audit.record`）。审查修了一个安全问题：浏览器打不开时只在终端里打印带密钥的 URL，打开浏览器用绝对路径，防止有 shell 的 agent 拿到密钥。
  - issue D（#102）、G（#105）已由 Codex 实现、调度员本机检查通过并提交，在各自 clone 里等审查。

## 没合并的工作

| 分支 / clone | 内容 | 下一步 |
| --- | --- | --- |
| `codex/v1-sync`（`../unimelb-coursework-agent-sync`，未推送） | D：tasks 5.1–5.5；本机 check 659 通过 | 新上下文审查 → PR → CI → 合并；5.6 等你真机 |
| `codex/v1-revision`（`../unimelb-coursework-agent-revision`，未推送） | G：tasks 8.1–8.4，含 `unpdf@1.8.1`；本机 check 655 通过 | 新上下文审查 → PR → CI → 合并 |

## 下一步（按顺序）

1. 审查并合并 D、G（各自已并入 PR #116 后的 main）。
2. 派 C（#101）、F（#104）、E（#103）；之后 H（#106，等 A、B 已满足）。
3. K1（#109）要等你批准 `@types/react`、`@types/react-dom`。

## 等你决定

- 装 `@types/react`、`@types/react-dom`？（K1 前要）
- 补理由：#150（完整内置工具）、#154（接受完整工具的隐私后果）、#125、#127、#129、#132、#145，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。
- 复核 Claude 自主决定 #110、#111、#151、#152、#153。
- dsh 出题方式：PR #29 起一直欠题（PR #115、#116 也没排测验）。

## 等你动手

- R-B 3.5（任务 17.2）：终端里跑 `node dist/cli.js browser start`，登录 Canvas 和 Ed，跑 `browser status`，放一夜看登录能保持多久。
- D 合并后，任务 5.6：在真实 profile 上跑一次 `coursework sync`，把实际数量和问题记进 PR。
- GitHub → Settings → Emails 打开「Keep my email addresses private」。
- 同意删除已合并的旧 clone：`../unimelb-coursework-agent-rescope-cuts`、`-resident-browser`、`-autonomy`、`-schema`、`-owner-session`（安全钩子拦递归删除）。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。
- 规格：`openspec validate v1-delivery --strict`、`openspec validate --specs --strict`。
- 原型：浏览器直接打开 `design/prototype/index.html`。
- 开 socket 的测试（`test/protocol/http*.test.ts`）在 Codex 沙箱里会 `EPERM`，只能在本机跑；Codex 报告里的 HTTP 结论一律在本机复核。

## 陷阱

- HTTP 鉴权：契约里的写命令无论等级都要凭证（L0 的复习写入也一样）；只有读命令匿名可用。G 里定的规则，改 `src/protocol/http.ts` 时别丢。
- 多个分支同时改 `test/cli.test.ts` 的 MCP 工具数量断言，后合并的要按实际数量改并在注释里写清多出来的是哪些命令。
- `openspec archive` 遇到 MODIFIED 需求丢了旧场景会拒绝归档：改需求时保留旧场景名（可以改内容）；所有需求都被删的规格要手动删目录。
- 对话 agent 有 Bash（#150）：owner 命令只认内存里的前端会话密钥；别把密钥写盘、写日志或打印给非终端调用者。
- Agent SDK 是 0.x、商业许可：钉死版本，SDK 类型只放 `src/agent/claude.ts`。
- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 旧的变化事件表和旧 L0–L4 授权记录不能删（只加表，#107、#151）。
- 本机全局 git 身份不是公开身份：新 clone 先设 local 身份，推送前 `git log --format='%an %ae' -1` 核对。
- 验证证据只写进 PR 描述，不进仓库（#90）。
- 决定记录里的理由要标来源（用户原话 / 理由同 Claude / 理由待补），不替用户编理由。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
