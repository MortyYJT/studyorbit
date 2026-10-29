# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。决定看 `note/decisions.md`。

- **最后更新：** 2026-10-30，Claude。
- **主线：** `main` 含 PR #245（期末需要、复习页、添加任务）、#246（每周计划）、#247（全局清理，#239）；规则精简为单一文件 `CLAUDE.md`（#241）。
- **项目是什么：** StudyOrbit（仓库 `MortyYJT/studyorbit`，本地 `origin` 已指向新地址），本地优先的墨大课业原型。Edge 已登录会话发现 Canvas 课程 → 脚本采集 Canvas / Ed / Handbook → 模型整理成课程 JSON（`shared/course-data.ts` 校验）→ 网页展示成绩、计划、复习、Agent 对话。本地接口在独立的本地服务（`server/`，`127.0.0.1:5190`），Vite（`localhost:5173`）只提供页面并代理 `/api/local`；`npm run dev` 一起启动（`local-server-sync-pipeline` 第 1 部分合并后）。
- **OpenSpec：** `course-contract-v2` 已全部合并并归档（PR #259、#262、#265、#266）。`local-corrections-merge`（#290–#298）：第 1 部分（`.local/corrections/` 存储、接口、localStorage 一次性迁移，决定 #375–#384）PR #269、第 2 部分（三方合并和冲突，决定 #385–#394）PR #271 已合并；第 3 部分（变更记录和提醒，分支 `claude/change-log`，决定 #410–#414）已开 PR 待审查合并，该 PR 里已把整个变更归档到 `openspec/changes/archive/`，规格并入 `openspec/specs/`（`local-corrections`、`course-change-log`）。`local-server-sync-pipeline`（PR #272、#275、#277、#278、#279）和 `chat-tools-mcp`（PR #264、#267、#273、#270）已在 `local-server-sync-pipeline` 第 4 个 PR 里归档（决定 #435–#437）；还在进行的是 `generic-adapters`。
- **现行规格：** 在 `openspec/specs/`（`agent-chat`、`chat-qa-eval`、`course-analysis`、`course-change-log`、`course-contract`、`course-mcp-server`、`course-tools`、`grade-target`、`local-api-server`、`local-corrections`、`revision`、`staged-course-sync`、`sync-job-store`、`sync-resume-measurement`、`weekly-plan`）。进度表在 `note/product/roadmap.md`。

## 已完成

