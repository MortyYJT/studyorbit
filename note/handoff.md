# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 进度看 `note/product/roadmap.md`（唯一进度表）；设计看 `docs/engineering/v1-technical-design.md`；决定看 `note/decisions.md`（#1–#92）。

- **最后更新：** 2026-10-13，文档清理会话，分支 `claude/docs-cleanup`。
- **模式：** 用户在线时推进（#91，推翻 #79 的全自动）。看门狗定时任务 `coursework-dispatcher-watchdog` 已停用，不要重新打开。
- **本轮做了什么：** 合并 4 份协议说明为 `docs/engineering/protocol.md`；删掉 15 份按 issue 写的过程证据（#90）；补勾已合并 PR 对应的 tasks；修正 `openspec/config.yaml`（去 iCal、按 #56 写 L0–L4）；技术设计第 8 节改成在线推进；README 重写；roadmap 改成带「卡在哪」的进度表；dispatch 技能补上已知陷阱。

## 没合并的工作（都已推到远程）

| 分支 | 内容 | 下一步 |
| --- | --- | --- |
| `claude/protocol-integration` | M2 I（issue #77）：生产组装 + 集成测试 + 验收清单 | 第 1 轮审查的 4 处 P2 已修（`11c35df`），要复审 → 本机跑 check（含 socket 测试）→ PR。合并前删掉 `note/issue-77-integration.md` |
| `codex/quiz-fill` | Q1 D（issue #55）：L3 填写 + 被动记录提交请求 | 等用户选接管方式（见下）后返工 → 审查 → PR。合并前删掉 `note/issue-55-implementation.md` |
| `codex/ui-inventory` | M3 A（issue #79）：M2 契约缺口清单 | 审查 → PR；Hermes `--help` 没跑通，1.3 实测要用户 |

## 等你决定

1. **Q1 填写怎么接管已登录的浏览器**（D 的检查点 10/20，quiz 截止 10/25）。A：在 capture 会话里加一条 `f` 命令；B：capture 开本地 Unix socket，`quiz fill` 发请求过去；C：fill 自己启动托管档案、等你打开 quiz 页面再填（capture 运行时返回 `LOCKED`）。推荐 C：改动最小、不加通道、10/20 前做得完。需要你选并说明理由。
2. **M2 新记录落 SQLite**：已采纳的学习记录、每个考核的「已填写」状态、未用的提交确认，现在只在内存里。要加新表，属于改存储结构；M3 接真数据前要定。
3. **M1 三个设计问题**（来自 v1-sync D/F）：Ed 的权重和 exam/hurdle 分类怎么映射到 Assessment；Ed/Canvas 课程和模块怎么对应；同步时实体归属（provider/course/collection）是否要一张绑定表。
4. **复核自主决定 #80–#89**：可以整体认可，也可以逐条推翻。
5. **补理由**：#6、#9、#15–18、#23、#27、#29、#53、#67、#70 还空着你本人的理由。
6. **dsh 出题方式**：PR #29 起一直欠题，Stage 3 / PR #22 的方式没定。

## 等你动手

- 登录 + MFA，一次做完：S0 3.9、M0 5.5（顺便测登录能保持多久）、M1 1.2（Canvas `/api/v1` 实测）、Q1 5.4（真实结构检查）。
- 10/23 前在真实 quiz 上跑 Q1：看答案 → 自己点提交。
- 装 `unpdf@1.8.1`（已预批，#74）：M1 E 要用。上次被 auto 模式分类器拦下；你在场时可以直接批准我来装。
- GitHub → Settings → Emails 打开「Keep my email addresses private」，否则网页合并会写入账号邮箱。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。
- 开 socket 的测试（`test/protocol/http*.test.ts`）在 Codex 沙箱里会 `EPERM`，只能在本机跑。

## 陷阱

- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 本机全局 git 身份不是公开身份：新 clone 先设 local 身份，推送前 `git log --format='%an %ae' -1` 核对。
- 验证证据只写进 PR 描述，不进仓库（#90）；Codex 交付里带的证据文件，合并前删掉。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
