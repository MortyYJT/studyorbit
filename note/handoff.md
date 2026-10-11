# 交接

> 单文件，只写当前状态，覆盖而不追加。信任之前先对照 `git status` 和 `git log`。
> 背景：`note/product/vision.md`、`note/product/roadmap.md`、`note/decisions.md`（#1–#54）。

- **最后更新：** 2026-10-11 深夜，`main` 在 `1b7a6f2`（PR #32 合并后）再加本交接 PR
- **项目：** `coursework`：以课业为核心的个人行动中心；定位「让通用 agent 能可靠读写墨大课业数据的工具层和运行时」（#29）
- **OpenSpec change：**
  - `capture-selection-ed`：任务 1.x（issue A）、2.x（issue B）已合并并勾选；3.1–3.6（issue C）在分支 `codex/ed-capture` 上，尚未开 PR；3.7–3.10 未做。
  - `v1-foundation`（M0）：代码全部合并；5.5 未勾（缺「登录最长能保持多久」）。

## 本会话完成（有证据）
- **Issue A #28 → PR #29 合并**（`c366b63`）：`src/capture/` 下 discovery、discovery-adapters、limiter、selection-store、picker、selection-resolver，测试在 `test/capture/`。Claude 本地检查 34 files / 210 passed / 2 skipped；Codex 只读审查 1 轮 ready；CI 绿。
  - Claude 对照本机真实 `/courses` 快照的**结构**（不复制内容）核实：当前注册在 `table#my_courses_table`；12 行里学期列是「2026 Semester 2」×5、「默认学期」×6、「Course Term」×1；**3 行未发布课程没有链接**，Codex 初版会因此把整个 Canvas 判为不可用，已改为跳过并计数。
- **Issue B #30 → PR #32 合并**（`1b7a6f2`）：`crawl.ts` 只爬选定课程、重定向最终 URL 每次运行只存一份、共享限速。审查 2 轮：第 1 轮 P2（快照去重吞掉了列表页的链接发现，公告详情永远不抓）已修；第 2 轮 ready；CI 绿；227 passed。
- **Issue C #31（进行中）**：分支 `codex/ed-capture` 已推送，最新 `5c1fde4`（含 merge main）。3.1–3.6：ed-transport、ed-snapshot、ed-capture、command/session/cli 接线。Claude 本地检查 39 files / 290 passed / 2 skipped。
  - 审查第 1 轮 changes needed，4 处已修（`5c1fde4`）：Ed discovery 改走页面内过滤的 transport；对象键里的令牌也删掉；Ed 启动导航用 `page.route` 拦截跨源重定向（因此给浏览器启动加了 `serviceWorkers: 'block'`）；picker 输出改写到输出流（`readline.Interface.write()` 会写进**输入**流）并把课程行清成单行。
  - **第 2 轮审查还没跑**：Codex 额度用完，2026-10-12 02:31 恢复。

## 下一步（按顺序）
1. 在 clone `../unimelb-coursework-agent-ed-capture`（分支 `codex/ed-capture`）对 `1b7a6f2..HEAD` 跑 Codex 只读审查第 2 轮（重点核对 `5c1fde4` 的 4 处修复，尤其 `ed-transport.ts` 的 `bootstrap()`：`route.fetch` 是否带浏览器 cookie、逐跳重定向是否都计入限速）。ready 后勾 3.1–3.6，开 PR（`Refs #31`，不关 issue），CI 绿后合并。
2. 派 3.7–3.8（B 已合并，把真实 Canvas runner 接进 orchestration；集成测试；`openspec validate capture-selection-ed --strict`），关 #31。
3. 用户实测 3.9（登录 + MFA，顺便测「登录最长能保持多久」补 5.5），再先归档 `v1-foundation`、后归档 `capture-selection-ed`。
4. dsh 测验：PR #29、#32（以及之前欠的 Stage 3 / PR #22）。本会话没排：dispatch 要在主 checkout 切 `dsh/quiz-*` 分支，和「多会话共用主 checkout」冲突；下个会话先确认主 checkout 没有其他会话在用再排。
5. 起草 M1（`v1-sync`）。

## 本会话统计（简历证据用）
- 派发 issue 3 个（#28、#30、#31）；合并 PR 2 个（#29、#32）
- 审查发现：A 0（另有 Claude 自查 1 个真实数据 bug + 测试位置）；B 1（P2）；C 4（2×P1、2×P2）
- 返工轮次：A 1、B 1、C 1（未完）
- 派发到合并：A、B 各约半小时（按提交时间估，未精确计时）

## 运行与验证
- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`
- 原型预览：`.claude/launch.json` 的 `ui-prototype`（端口 4317）

## 陷阱
- **Codex 额度会用完**：用完时 `codex exec` 中途退出、不写 `-o` 报告，工作区留半成品；看 `.log` 末尾的 `usage limit`。
- **`codex exec resume --last` 可能接上同目录里更晚的审查会话**：返工改用新的 `codex exec` 并把发现原文贴进去。
- **Codex 偏爱把测试放 `src/`**：vitest 只收 `test/**/*.test.ts`，`tsconfig.build.json` 会把 `src/**` 全编进 `dist`。派活时写明测试放 `test/`。
- **Codex 会自审并声称「独立审查 ready」**：不算数，必须另起只读会话。
- **多个会话共用主 checkout**：只在独立 clone 里工作，不切主 checkout 的分支，不用 `commit -a`。
- **删远端分支被 `guard.sh` 拦**：作废的 `claude/ed-capture-findings` 等用户在 GitHub 网页删（不删也没影响）。
- **分支里有 merge commit 时 `--rebase` 合并会失败**：用 `--squash`（`codex/ed-capture` 现在就有 merge commit）。
- **不让用户写代码**（#42）：不用 TODO(human) / Learn by Doing，学习交给 dsh 测验（讲解用 Java 类比）。
- **Codex 不能提交**（#40）；后台运行要 `< /dev/null`；沙箱没网络，实地数据由 Claude 查（只看结构，不复制内容）。
- **dsh headless 的进程名不含 `dsh headless`**：等待时按 PID。
- **不要 force-push**：已推送分支要同步 main 时用 merge。
- **合并规则**（#48）：审查「可以合并」+ 最新提交的 CI 绿 → Claude 合并。
- **仓库公开**：夹具只用合成数据；真实课程代码、课程 id、同学姓名、快照、profile 只在 `.local/`。
- **个人邮箱已进公开历史**（#9、#11）：只有开 GitHub 邮箱隐私设置能根治。
- **额度**：Claude Pro。每完成一个里程碑就交接、开新对话。
- **模板**：用户的通用 AI 开发模板里 `repo-template/AGENTS.md` 第 54 行还是 Session hygiene 的原版，等用户回「同步」再改成 PR #11 的修正版。
- 用户本人的理由还空着：#6、#9、#15–18、#23、#27、#29、#53。