- **期末需要（#235）：** `finalNeeded()`，按 100 − 已出分占比算剩余平均需要多少；已稳 / 无法达到；每门课记住目标档；注明未识别权重。测试 `test/grade-target.test.ts`。
- **复习页（#236）：** 考试信息；三个预设提示词按钮（点击才发送，用模型额度）；单课程对话里完成的回复可「存到复习」，存 `.local/revision/notes.json`（0600），接口 `/api/local/revision-notes`。读不了文件时拒绝写入，避免覆盖。测试 `test/revision-store.test.ts`、`test/agent-request.test.ts`。
- **添加任务：** 校外任务（不选课程）也可以；存在原来的 `coursework.local-planning.work.v1`。
- **每周计划（#237，PR #246）：** `shared/planning.ts` 截止最早先排，从今天往后、按每天可用时间拆分到多天，按整分钟、最多排一年；排不下和已过截止列进「需要你处理」；周视图和月历显示同步来的截止日期（含你的修正）；任务可记已用时间和完成。测试 `test/planning.test.ts`。
- **清理（#239）：** 删了 6 份过时文档和约 130 条死 CSS 规则（13 个页面状态 × 6 种主题和背景组合，逐元素对比新旧计算样式，0 差异；同步弹窗和选课弹窗没测，因为打开会触发真实同步）；README、overview、scripts/README、OpenSpec 项目背景按代码重写；品牌名改为 StudyOrbit。
- **课程 JSON v2 第 3 部分（待合并）：** 同步保存前核对权重和规则的引文（`scripts/lib/course-quotes.mjs`，在 `settleCourse` 里），找不到出处就清空、记入 `unsourced`、原因追加「N 项权重或规则无出处」；`shared/local-keys.ts` 的 `migrateLocalKeys` 在页面读取课程时把修正、手动考核归属、学习任务和排序迁到新 ID（`web/src/local-stores.ts`）；课程页在列表、权重图例、抽屉、复习页显示「无出处」，修正填了值就不显示；对话上下文写「权重无出处」「规则无出处」；评测按 ID → 平台身份 → 名称 slug 配对。`npm run check` 24 个文件、302 个测试通过；无头浏览器（临时配置、拦截所有非 GET 本地请求）看了 4 门真实 v1 课程（无标记、正常显示），并用拦截课程接口返回的合成课程验证 v1 → v2 后本地键迁移、标记和引文显示、重复加载不再改动。
- **修正存进 `.local/`（第 1 部分，待合并）：** `shared/corrections.ts`（Schema、`assessmentFields`、`sameValue`、`normaliseCorrections`、`applyOwnerEdit`、导入时的孤立/悬空冲突）；`scripts/lib/corrections-store.mjs`（每课一个 0600 文件、按课串行、原子写、读不了的文件绝不覆盖、导入只在没有文件时创建）和它的请求处理，挂在 `vite.config.ts`；页面每次加载先跑 v2 键迁移，再逐课导入 localStorage 数据（标记 `coursework.corrections-migrated.v1`），之后已迁移课程的修正、手动考核、排序都读写本地服务，带 revision，409 时刷新并提示；单项表单状态默认取有效状态，父项表单日期默认取墨尔本日期。回滚注意：迁移后在页面上做的修正只在 `.local/corrections/`，回退代码后要重新录入。
- **修正与同步三方合并（第 2 部分，待合并）：** `shared/corrections.ts` 的 `mergeCorrections`（只同步改 → 用同步值；只你改 → 保留；改成一样 → 保留并钉住；都改且不同 → 用你的并记冲突；同步删掉的考核 → 修正保留并提孤立冲突）和 `resolveConflict`；`scripts/lib/corrections-store.mjs` 读取时发现课程文件变了就先按 `legacyIds` 改键（钉住和冲突跟着走）再合并、推进基准；保存、导入、处理冲突前都先合并；新接口 `POST /api/local/corrections/<courseId>/conflicts/<conflictId>`；课程页顶部「同步冲突」块、抽屉「冲突」标记、周页「需要你处理」每课一行；同时修了 `legacyIds` 配不上 v1 分组纯数字 ID 的缺口（#385）。无头 Chrome 在临时项目副本（合成课程、临时 HOME）里走了三次重新同步和全部按钮，没碰真实数据。
- **变更记录和提醒（第 3 部分，待合并）：** `shared/course-changes.ts` 的 `diffSnapshots` 按稳定 ID（旧 ID 经 `legacyIds`）比较上一份和新课程文件，只记截止时间和权重，不记分数、新增和删除；同步脚本保存课程文件后经 `scripts/lib/course-changes-log.mjs` 追加到 `.local/lms/changes.jsonl`（第一次同步不记，写入失败只在原因后加「变更记录写入失败。」）；`GET /api/local/course-changes` 返回最新 200 条；周页「需要你处理」每条一行、标题旁「知道了」，课程页顶部「课程变更」块（只有不会连带隐藏别的课的提醒时才给「知道了」）；已读标记 `coursework.course-changes-seen.v1` 在 localStorage。无头 Chrome 在临时项目副本（两门合成课程、临时 HOME）里验证了显示、两处「知道了」、刷新后不再显示、之后的新变更重新出现、390 px 宽度，没跑真实同步。
- **v2 评测（PR #268 待审查，分支 `claude/eval-v2`）：** 照基线重跑 4 门课 × 5 次（`deepseek-flash`），基线和 v2 都用最终打分代码 `--rescore` 重新打分，前后对比在 `docs/eval-results.md`「v2 之后」（合计字段准确率 83.9% → 87.0%，只有 COMP20003 变高）；评测脚本新增「无出处」计数（20 次运行全是 0）、`--rescore`，配对补上 Canvas 作业分组（决定 #370–#374）。
- **同步存储（`local-server-sync-pipeline` 第 2 部分，PR #272 已合并）：** `scripts/lib/sync-store.mjs`（`node:sqlite`，`.local/studyorbit.db` 0600、WAL、按 `user_version` 迁移、升级前备份、不可用的文件绝不改写、启动标记中断、按续跑链保留 50 条）和 `scripts/lib/server-lock.mjs`（单实例锁）；`engines.node` ≥ 24.15.0；还没接进服务和同步（等第 1、3 部分），决定 #405–#409。
- **独立本地服务（`local-server-sync-pipeline` 第 1 部分，分支 `claude/local-server`，PR #275 已合并，决定 #415–#424；#278 修了信号处理装得太晚导致的偶发测试失败）：** 所有 `/api/local/*` 从 `vite.config.ts` 搬到 `server/`（`app.ts` 路由表、`routes/` 每个路由一个文件、`guard.ts` 回环 → 令牌 → Host → Origin、`proxy.ts`、`main.ts` 接上单实例锁和数据库，不可用时同步接口 503）；`scripts/dev.mjs` 每次启动生成令牌，先起服务再起 Vite；顺手修了课程发现「取消」从来没生效的问题（#420）。测试：`server-guard`、`local-server`（每个路由）、`server-main`（子进程：令牌、锁、端口被占、坏数据库、信号）、`local-proxy`（真 Vite：令牌替换、Host、SSE 不缓冲、中断传到上游）、`dev-launcher`、`vite-config`。真实数据只读浏览器检查（5181/5191 端口）通过。
- **分阶段同步（`local-server-sync-pipeline` 第 3 部分，分支 `claude/staged-sync`，PR #277 已合并，决定 #425–#434）：** `scripts/lib/sync-stages.mjs`（采集 → 分析 → 校验 → 合并，输入哈希、检查点、按来源复用、先记录再写的合并、按续跑链去重的变更记录）、`scripts/lib/sync-pipeline.mjs`（任务存数据库、续跑、取消与中断、模拟崩溃、用量记录照旧）、`scripts/lib/rate-limit.mjs`（采集一次一个、每家模型 4 个、最多 3 次、`Retry-After`、2 分钟上限）；模型结果带 `httpStatus`，采集器临时失败退出码 75；新接口 `GET /api/local/sync-jobs`、`POST /api/local/sync-jobs/<jobId>/resume`；页面「已中断」「继续上次同步」「沿用上次结果」；`scripts/course-sync-runner.mjs` 已删。每个阶段边界一个故障注入测试（`test/sync-faults.test.ts`），续跑与重来的假模型 token 用 `npx vitest run test/sync-faults.test.ts --silent=false` 打印。
- **续跑与重来的测量（第 4 部分，分支 `claude/pipeline-measurements`，PR #279 待审查合并，决定 #435–#437）：** 没写单独脚本，`test/sync-faults.test.ts` 打印每个边界的假 token、调用次数和耗时；`docs/sync-optimization.md` 新增「续跑和重来（假模型、合成数据，不是真实运行）」一节：每个边界「失败 + 续跑」都等于不中断（13,885 假 token、12 次采集 / 5 次模型），「失败 + 重来」多花 2,949（采集 → 分析）或 5,898（之后三个边界）；按 2026-10-28 真实数字估算的节省单独标为估算。`docs/overview.md` 补了阶段、数据库、续跑、工具对话和 MCP；两个 change 已归档。
- **通用化第 1 部分（`generic-adapters`，分支 `claude/generic-adapters-1`，PR #280 待合并，决定 #450–#456）：** 先录墨大金标准（`test/golden/`，四个采集器用测试预加载模块在子进程里对假响应真跑），再把采集器搬到接口后面：`scripts/sources/`（Canvas、Ed、注册表、`STUDYORBIT_SOURCE_CONFIG`）、`scripts/institutions/unimelb/`（课程代码、学期、文件夹、措辞、Handbook 来源）、`scripts/browser/`（`withPage`、Edge 的 AppleScript 桥，只能开允许的 origin、只有固定读取表达式）；旧脚本路径保留为转发；分阶段同步不再写死三个来源，任务的来源列表存进数据库（第 2 步迁移）。金标准逐字节不变。
- **通用化第 2 部分（macOS Chrome，分支 `claude/generic-adapters-2`，PR #281 依赖 #280，决定 #457–#459）：** `chrome-applescript` 用和 Edge 相同的脚本；两个桥开标签页前都先查浏览器是否已打开（不替你启动，Edge 也一样，这是有意改动）；临时开关 `STUDYORBIT_BROWSER=chrome-applescript`（第 3 部分加设置后删）；Apple Events 提示按浏览器给；README 写了 Chrome 准备步骤并标「未实测」。
- **验证（较早）：** `npm run check` 13 个文件、89 个测试通过；两份 PR 都经新上下文子代理两轮审查；无头浏览器用合成任务验证了桌面和 390 px 手机宽度。

