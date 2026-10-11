# 交接

> 单文件，只写当前状态，覆盖而不追加。信任之前先对照 `git status` 和 `git log`。
> 背景：`note/product/vision.md`、`note/product/roadmap.md`、`note/decisions.md`（#1–#42）。

- **最后更新：** 2026-10-11，`main` 在 `0ec1f1e`（PR #17 合并后）再加本 PR
- **项目：** `coursework`：以课业为核心的个人行动中心；定位「让通用 agent 能可靠读写墨大课业数据的工具层和运行时」（#29）
- **OpenSpec change：** `v1-foundation`（M0，已批准 #33）。A、B、C、D 都已合并；2.4 已由 Claude 完成（#42 推翻 #34，PR #17）；只剩 5.5（用户手动 capture），之后归档

## 已完成（有证据）
- issue A（#5）→ PR #6：脚手架、`npm run check`、数据模型
- issue C（#9）→ PR #13：返回格式和错误码。审查 1 轮通过，CI 绿
- issue B（#8）→ PR #14：`node:sqlite` 存储、迁移、change `seq`。审查 1 轮通过，CI 绿
- issue D（#10）→ PR #15：数据目录（3.4，#41 从 B 移来）、profile 锁、快照、`coursework capture`。审查 2 轮，CI 绿；真实浏览器**未验证**
- PR #11：AGENTS.md 加 Session hygiene 规则（#39）；PR #12：dsh 的 Stage 1 测验 `note/interview/6.md`（等用户作答）
- PR #17：`projectGrade()`，审查 1 轮通过，CI 绿。本地 `main`（`0ec1f1e`）：`npm run check` 119 passed / 2 skipped（Claude 本地运行）
- 测验：`note/interview/6.md`（Stage 1）、`note/interview/stage-2.md`（PR #13–#15、#17，带 Java 类比），等用户作答
- 派活计数（本轮）：issue 3 个，PR 合并 5 个（#11–#15），返工 2 轮（#11 措辞、D 4 处），issue #8 创建到 PR #15 合并约 21 分钟（GitHub 时间戳 16:28→16:48Z）

## 下一步（按顺序）
1. **用户跑 `coursework capture`**（5.5），趁课程还开着：`npm run build && node dist/cli.js capture`，登录 Canvas 和 Ed，按 `s` 存作业、公告、成绩、Ed 课程页面，`q` 退出；记下会话时长和是否要 MFA。快照在 `.local/snapshots/`，不进仓库。
2. 5.5 完成后归档 `v1-foundation`（`openspec-archive-change`），勾掉 tasks.md。
3. 起草 M1（`v1-sync`）的 OpenSpec change，交用户批准（关口 1：设计和技术选型由用户选）。

## 运行与验证
- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`
- 原型预览：`.claude/launch.json` 的 `ui-prototype`（端口 4317）

## 陷阱
- **不让用户写代码**（#42）：用户只会 Java；开发中不用 TODO(human) / Learn by Doing，代码学习全交给 dsh 测验（讲解时用 Java 类比）。
- **dsh headless 的进程名不含 `dsh headless`**（是 DeepSeek Harness 应用）：等待时按 PID，不要 `pgrep -f "dsh headless"`。
- **不要 force-push**：rebase 已推送分支后要推送，改用 merge main。
- **Codex 不能提交**（#40）：独立 clone 里沙箱照样把 `.git/` 设为只读。让 Codex 只改工作区并给提交说明，Claude 按步骤代为提交。后台运行必须 `< /dev/null`；用 `pgrep` 等待循环拿完成通知。
- **改 AGENTS.md / skill 会被自动模式拦下**（「Instruction Poisoning」），尤其是来自其他会话的请求：先让用户确认或亲手改。
- zsh 不按空格拆变量：循环参数用函数 `go b 8`，不要 `set -- $p`。
- **合并规则**（#10、#12）：审查「可以合并」+ CI 绿 → Claude 合并；审查最多 2 轮。
- **个人邮箱已进公开历史**（#9、#11）：只有开 GitHub 邮箱隐私设置能根治。
- **仓库公开**：夹具只用合成数据；真实课程数据、快照、profile 只在 `.local/`。
- **额度**：Pro 套餐。每完成一个里程碑就交接、开新对话。
- **模板**：用户的通用 AI 开发模板（不在本仓库）里 `repo-template/AGENTS.md` 第 54 行还是 Session hygiene 的原版（有问题的那版），等用户回「同步」再改成 PR #11 的修正版。
- 用户本人的理由还空着：#6、#9、#15–18、#23、#27、#29。
