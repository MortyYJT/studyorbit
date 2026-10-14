# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（唯一的需求来源，带验收清单）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/v1-rescope/`；决定看 `note/decisions.md`（#1–#146）。

- **最后更新：** 2026-10-15，PR #94（PRD）和 #95（前端原型 + 界面决定）合并之后。
- **模式：** **开发暂停中（#114）**。新流程：PRD → 架构图 → 原型 → 用技能拆任务、建 GitHub issue → 开发 → 审查 → 合并 → 用户按 PRD 验收。前三步已完成。
- **本轮做了什么：**
  - 用户画了架构图（桌面 `作业中心架构图.drawio`，右半边是 Claude 按 PRD 画的新版，用户认可）。
  - 写了 PRD（#115）并逐条答完待定问题（#114–#133）：前端是唯一入口，第一版只接 Claude Agent SDK（#116、#123）；等级按作业类型分 L0 只读 / L1 quiz / L2 作业论文（#120）；课程默认等级 + 单项覆盖，只能在前端设（#117、#122）；提交前默认确认（#121）；禁止 AI 的课锁 L0、没记录政策的课不设上限、考试不单设检查（#124–#126）；复习不赶今年期末（#127）；同步手动，邮件入口以后做（#128、#129）。
  - 界面设计（#134–#146）：顶部「本周 / Agent」+ 头像菜单；首页七列周视图（全天行在上、排期只排到天、时间用户自己定）+ 右侧课程栏；课程页分数圆环 + 考核项 / 复习分页；考核项抽屉带来源标记；Agent 是独立对话页，从各处点进去带预设提示词。
  - 简历草稿按新架构改写（未做的条目标「做完才写」）。

## 没合并的工作

| 分支 / clone | 内容 | 下一步 |
| --- | --- | --- |
| `codex/revision-skill`（clone `../unimelb-coursework-agent-revision`，未推送） | 旧 issue D #92（复习技能）的准备，只装了 `unpdf@1.8.1`，没有实现代码 | 等新 change 拆完任务后决定沿用还是关闭 #92 |

## 下一步（按顺序）

1. **拆任务**：用 `openspec-propose` 写一个新 change，接替 `v1-rescope` 里没做完的部分（E 数据模型、F `coursework sync`、G 批注、H 排期、I 前端、复习技能），并加上新需求：agent 对话后端和 Claude Agent SDK 适配器、对话持久化、预设提示词、前端设授权（#122）、排期只到天 + 用户定时间（#145）、七列周视图、分数圆环。`v1-rescope` 里已完成的 R-A/B/C 保留，剩下的任务在新 change 里重写后关闭旧的。
2. 用 `dispatch` 技能把新 change 的任务建成 GitHub issue，每个 issue 附 PRD 对应用户故事的验收清单。
3. 恢复开发：Codex 实现 → 新上下文审查 → CI 通过后合并 → 用户按 PRD 验收。
4. 用户的 R-B 3.5（常驻 Edge 登录能保持多久）仍未做，同步和 agent 操作网页都依赖它。

## 有问题怎么办（本轮和用户约定）

- 小问题（bug、漏测试）：在当前 PR 里修。
- 会改设计的问题：停下来问用户，记进 `decisions.md`，先改 PRD / OpenSpec，再写代码。不悄悄改范围。
- 验收不通过：开新 issue 关联对应用户故事，修完用户再验。

## 等你决定

- 补理由：#125、#127、#129、#132、#145，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。
- 复核 Claude 自主决定 #110、#111（#111 的授权方式已被 #122 部分修改）。
- dsh 出题方式：PR #29 起一直欠题。

## 等你动手

- R-B 3.5：在你的终端里跑 `node dist/cli.js browser start`，登录 Canvas 和 Ed，跑 `browser status`，放一夜看登录能保持多久。
- GitHub → Settings → Emails 打开「Keep my email addresses private」。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。
- 原型：浏览器直接打开 `design/prototype/index.html`。
- 开 socket 的测试（`test/protocol/http*.test.ts`）在 Codex 沙箱里会 `EPERM`，只能在本机跑。

## 陷阱

- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 旧的变化事件表不能删（#107 只允许删代码和规格，不删本机数据）。
- 安全钩子拦递归强制删除：已合并的旧 clone 要用户同意才能删（`../unimelb-coursework-agent-rescope-cuts`、`-resident-browser`、`-autonomy`）。
- 本机全局 git 身份不是公开身份：新 clone 先设 local 身份，推送前 `git log --format='%an %ae' -1` 核对。
- 验证证据只写进 PR 描述，不进仓库（#90）。
- 决定记录里的理由要标来源（用户原话 / 理由同 Claude / 理由待补），不替用户编理由。
- 其余派活陷阱见 `.claude/skills/dispatch/SKILL.md`「Known pitfalls」。
