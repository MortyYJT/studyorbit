# 交接

> 单文件，只写当前状态，覆盖而不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 依据：`docs/engineering/v1-technical-design.md`（v1 技术设计，开发唯一参照）、`note/decisions.md`（#1–#84）、`note/product/roadmap.md`。

- **最后更新：** 2026-10-12 上午，调度员（会话 585cc3fa）。本轮合并：#40、#41、#42、#45、#47、#49、#49（Q1 issue B）。
- **模式：全自动调度（#79）。** 用户在睡觉 / 不在线，只在必须决策时打断。

## 调度员守则（新会话第一件事读这里）
1. **心跳**：每完成一步就 `date +%s > /Users/yu-junteng/.coursework-dispatcher-heartbeat`（用绝对路径；`~`、`$()` 会触发权限弹窗）；查年龄用 `bash /Users/yu-junteng/.coursework-dispatcher-age.sh`。每小时的看门狗定时任务看到心跳超过 45 分钟没更新，才会拉起新的调度员；心跳是新的就直接退出。所以长时间等待（等 Codex、等 CI）时也要定期刷新心跳。
2. **分工**：Codex 负责实现、写规格、做审查（只读、新上下文）；Claude 子会话（Agent 工具）是 Codex 没额度时的后备；dsh 在 PR 合并后出题，异步进行、不阻塞。Claude 只做调度、检查、提交、推送、合并。按 `.claude/skills/dispatch/SKILL.md` 和 `AGENTS.md` 走。
3. **自己做决定**：文档没覆盖的选择，按推荐项自己定，记进 `decisions.md`（决定人写「Claude（自主，待用户复核）」），并列进本文件的「早上给用户看」一节。
4. **必须停下等用户的**：改红线、加预批清单外的依赖、对 Canvas/Ed 的写操作或真实提交、登录 / MFA、删除数据、花钱。遇到时把事项写进「等用户」一节，然后**继续做别的**，不要空等。
5. **Codex 额度**：报错里有 usage limit 和恢复时间。恢复时间在 5 小时以内的是 5 小时额度，只等待，期间做 Claude 能做的事或改用子会话；恢复时间超过 5 小时或明确写 weekly 的是**每周额度**，才用重置卡。优先让 Codex 自己重置（用户已开启）；不行再用 computer use 在 Codex 应用里点**免费的**重置卡，只要屏幕上出现价格、付款、升级套餐就立即停下。computer use 的授权弹窗没人点时，就等每周额度自动恢复。
6. **Claude 额度**：用完会话会直接停住，由看门狗在额度恢复后接着跑。所以本文件要随时保持最新：每合并一个 PR 就更新一次。
7. **并行**：最多 3 条 Codex 线，各用独立 clone（`../unimelb-coursework-agent-<topic>`）；不切主 checkout 的分支。
9. **不弹窗的写法**：一条 Bash 只做一件事，用 `git -C <clone>`，不用 `cd …&&`、`for`、管道、`~`；跑测试用 `npm run --prefix <clone> check -- <文件>`；`codex exec … < /dev/null` 直接后台运行、等完成通知，不写 `while pgrep` 轮询（`pgrep -f "codex exec"` 会匹配到循环自己，永远不结束）。
8. **控制上下文（用户 2026-10-12 要求）**：每次派给 Codex / 子会话的活只有一个 issue 那么大，提示词自包含，结果写进 `-o` 报告文件；调度员只读报告和需要的几行，绝不读整份日志。调度员自己的上下文变大时：更新本文件并推送 → `echo 0 > ~/.coursework-dispatcher-heartbeat` → 用 `run_scheduled_task` 立即运行 `coursework-dispatcher-watchdog`（它会接手当调度员）→ 归档旧会话，不用问用户。

## 正在跑的 Codex（`pgrep -fl "[c]odex exec"` 核对；报告在 `/Users/yu-junteng/.coursework-dispatcher-reports/`）
- **M1 issue D**（#48）：已提交推送到 `codex/v1-sync-ed`（`613bce3`），新上下文审查中，报告 `codex-review-m1-D.md`；通过后开 PR。
报告目录：报告都在 `/Users/yu-junteng/.coursework-dispatcher-reports/`。
交付流程：`git restore note/handoff.md`（如果被改了）→ 自己跑 check、读 diff → 用公开身份提交 → 新上下文 Codex 只读审查 → PR → CI 绿 → 合并（`--rebase`；有多次修复提交的用 `--squash`）。

## 工作队列（按顺序；能并行的并行）
1. **S0 `capture-selection-ed`**：3.1–3.8 已合并（#36、#41）。3.9 要用户登录实测；3.10 归档等 3.9。
2. **Q1 `ed-quiz-assist`**（截止 **10/25**，最晚 10/23 给用户实测）：A（#42）、B（#49）已合并。下一步 C（终端审阅）→ D → E。检查点：B 10/16，C 10/18，D 10/20，E 和结构检查 10/22。
3. **M1 `v1-sync`**：change（#40）和 1.1 合成探针（#45）已合并。1.2 真实探针要用户登录；**C（Canvas 适配器）按 tasks 要等 1.2 实测通过才开**。B（schema/迁移）已合并（#47）。D（Ed 规范化/脱敏）已派并在审查（#48）。之后查 E（私有 PDF）等不依赖 1.2 的组。
4. **M2 `v1-protocol`** → schema 合并后，同步、协议、界面三条线并行（M3 先接假数据）。
5. dsh 出题欠：PR #29、#32、#35、#36、#40、#41、#42、#45、#47、#49、Stage 3 / PR #22（等用户定方式）。

