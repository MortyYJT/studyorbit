# 交接

> 单文件，只写当前状态，覆盖而不追加。信任之前先对照 `git status` 和 `git log`。
> 背景：`note/product/vision.md`、`note/product/roadmap.md`、`note/decisions.md`（#1–#54）。

- **最后更新：** 2026-10-11，`main` 在 `9aa6004`（PR #26）再加本 PR（Ed 鉴权核实 + 交接）
- **项目：** `coursework`：以课业为核心的个人行动中心；定位「让通用 agent 能可靠读写墨大课业数据的工具层和运行时」（#29）
- **OpenSpec change：**
  - `v1-foundation`（M0）：代码全部合并；6.5 已勾（首次爬取 164 页 / 0 失败 / 13.6 分钟）；5.5 未勾（缺「登录最长能保持多久」，Ed 页面改由下面的 change 负责）。
  - `capture-selection-ed`（新，PR #26 合并，本 PR 补鉴权）：选课（#54）+ 只爬选定课程（#50）+ 跳回首页的页面只存一份 + Ed JSON 接口抓取（#52、#53）。任务分 issue A / B / C，尚未派发。

## 已完成（有证据）
- A–E、成绩推算、浏览器探测 + Canvas 自动爬取（PR #6、#13–#15、#17、#22）
- PR #25（另一个会话）：dsh 出题会话自动归组脚本，决定 #51
- PR #26：`capture-selection-ed` 规格；Codex 新上下文审查 2 轮（第 1 轮 1 处 `--crawl` 矛盾已修，第 2 轮 ready to merge）；CI 绿；squash 合并（分支里有 merge commit，rebase 合并被拒）
- Ed 实地调研（Claude 用内置浏览器，用户登录）：`note/product/ed-findings.md`
  - 课程列表 = `GET /api/user` 的 `courses`；当前学期依据 `year` + `session` + `status: active`
  - 鉴权：只带 cookie 返回 401；必须从 `localStorage` 的 `authToken:au` 读令牌放进 `x-token` 头
  - `/api/lessons/{id}` 不带 `view` 也是 200；带 `view=1` 会标已读
  - `/api/user` 含用户本人信息和推送订阅：只存 `courses`
- 用户回答（5.5）：一次登录撑完 13.6 分钟的爬取，没要求重新登录；登录时要 MFA

## 下一步（按顺序）
1. 按 `capture-selection-ed/tasks.md` 派 issue A（选课 + 共享限速），用 dispatch skill：独立 clone、Codex 实现、Claude 提交、Codex 只读审查、合并。A 合并后 B、C 并行。
2. 实现完成后用户实测（任务 3.9），顺便测「登录最长能保持多久」补 5.5，然后先归档 `v1-foundation` 再归档 `capture-selection-ed`。
3. dsh 补 Stage 3 测验（PR #22），不阻塞。
4. 起草 M1（`v1-sync`）。#46 的 `coursework login`：登录要 MFA，用户每次都要在场，掩码密码能省的事有限，起草时提出来再问用户。

## 运行与验证
- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`
- 原型预览：`.claude/launch.json` 的 `ui-prototype`（端口 4317）

## 陷阱
- **多个会话共用主 checkout**：本会话切分支时带走了另一个会话的提交，`git commit -a` 还扫进了它未提交的改动（已恢复）。**只在独立 clone 里工作**，不要动主 checkout 的分支，不要用 `commit -a`。
- **删远端分支被 `guard.sh` 当成 force push 拦下**：作废的 `claude/ed-capture-findings` 还在远端，用户可在 GitHub 网页删。
- **分支里有 merge commit 时 `gh pr merge --rebase` 会失败**：文档 PR 用 `--squash`。
- **不让用户写代码**（#42）：用户只会 Java；不用 TODO(human) / Learn by Doing，学习交给 dsh 测验（讲解用 Java 类比）。
- **Codex 优先**（#49）：审查用 `codex exec --sandbox read-only`（新上下文）；Codex 自称的「fresh-context review」是自审，不算数。Codex 会顺手改 `note/handoff.md`，派活时写明不许改。
- **Codex 不能提交**（#40）；后台运行要 `< /dev/null`；沙箱没网络，需要实地数据时由 Claude 用内置浏览器查（Ed 已登录在内置浏览器里）。
- **dsh headless 的进程名不含 `dsh headless`**：等待时按 PID。
- **不要 force-push**：已推送分支要同步 main 时用 merge。
- **合并规则**（#48）：审查「可以合并」+ 最新提交的 CI 绿 → Claude 合并。
- **仓库公开**：夹具只用合成数据；真实课程代码、课程 id、同学姓名、快照、profile 只在 `.local/`。
- **个人邮箱已进公开历史**（#9、#11）：只有开 GitHub 邮箱隐私设置能根治。
- **额度**：Pro 套餐。每完成一个里程碑就交接、开新对话。
- **模板**：用户的通用 AI 开发模板里 `repo-template/AGENTS.md` 第 54 行还是 Session hygiene 的原版，等用户回「同步」再改成 PR #11 的修正版。
- 用户本人的理由还空着：#6、#9、#15–18、#23、#27、#29、#53。
