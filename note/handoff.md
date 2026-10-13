# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 进度看 `note/product/roadmap.md`（唯一进度表）；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-rescope/`（唯一进行中的 change）；决定看 `note/decisions.md`（#1–#113）。

- **最后更新：** 2026-10-14，`v1-rescope` 合并（PR #83）、确认 #96（#112）之后。
- **模式：** 用户在线时推进（#91）。看门狗定时任务 `coursework-dispatcher-watchdog` 已停用，不要重新打开。
- **本轮做了什么：** 规格整理（#110）：`v1-foundation`、`capture-selection-ed`、`v1-protocol` 连规格归档，现行规格 10 个能力；`v1-sync`、`ed-quiz-assist`、`v1-ui` 不同步规格关闭。写了 `v1-rescope`（proposal、design、15 个规格增量、tasks），`openspec validate --strict` 通过。用户答了 7 个设计问题（#103–#109）。

## 没合并的工作

| 分支 | 内容 | 下一步 |
| --- | --- | --- |
| `claude/protocol-integration` | 旧 M2 I | 按 `v1-rescope` 任务 4.1 拿有用的部分重做，不带关卡 |
| `codex/quiz-fill` | Q1 脚本填写 | 删除（任务 2.6） |
| `codex/ui-inventory` | M3 A 清单 | 删除（任务 2.6，v1-ui 已关闭） |

## 下一步（按顺序）

1. 派 `v1-rescope` issue A（删掉被砍的代码），然后 B（常驻浏览器）。
2. C（协议收尾）→ D（复习技能，**10/26 前在一门真实课程上能用**）；D 可以和 E/F 并行。
3. E（数据模型）→ F（`coursework sync`）→ G（批注）→ H（排期）→ I（界面）→ J（验收、归档）。

## 等你决定

- **复核 Claude 自主决定**：#110（规格整理方式）、#111（授权和审计的具体做法），以及旧的 #80–#89。
- 授权能不能在聊天里确认后由 agent 记录（现在只能在本人终端记）：会改红线，你提出来才改。
- dsh 出题方式：PR #29 起一直欠题。
- 补决定理由：#6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- 登录 + MFA：R-B 做完后在常驻 Edge 里登录 Canvas 和 Ed，放一夜，记下登录能保持多久。
- 装 `unpdf@1.8.1`（已预批，#74）：R-D 要用，你在场时批准安装。
- GitHub → Settings → Emails 打开「Keep my email addresses private」。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。
- `openspec validate v1-rescope --strict`。
- 开 socket 的测试（`test/protocol/http*.test.ts`）在 Codex 沙箱里会 `EPERM`，只能在本机跑。

## 陷阱

- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 旧的变化事件表不能删（#107 只允许删代码和规格，不删本机数据）。
- 本机全局 git 身份不是公开身份：新 clone 先设 local 身份，推送前 `git log --format='%an %ae' -1` 核对。
- 验证证据只写进 PR 描述，不进仓库（#90）。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