## 未验证

- 通用化第 2 部分：没有用真实 Chrome 跑过（只核对过 `sdef` 和用假 osascript 测脚本）；「是否已打开」检查也没在真实 Edge 上跑过；Chrome 中文菜单名「显示 → 开发者」没在界面上核对。
- 通用化第 1 部分：没有跑过真实采集器（Edge、Canvas、Ed、Handbook 都没碰），采集器只在假 osascript / 假 edstem / 假 fetch 上跑过；数据库第 2 步迁移只在测试库上跑过，第一次启动服务时会先备份 `.local/studyorbit.db.v1.bak` 再迁移。

- 续跑与重来：只用假模型和合成数据测过，没有真实测量；按真实数字的节省只是估算。
- 分阶段同步：没有跑过真实同步、真实采集器或真实模型；采集器退出码 75 只测了判断函数（Handbook 的 `responseStatus` 读取和 Ed 命令的报错格式都是推断）；Codex 子代理用量在续跑时没验证；浏览器只用假接口验证了续跑按钮。

- 本地服务：对话经代理的流式回复和中途停止只在测试里用假模型验证过（浏览器检查只读，没发消息）；`vite --host` 暴露到局域网时的 403 只有单元测试；Windows 没测。
- 预设提示词发出后的真实模型回复、真实回复「存到复习」（测试里拦截了对话请求，没花额度）。
- 「7 天内截止但没排期」这一行在真实数据上没出现过（当前 7 天里没有符合条件的考核）。
- 四家模型真实调用、真实同步、Safari / Firefox（同上一次交接）。
- 契约 v2 没跑过真实同步：真实 Handbook / Ed 文本下有多少权重会被标「无出处」未知（模型改写而非逐字复制时会大量清空，见 design 风险一节）；真实 v1 → v2 迁移只在合成数据上验证过。

