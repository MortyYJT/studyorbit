# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 进度看 `note/product/roadmap.md`（唯一进度表）；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-rescope/`（唯一进行中的 change）；决定看 `note/decisions.md`（#1–#113）。

- **最后更新：** 2026-10-14 03:45，issue A、B、C 合并之后（PR #86、#88、#91）。issue D（#92）已写好、clone 已备好，但 Codex 用量用完（7:20 恢复），还没开始实现。
- **模式：** 用户在线时推进（#91）。看门狗定时任务 `coursework-dispatcher-watchdog` 已停用，不要重新打开。
- **本轮做了什么：** 规格整理（#110）：`v1-foundation`、`capture-selection-ed`、`v1-protocol` 连规格归档，现行规格 10 个能力；`v1-sync`、`ed-quiz-assist`、`v1-ui` 不同步规格关闭。写了 `v1-rescope`（proposal、design、15 个规格增量、tasks），`openspec validate --strict` 通过。用户答了 7 个设计问题（#103–#109）。

## 没合并的工作

| 分支 / clone | 内容 | 下一步 |
| --- | --- | --- |
| `codex/revision-skill`（clone `../unimelb-coursework-agent-revision`，未推送） | issue D #92：学习记录入 SQLite、`source.fetch`、复习技能；clone 里只装了 `unpdf@1.8.1`（`package.json`、lock 已改） | Codex 恢复后重新派：issue 正文在 #92，派活提示词见 dispatch 技能第 3 步 |

## 下一步（按顺序）

1. Codex 恢复后（10/14 7:20 以后）重新派 issue D（#92）；**目标 10/26 在一门真实课程上能用**。D 可以和 E/F 并行。
2. 你做 R-B 3.5：`node dist/cli.js browser start`（要在你的终端里跑，需要 TTY），在常驻 Edge 里登录 Canvas 和 Ed，跑 `node dist/cli.js browser status`，放一夜，记录登录能保持多久。D 的真机验收也要靠它。
3. E（数据模型）→ F（`coursework sync`）→ G（批注）→ H（排期）→ I（界面）→ J（验收、归档）。

## 派活记录

- issue A #85 → PR #86：两轮复审（第一轮 3 条覆盖缺口），一次范围例外（迁移 002 改 import）。
- issue B #87 → PR #88：两轮复审共 5 条竞态和恢复问题；第二轮的 3 条由 Claude 先写测试再修复。
- issue C #89 → PR #91：两轮复审共 4 条（审计隐私、技能挡住写操作、原因码被过滤、审计丢失目标）；第二轮的 2 条由 Claude 先写测试再修复。旧分支 `claude/protocol-integration` 已删。
- issue D #92：第一次派活因 Codex 用量用完失败，未产生代码。

## 等你决定

- **复核 Claude 自主决定**：#110（规格整理方式）、#111（授权和审计的具体做法），以及旧的决定 #80–#89。
- 授权能不能在聊天里确认后由 agent 记录（现在只能在本人终端记）：会改红线，你提出来才改。
- dsh 出题方式：PR #29 起一直欠题。
- 补决定理由：#6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- 登录 + MFA：见「下一步」1。
- 装 `unpdf@1.8.1`（已预批，#74）：R-D 要用，你在场时批准安装。
- GitHub → Settings → Emails 打开「Keep my email addresses private」。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。
- `openspec validate v1-rescope --strict`。
- 开 socket 的测试（`test/protocol/http*.test.ts`）在 Codex 沙箱里会 `EPERM`，只能在本机跑。

## 陷阱

- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 旧的变化事件表不能删（#107 只允许删代码和规格，不删本机数据）。
- 安全钩子拦递归强制删除：用完的 clone 要你同意才能删（`../unimelb-coursework-agent-rescope-cuts`、`../unimelb-coursework-agent-resident-browser`、`../unimelb-coursework-agent-autonomy` 已合并，可删；最后一个的 `.local/` 里有早先测试写入的合成数据）。
- 本机全局 git 身份不是公开身份：新 clone 先设 local 身份，推送前 `git log --format='%an %ae' -1` 核对。
- 验证证据只写进 PR 描述，不进仓库（#90）。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
