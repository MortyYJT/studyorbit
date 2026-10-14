# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-delivery/`（唯一进行中的 v1 change）；决定看 `note/decisions.md`（#1–#153）。

- **最后更新：** 2026-10-15，分支 `claude/v1-delivery`（拆任务的 PR）。
- **模式：** 开发仍暂停（#114），本 PR 合并后进入「建 issue → 开发」。
- **本轮做了什么：**
  - `v1-rescope` 只带已实现的 A–C 规格归档（`openspec/changes/archive/2026-10-14-v1-rescope/`）；`course-selection` 空规格删掉（#151）。
  - 写了新 change `v1-delivery`：proposal、design、15 份增量规格、tasks（issue A–M，每组标了对应的 PRD 验收项）。`openspec validate v1-delivery --strict` 通过。
  - 用户拍板四项设计（#147–#150）：装 Claude Agent SDK；前端 Vite + React；用我们自己的浏览器工具；对话 agent 保留完整内置工具（没选 Claude 推荐的白名单，理由待补）。
  - Claude 自主定的三项待复核：#151（v1-rescope 收尾方式）、#152（quiz 类型；考试和未定类型要 L2）、#153（复习不做定时阶段）。

## 没合并的工作

| 分支 / clone | 内容 | 下一步 |
| --- | --- | --- |
| `claude/v1-delivery` | 本 PR：归档 v1-rescope、新 change、决定 #147–#153、路线图 | 新上下文审查后合并（纯文档） |
| `codex/revision-skill`（clone `../unimelb-coursework-agent-revision`，未推送） | 只装了 `unpdf@1.8.1` | 建 issue 时决定是否给 issue G 复用 |

## 下一步（按顺序）

1. 合并本 PR。
2. 用 `dispatch` 技能按 `v1-delivery/tasks.md` 第 2–17 组建 GitHub issue，每个 issue 抄它的「Covers」验收项；关闭旧 issue #31、#44、#46、#55、#77、#79、#92 并指向 `v1-delivery`（任务 1.4）。
3. 先做 issue A（数据模型，一次性加表迁移），之后按设计 13 最多三条 Codex 线并行。
4. issue K1 之前要用户同意装 `@types/react`、`@types/react-dom`（不在预批清单）。

## 等你决定

- 装 `@types/react`、`@types/react-dom`？（K1 前要）
- 补理由：#150（完整内置工具）、#125、#127、#129、#132、#145，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。
- 复核 Claude 自主决定 #110、#111、#151、#152、#153。
- 补理由：#154（接受完整工具的隐私后果）。
- dsh 出题方式：PR #29 起一直欠题。

## 等你动手

- R-B 3.5（现在是 `v1-delivery` 任务 17.2）：终端里跑 `node dist/cli.js browser start`，登录 Canvas 和 Ed，跑 `browser status`，放一夜看登录能保持多久。
- GitHub → Settings → Emails 打开「Keep my email addresses private」。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。
- 规格：`openspec validate v1-delivery --strict`、`openspec validate --specs --strict`。
- 原型：浏览器直接打开 `design/prototype/index.html`。
- 开 socket 的测试（`test/protocol/http*.test.ts`）在 Codex 沙箱里会 `EPERM`，只能在本机跑。

## 陷阱

- `openspec archive` 遇到 MODIFIED 需求丢了旧场景会拒绝归档：改需求时保留旧场景名（可以改内容）；所有需求都被删的规格要手动删目录。
- 对话 agent 有 Bash（#150）：授权类 owner 命令只认内存里的前端会话密钥，不认 `.local` 里的能力令牌文件；别把密钥写盘或写日志。
- Agent SDK 是 0.x、商业许可：钉死版本，SDK 类型只放 `src/agent/claude.ts`。
- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 旧的变化事件表和旧 L0–L4 授权记录不能删（只加表，#107、#151）。
- 安全钩子拦递归强制删除：已合并的旧 clone 要用户同意才能删（`../unimelb-coursework-agent-rescope-cuts`、`-resident-browser`、`-autonomy`）。
- 本机全局 git 身份不是公开身份：新 clone 先设 local 身份，推送前 `git log --format='%an %ae' -1` 核对。
- 验证证据只写进 PR 描述，不进仓库（#90）。
- 决定记录里的理由要标来源（用户原话 / 理由同 Claude / 理由待补），不替用户编理由。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