- 变更记录没有经过真实同步：同步脚本里那一行调用只靠库函数测试和合成数据浏览器检查；第一次真实 v1 → v2 同步可能一次出现较多变更行。
- 三方合并和冲突处理只在合成课程上验证过；真实课程重新同步后的冲突数量未知（第一次 v1 → v2 同步可能一次出现较多）。
- MCP 只用 SDK 客户端在本机真实数据上跑过冒烟测试（只看数量，#404）；从 Claude Code / Claude Desktop 实际连接没做过。
- 修正迁移只用合成数据在一门真实课程 ID 上验证过（无头 Chrome、全新配置目录，验证后已删掉生成的文件）；你自己浏览器里的真实迁移没跑过（目前没有修正，迁移不会做任何事）。

## 下一步

0. 审查并合并 PR #279（`local-server-sync-pipeline` 第 4 个 PR，测量文档 + 两个 change 归档）。新路由一律写进 `server/routes/`。是否授权一次真实续跑测量（决定 #350，约多花两次四门课分析）由你定。
1. 你：第一次真实同步后看一眼「同步数据」面板和 `.local/studyorbit.db` 是否正常；如果同步被中断，试一次「继续上次同步」。分阶段同步还没跑过真实采集和真实模型。
2. 你：第一次 v2 同步后看一眼各课的「无出处」数量；太多的话再调提示词（评测可以量清空率）。
   - 评测里 20 次运行「无出处」都是 0。
   - 决定 #372 记下的 `legacyIds` 分组缺口已在第 2 部分修好（#385），spec 已改。
