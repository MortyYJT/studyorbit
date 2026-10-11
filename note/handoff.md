# 交接

> 单文件，只写当前状态，覆盖而不追加。信任之前先对照 `git status` 和 `git log`。
> 背景：`note/product/vision.md`、`note/product/roadmap.md`、`note/decisions.md`（#1–#50）。

- **最后更新：** 2026-10-11，`main` 在 `d6fcab4`（PR #23 合并后）再加本交接 PR
- **项目：** `coursework`：以课业为核心的个人行动中心；定位「让通用 agent 能可靠读写墨大课业数据的工具层和运行时」（#29）
- **OpenSpec change：** `v1-foundation`（M0）。任务组 1–6 代码全部合并；只剩 5.5 / 6.5（用户手动跑 capture），之后归档

## 已完成（有证据）
- A–D（PR #6、#13–#15）、成绩推算（PR #17，#42）、浏览器探测 + Canvas 自动爬取（PR #22，issue #20，#43–#47）
- 规则：Claude 合并所有 PR、用户不审核（#48）；Codex 优先做实现、文档和审查（#49）；AGENTS.md / dispatch skill / 指南已同步（PR #21）；数据访问红线允许 TTY 掩码的 `coursework login`（#46，排进 M1）
- 本地 `main`（`2d32070`）：`npm run check` 190 passed / 2 skipped（Claude 本地运行）；CI 绿
- 测验：`note/interview/6.md`、`stage-2.md` 等用户作答

## 首次真实爬取（2026-10-11，用户本机，数据只在 `.local/`）
- Edge 自动探测成功；Canvas 爬取 `completed`：164 页、0 失败、13.6 分钟；未碰 300 页上限。Ed 未抓。
- `/courses` 当前学期列出 12 条，其中只有 3–4 门是正式科目，其余是社区、培训模块、导师计划等；公告详情大半来自社区。
- 部分科目的「作业」「大纲」「公告」页在 Canvas 上被关闭，访问会跳回课程首页（首页因此重复存了 2–3 份）。**有两门科目的作业布置在 Ed 上**（用户确认），所以 Canvas 里本来就没有。
- 作业详情页正文抓到了，但大多数页面找不到「截止」字样，截止日期的位置要在 M1 写解析器时查（界面是中文）。
- 快照含用户真实姓名和真实课程代码：只在 `.local/`，不得进仓库、夹具或文档。

## 下一步（按顺序）
1. **新 change（小）：爬取只爬用户选定的课程**（#50）。先定选择方式（建议：`c` 先列出 `/courses` 里当前学期的课，用户在终端勾选，选择存进 `.local/` 并在下次默认沿用）；同时处理「跳回首页的页面只存一份」。让 Codex 起草规格和实现，Codex 只读审查，Claude 合并（#48、#49）。
2. **Ed 的抓取**：部分科目的作业在 Ed 上，Ed 是单页应用。先让用户用 `s` 手动存几页 Ed（作业、课程、讨论），再决定是并进上面的 change 还是放进 M1。
3. 完成 5.5 后归档 `v1-foundation`：5.5 还差 Ed 页面（每门课的课程、作业、讨论页）和两项记录（登录会话能保持多久、是否触发 MFA），向用户问清后补进 PR 说明，再归档。
4. dsh 补 Stage 3 测验（PR #22），不阻塞。
5. 起草 M1（`v1-sync`），包含是否做 `coursework login`（#46）。

## 运行与验证
- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`
- 原型预览：`.claude/launch.json` 的 `ui-prototype`（端口 4317）

## 陷阱
- **不让用户写代码**（#42）：用户只会 Java；开发中不用 TODO(human) / Learn by Doing，代码学习全交给 dsh 测验（讲解时用 Java 类比）。
- **dsh headless 的进程名不含 `dsh headless`**（是 DeepSeek Harness 应用）：等待时按 PID，不要 `pgrep -f "dsh headless"`。
- **不要 force-push**：rebase 已推送分支后要推送，改用 merge main。
- **Codex 优先**（#49）：审查用 `codex exec --sandbox read-only`（新上下文）；只读沙箱里 vitest 跑不起来（写不了 `.vite-temp`），测试由 Claude 跑。
- **Codex 不能提交**（#40）：独立 clone 里沙箱照样把 `.git/` 设为只读。让 Codex 只改工作区并给提交说明，Claude 按步骤代为提交。后台运行必须 `< /dev/null`；用 `pgrep` 等待循环拿完成通知。
- **改 AGENTS.md / skill**：Claude 直接改可能被自动模式或钩子拦下；交给 Codex 在 clone 里改最顺。
- zsh 不按空格拆变量：循环参数用函数 `go b 8`，不要 `set -- $p`。
- **合并规则**（#48）：审查「可以合并」+ CI 绿 → Claude 合并，含设计 PR；不再交给用户。合并前要等最新提交的 CI 跑完（`gh run list` 按 headSha 等待），别被上一个提交的绿灯骗。
- **个人邮箱已进公开历史**（#9、#11）：只有开 GitHub 邮箱隐私设置能根治。
- **仓库公开**：夹具只用合成数据；真实课程数据、快照、profile 只在 `.local/`。
- **额度**：Pro 套餐。每完成一个里程碑就交接、开新对话。
- **模板**：用户的通用 AI 开发模板（不在本仓库）里 `repo-template/AGENTS.md` 第 54 行还是 Session hygiene 的原版（有问题的那版），等用户回「同步」再改成 PR #11 的修正版。
- 用户本人的理由还空着：#6、#9、#15–18、#23、#27、#29。