## 等用户（醒来后）
- **权限**：auto 模式分类器拦下了「往 `.claude/settings.local.json` 加白名单」（Self-Modification），我没有绕过。看门狗第 1 步已改成 `bash /Users/yu-junteng/.coursework-dispatcher-age.sh`；它第一次运行时弹窗，请点「始终允许」，之后就记在任务上了。
- 看下面「早上给用户看」里的自主决定。
- 登录 + MFA（S0 的 3.9、Q1 的真实结构检查、M1 的 Canvas 实测都要用）；顺便测「登录能保持多久」，补 `v1-foundation` 5.5。
- 10/23 前在真实 quiz 上跑 Q1：看答案 → 自己点提交。
- **权限被拦（2026-10-12，auto mode 分类器判为 Instruction Poisoning，未绕过）**：PR #34 审查第 5 条要求把 #79 写进 agent 规则文件，第 2 条要求改 `openspec/config.yaml`。需要你自己改或者批准：
  - `AGENTS.md:80`「Ask first before: … a design choice that document does not cover」→ 补一句：全自动模式（#79）下由调度员决定、记为待复核、列进 handoff。
  - `docs/engineering/v1-technical-design.md:3` 决定范围 `#55–#77` → `#55–#80`；`:6` 和第 8 节第 1 条「文档没覆盖的选择就停下问」→ 改成 #79 的停止清单。
  - `openspec/config.yaml`：去掉 iCal（第 5 行、「iCal URLs」）；「no auto-submission (no L4)」→ 按 #56 写 L0–L4 的条件。
  - 在你改之前，以 #79（更晚的决定）为准，调度照常进行。
- **身份泄露（已止损，需你决定是否删除）**：`../unimelb-coursework-agent-v1-design` 这个 clone 原来没有设置本地 Git 身份，旧分支 `claude/v1-technical-design` 的 5 个提交带着真实姓名和本机邮箱（只在私有仓库，没进 main）。已用公开身份重建为 `claude/v1-design`（内容一样），旧 PR #34 已关闭。还剩：要不要删远程旧分支 `claude/v1-technical-design`（删除属于守则第 4 条，我没删）；GitHub 的 `refs/pull/34` 只有 GitHub 支持能清。另外你的**全局** git 身份是真名，新 clone 必须先设 local 身份。
- **GitHub 账号邮箱公开**：在 GitHub 网页上合并时（rebase 或 squash），提交会带上账号邮箱（你的 Gmail）。main 上已经有约 100 个提交的 committer 是这个邮箱，#36 的 squash 提交 author 也是。建议在 GitHub → Settings → Emails 打开「Keep my email addresses private」，以后网页合并就会用 noreply。已经推送的历史不重写（私有仓库）。

## 早上给用户看（调度员自主做的决定，逐条追加）
- #81：Q1 凭据赋值整项不输出；带标签学号脱敏；**不带标签的 6–7 位纯数字不脱敏**（避免改坏数学题，剩余风险见 decisions）。
- #82：S0 发现页快照保存失败只计数，不中断 Ed 和摘要。
- #84：Q1 引用校验：明说「课件说……」必须带材料引用；不带出处的改写识别不出来，标成证据局限后接受。
- #83：M1 迁移时允许最小修改 `sqlite.ts` 的表名（`changes` → `change_event`），不加兼容视图。
- 两个 PR 都是两轮 Codex 审查后由我修最后一处并合并（#41、#42），按 #49。
- #80：Q1 自带最小版的脱敏、引文校验、单项 L3 授权（`.local/` 文件）和审计日志，不等 M1/M2（PR #34 审查第 3、4 条）。
- #80：`SourceItem.platform` 里的 `ical` 由 M1 删除，不在纯文档 PR 里改代码（审查第 2 条）。
- 驳回 PR #34 审查第 1 条（「L4 冲突」）：是我审查提示词写错了，以 #56 为准。
- S0 两轮审查后我自己又修了一处：页面里第三方 iframe 的跨源导航只拦掉、不让整个 Ed bootstrap 失败（Codex 的修复会让它失败）。加了测试，PR #36 已 squash 合并。
- 设计文档 PR #34 用公开身份重建为 #35 后合并，没有重写旧分支。

## 运行与验证
- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build` → `dist/cli.js`。最近一次：39 files / 296 passed / 2 skipped（PR #36 合并前的分支，CI 绿）。

## 陷阱（沿用）
- Codex 不能提交（#40），沙箱没网络，后台运行要 `< /dev/null`；测试必须放 `test/`；Codex 自审不算审查。
- `codex exec resume --last` 可能接错会话，返工用新的 `codex exec` 并贴上发现原文。
- 私有仓库没有分支保护：只靠本地 `guard.sh` 守住 main，绝不直接推 main、不 force-push。
- 夹具只用合成数据；真实课程、快照、profile 只在 `.local/`。
- 不让用户写代码（#42）；讲解用 Java 类比。
- 全局 git 身份是真名：每个新 clone 先 `git config --local user.name MortyYJT` 和 noreply 邮箱，提交前用 `git log --format='%an %ae' -1` 核对。
- Codex 会重写 `note/handoff.md`（连调度员守则都删）：派活时写明「不要改 note/handoff.md」，交付后 `git restore` 掉。
- 网页合并会带上账号邮箱，见「等用户」。
- 用户本人理由仍空着：#6、#9、#15–18、#23、#27、#29、#53、#67、#70。