3. 你：打开 `localhost:5173`，在复习页点一个预设按钮，确认对话正常，把一条回复「存到复习」。
4. L0/L1/L2（#238 先不做）：以后做时先定方案；Claude 的立场是执行器只在合成演示课程上跑。
5. 小问题（未排期）：`RichText` 遇到「标题 + 列表」混在一段时列表符号原样显示。
6. 工具调用对话 + MCP：OpenSpec 变更 `chat-tools-mcp`（决定 #320–#339、#360–#369、#395–#404，待你复核）。第 1、2 个 PR 已合并（#264、#267）；第 3 个 PR #273（问答评测）已合并：32 道合成题 × 5 次 × 2 种模式，`deepseek-flash` 上下文模式 → 工具模式的准确率见 `docs/eval-results.md`「对话问答：改造前后」，上下文模式的错是缺计划数据或剩余权重口径不同，不是算术错；同一 PR 修了 DeepSeek 并行工具调用的回传顺序（#396，#267 的实测没覆盖到，第二步会 400）。MCP（第 4 个，PR #270，决定 #400–#404）已合并，整个 change 已归档（从 Claude Code 实际连接仍未验证）：`scripts/mcp-server.mjs` + `scripts/lib/course-mcp.mjs`，SDK 1.32.2，README 有 Claude Code / Claude Desktop 接法；#330 需要你定是否改用 SDK v2。
7. 通用化：OpenSpec 变更 `generic-adapters`（决定 #440–#456，待你复核）。第 1 个 PR #280（接口和搬家）和第 2 个 PR #281（macOS Chrome，基于第 1 个，#280 合并后把 #281 的目标分支改回 `main`）待 CI 通过后依次合并；之后是设置 + 通用学校 + 通用 Canvas、Windows/Linux 的 CDP 桥（实验性）。
   - 你：#280 合并后跑一次「获取课程」，确认 Edge 采集照旧（#281 合并后 Edge 没打开时会直接报「请先打开 Microsoft Edge 并登录」）。
   - 你：#281 合并后在 Chrome 里打开「显示 → 开发者 → 允许 Apple 事件中的 JavaScript」，用 `STUDYORBIT_BROWSER=chrome-applescript npm run dev` 启动，跑一次「获取课程」；第一次会弹出允许控制「Google Chrome」的系统询问。

## 等用户决定

- 对话是否要包含页面上的修正（现在只用同步原件）。
- 通用化：Windows 用 CDP 专用配置（#446）还是改回 #219–#221 的浏览器扩展；成绩等级是否也按学校区分。

## 运行与验证

- `npm ci`；`npm run check`；`npm run dev`（页面端口 5173，你的浏览器数据在这个端口，不要换；本地接口 `127.0.0.1:5190`）。第二套开发服务器用 `STUDYORBIT_WEB_PORT=5181 STUDYORBIT_API_PORT=5191 npm run dev`，不要用 `--port`。
- **不要随手点「立即同步」或保存选课**：会真用 Edge、Ed 和模型额度。复习页的预设按钮也会发消息、用额度。
- 截图验证用独立临时浏览器（taste-skill `scripts/lib/cdp.mjs`），写入 `coursework.canonical-reset-v1=done` 和 `coursework.selected-course-ids`；要验证对话入口时拦截 `/api/local/chats` 的 POST。

## 陷阱

- 仓库公开：个人成绩、Cookie、密钥、本机路径不能入库。推送前扫「数字/数字」分数写法。
- git worktree 里给 `node_modules`、`.local` 建符号链接时，`.gitignore` 的目录规则不匹配链接，提交只按文件名暂存。
- 本机 shell 设了 `NODE_DEBUG=http,...`，跑测试和服务器时用 `NODE_DEBUG=`。
- `sync-usage` 靠 `.local/lms/runs/*` 目录创建时间：移动数据用 `mv`，不要 `cp`。
- 5174 端口被本机别的进程占用，第二个开发服务器用别的端口。
- 直接跑 `vite` / `npx vite` 会报「请用 npm run dev 启动（需要本地接口服务）」：没有令牌就没有接口。同一项目只能跑一个本地服务（`.local/server.lock`）。
- 规则以 `CLAUDE.md` 为准（#241）：Claude 开发并合并；大改动先写 OpenSpec；逻辑用 TDD；合并前新上下文审查；只有设计选择先问用户。
- 下一阶段任务清单在用户桌面「StudyOrbit待办」，做完一条勾一条。
