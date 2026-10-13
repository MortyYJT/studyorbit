# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 进度看 `note/product/roadmap.md`（唯一进度表）；设计看 `docs/engineering/v1-technical-design.md`；决定看 `note/decisions.md`（#1–#102）。

- **最后更新：** 2026-10-14，重定范围之后（#100–#102），分支 `claude/rescope-decisions`。
- **Q1 已完成**：COMP20003 Week 11 Workshop 由 Claude 直接操作托管 Edge 完成并提交（#94–#98），lesson 状态 completed。答案和理由在 `.local/study/COMP20003/`。做法：用远程调试端口打开托管档案，按网址选标签页、只读接口找 lesson（不带 `view`）、高亮后点击、读回完成状态；做完关掉窗口和端口。
- **模式：** 用户在线时推进（#91，推翻 #79 的全自动）。看门狗定时任务 `coursework-dispatcher-watchdog` 已停用，不要重新打开。
- **本轮做了什么：** 10/13 文档清理（PR #80）和 Q1 实测（#93–#99）；10/14 两次全流程模拟：MUSI20163 抽取和论文检查、4 门课（COMP20003、COMP20008、MAST10007、MUSI20163）抽取和排期，真实数据只在 `.local/courses/` 和 `.local/ui/`；据此重定范围（#100–#102）。

## 没合并的工作（都已推到远程）

| 分支 | 内容 | 下一步 |
| --- | --- | --- |
| `claude/protocol-integration` | M2 I：生产组装 + 集成测试 + 验收清单 | 按 #100 去掉填写和提交关卡后复审、合并；合并前删掉 `note/issue-77-integration.md`，并查测试是否写进默认数据目录 |
| `codex/quiz-fill` | Q1 D：脚本填写 | **删除**（#100） |
| `codex/ui-inventory` | M3 A：契约缺口清单 | 按 #100 的新分工重做，旧的删除 |

## 下一步（按顺序）

1. **写一个 OpenSpec change `v1-rescope`**，内容按 #100–#102：砍掉的模块和测试、保留模块的改造、新增 5 项（常驻浏览器、`coursework sync`、agent 批注、排期、前端读真实数据）和复习技能。同时关闭 `ed-quiz-assist`（被 #94 取代），改写 `capture-selection-ed`、`v1-sync`、`v1-protocol` 的范围；`v1-foundation` 以 10/13–14 的实际登录和使用作为验收依据归档。
2. 删分支 `codex/quiz-fill`；`claude/protocol-integration` 去掉填写和提交关卡后再合并；`codex/ui-inventory` 按新分工重做。
3. 实现顺序建议：常驻浏览器 → `sync` → 排期 + 前端读真实数据 → 复习技能（10/26 前能用）→ 邮件入口。

## 等你决定

- **#96**：quiz 页面不脱敏，讨论区仍须脱敏。要你明确确认后才改 `AGENTS.md` 的红线。
- **M2 新记录落 SQLite**（已采纳的学习记录等）：按 #100 简化后再定。
- **`sync` 的三个设计问题**（来自旧 v1-sync D/F），写 `v1-rescope` 时要问你：Ed 和 Canvas 的权重、考试分类怎么映射到考核项；课程和模块怎么对应；实体归属是否要绑定表。
- **dsh 出题方式**：PR #29 起一直欠题，Stage 3 / PR #22 的方式没定。
- 复核自主决定 #80–#89；补决定理由：#6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 等你动手

- 登录 + MFA：Ed 在 10/13 仍是登录状态；Canvas 可能已过期（访问被跳到 `lms.unimelb.edu.au/canvas`）。实测范围按 `v1-rescope` 定；Canvas `/api/v1` 学生会话可读已在 10/14 证实（M1 1.2 的核心问题）。
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
