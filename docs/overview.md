# 项目结构与数据流

更新：2026-10-30。StudyOrbit 是本地原型，`npm run dev` 启动两个进程：本地接口服务（`server/`）和提供 React 页面的 Vite 开发服务器。静态构建不含本地接口。

## 进程、端口和令牌

| 进程 | 地址 | 说明 |
| --- | --- | --- |
| 本地接口服务（`node server/main.ts`，`npm run server`） | `http://127.0.0.1:5190`（`STUDYORBIT_API_PORT`） | 提供全部 `/api/local/*`；只绑 `127.0.0.1`；端口被占就报错退出，不换端口 |
| Vite 开发服务器（`npm run dev:web`） | `http://localhost:5173`（`STUDYORBIT_WEB_PORT`，严格端口） | 只提供页面，把 `/api/local` 代理到本地接口服务 |

- **启动：** `scripts/dev.mjs` 每次启动生成一个随机 32 字节令牌，经环境变量 `STUDYORBIT_API_TOKEN` 交给两个进程（不写盘、不打印、不进前端代码）；先启动接口服务，看到 `StudyOrbit local API listening on …` 这一行再启动 Vite（15 秒没看到或服务先退出就整体退出）；Ctrl-C 转发给两个进程，一个退出就停掉另一个。附加参数传给 Vite（`npm run dev -- --open`）；改页面端口用 `STUDYORBIT_WEB_PORT`，不要用 `--port`（接口只认页面自己的端口）。
- **访问检查**（`server/guard.ts`，依次，失败一律 403 空响应）：对端是本机回环；请求头 `x-studyorbit-token` 等于本次令牌（定长比较）；`Host` 只能是 `localhost` / `127.0.0.1` / `[::1]` 加页面端口（防 DNS 重绑定）；有 `Origin` 时必须等于 `http://<Host>`。各路由原有的写操作要求（同源 `Origin` 加 `Content-Type: application/json`）不变。
- **代理**（`server/proxy.ts`）：不改 `Host`，在服务端加上令牌并覆盖浏览器自带的值；浏览器不是本机回环地址就直接 403、不转发；SSE 不缓冲，浏览器中断时上游请求随之关闭。直接 `vite`（`npm run dev:web`）没有令牌会拒绝启动；`vite preview` 没有代理，`/api/local` 返回 404。
- **单实例：** 服务启动时取得 `.local/server.lock`（`scripts/lib/server-lock.mjs`），同一项目已有服务在运行就退出并提示「另一个 StudyOrbit 本地服务正在运行」，退出时删除；随后打开 `.local/studyorbit.db`（`scripts/lib/sync-store.mjs`），数据库不可用时同步接口返回 `503 SYNC_STORE_UNAVAILABLE`，其他接口照常。

## 主流程

0. **数据来源设置：** `GET`/`PUT /api/local/source-settings`（`server/routes/source-settings.ts`、`scripts/lib/source-settings.mjs`）读写 `.local/config/sources.json`：学校（`unimelb` 或 `generic`）、Canvas 地址、浏览器、浏览器路径、Ed 区域，以及只给 `generic` 的时区和课程代码正则。没有文件时等于墨大 + macOS Edge（其他系统默认 Chrome 专用浏览器，实验性）。同步或获取课程进行中保存回 `409 SYNC_RUNNING`。每次同步和每次获取课程各读一次，换成采集器配置（环境变量 `STUDYORBIT_SOURCE_CONFIG`，不含凭据）传给采集子进程；采集器自己不读设置文件。
1. **发现课程：** `POST /api/local/sync-courses` 启动 Canvas 来源的发现采集器（`scripts/sources/canvas/collect.mjs discover`），在已登录的浏览器里读取全部 Canvas 课程，存 `.local/lms/courses.json`，并记下 `canvasOrigin` 和学校；读取时（`/api/local/course-candidates`、`scripts/lib/course-reports.mjs`）再按当前学校插件的课程代码规则筛出候选。课程列表的 Canvas 地址和设置不一致时（没有这个字段的旧列表按墨大地址算），同步、课程页和选课都回 `409 COURSE_LIST_STALE`（两个 Canvas 的课程 ID 可能撞号）。
2. **选课并同步：** `web/src/LocalCourseSelect.tsx` 把选择存进浏览器，调用 `POST /api/local/course-sync`（GET 查进度，DELETE 取消）。`scripts/lib/sync-pipeline.mjs` 对每门课依次采集当前设置的来源：Canvas、Ed，再加学校的框架来源（墨大是 Handbook，通用学校没有）；采集串行，已采集课程的模型分析可与后续采集并行。每门课分四步：采集 → 分析 → 校验 → 合并（`scripts/lib/sync-stages.mjs`），每步完成后把检查点写进 `.local/studyorbit.db`（`scripts/lib/sync-store.mjs`，`node:sqlite`）。失败、取消或服务退出（标为「已中断」）的同步，可以在第一次开始后 24 小时内用 `POST /api/local/sync-jobs/<jobId>/resume`（页面上「继续上次同步」）继续：检查点和文件核对无误的步骤直接沿用，不再采集或调模型。采集一门课接一门课地跑（Canvas 和 Handbook 共用一个浏览器限速器，Ed 单独一个，同一个限速器两次开始至少隔 500 毫秒）；模型每家最多 4 个并发；临时失败（模型的 HTTP 429、5xx、连接错误，采集器的退出码 75）最多试 3 次（`scripts/lib/rate-limit.mjs`）。
3. **模型整理：** `scripts/lib/course-analysis.mjs` 生成统一提示词和输出 Schema（来源规则、框架引用和引文规则来自学校插件，没有框架来源时整段省略），`scripts/lib/llm-providers.mjs` 调用设置里选的模型（DeepSeek、OpenAI 兼容、Anthropic、Codex CLI）。结果经 `shared/course-data.ts` 校验，不合格时修复一次，合格的 JSON 存到桌面课程文件夹。
4. **展示与修正：** `GET /api/local/course-reports` 读每门课最新的有效 JSON；`web/src/LocalPlanning.tsx` 展示课程页和周视图。你的修正、新增、排序和隐藏存在 `.local/corrections/<课程 ID>.json`（`/api/local/corrections`，`scripts/lib/corrections-store.mjs`），不改同步原件；同步结果变了时按三方合并保留你的修改，双方都改且不同的显示为「同步冲突」（`shared/corrections.ts`）。浏览器 localStorage 里的旧修正迁移后只作备份。
5. **变更提醒：** 同步保存课程文件后，`scripts/lib/course-changes-log.mjs` 用 `shared/course-changes.ts` 的 `diffSnapshots` 按稳定 ID 和上一份有效文件比较，截止时间或权重变了就追加到 `.local/lms/changes.jsonl`（不记分数，第一次同步不记）；页面经 `GET /api/local/course-changes` 读最新 200 条，在「需要你处理」和课程页顶部提示，点「知道了」后不再显示。
6. **计算：** 成绩与「期末需要」在 `shared/course-calculations.ts`，每周排期在 `shared/planning.ts`，都是纯函数，有单元测试。
7. **对话与复习：** `web/src/Agent.tsx` 通过 `/api/local/chats*` 流式对话。DeepSeek、OpenAI 兼容和 Anthropic 用只读课程工具回答（`shared/course-tools.ts` 的 6 个工具，循环在 `scripts/lib/chat-tool-loop.mjs`；OpenAI 兼容服务第一次请求就拒绝工具时退回整份上下文）；Codex 仍把已选课程的同步数据整份放进上下文（`scripts/lib/chat-context.mjs`）。两种方式都不含页面修正。复习页可发预设提示词；单门课对话里已完成的回复可以「存到复习」（`/api/local/revision-notes`）。

## 采集范围

- **Canvas：** `scripts/sources/canvas/collect.mjs`（旧入口 `canvas-background.mjs`）用已登录浏览器（Edge、Chrome 或专用浏览器，经浏览器桥）的同源请求读取活动课程、作业分组、作业和本人提交，所有地址都是设置里的 Canvas 地址加固定的 Canvas REST 路径，按 Link 分页且只跟同一地址、同一路径。不读大纲、测验、公告或作业正文。
- **Ed：** `scripts/sources/ed/collect.mjs`（旧入口 `collect-ed-course.mjs`）用独立的 `edstem` CLI 读取课程目录、最多 50 个成绩候选和有限的介绍；`scripts/sources/ed/scores.mjs` 读取本人最终提交成绩，接口地址按 CLI 登录的区域（`au`/`us`/`eu`）。设置了明确区域而和 CLI 不一致时不发任何 Ed 请求，这门课的 Ed 记为未读取。接口可能返回 403，不能当作零分。
- **Handbook（只有墨大）：** `scripts/institutions/unimelb/handbook-collect.mjs`（旧入口 `collect-handbook.mjs`）在浏览器后台读取对应年份的考核页面。

- **浏览器桥：** macOS 上用 Apple 事件脚本控制 Edge 或 Chrome（`scripts/browser/applescript.mjs`）。Windows 和 Linux 用专用浏览器（`cdp-chrome`、`cdp-edge`，实验性，未在这两个系统上验证）：本地服务用单独的配置目录 `.local/browser/<浏览器>`（700）和 `--remote-debugging-pipe` 启动已安装的 Chrome 或 Edge（不开调试端口），按需启动、跨采集和跨同步保持，你关窗口、改浏览器设置或服务退出时才关（`Browser.close`，5 秒后强制结束）；`POST /api/local/browser/open`（设置里的「打开专用浏览器」）在其中打开 Canvas 地址让你自己登录。采集子进程经 Node IPC 请服务代为开、查、读、关标签页，服务按采集器的地址白名单检查，只发白名单里的 CDP 命令（`Target.createTarget`/`attachToTarget`/`getTargetInfo`/`closeTarget`、只带固定表达式的 `Runtime.evaluate`、`Browser.close`）；采集器退出时只关它自己的标签页。专用浏览器里登录失效时，Canvas 采集以退出码 77 结束，这一步记为失败（「Canvas：请在专用浏览器里登录后继续同步。」），登录后可以继续上次同步，重新采集这门课。

不下载课程文件，不提交作业。采集范围不保证完整；站点改版需要重新核对。

## 代码入口

| 位置 | 作用 |
| --- | --- |
| `web/src/App.tsx`、`web/src/SourceSettings.tsx` | 外壳、侧边栏、同步弹窗、设置（模型、数据来源、外观、背景） |
| `web/src/LocalPlanning.tsx` | 课程页（成绩、考核、复习）和周视图 / 月历（排期、需要你处理、任务用时） |
| `web/src/Agent.tsx`、`agent-request.ts` | 对话页；其他页面带课程和预设提示词打开新对话 |
| `web/src/palette.ts`、`background.ts`、`BackgroundLayer.tsx`、`motion.ts` | 配色、背景、动画 |
| `server/main.ts`、`server/app.ts`、`server/routes/` | 本地接口服务：启动、访问检查后的路由表、每个 `/api/local/*` 路由一个文件 |
| `server/guard.ts`、`server/proxy.ts` | 访问检查（回环、令牌、Host、Origin）；Vite 的 `/api/local` 代理 |
| `scripts/dev.mjs` | `npm run dev`：生成令牌，先启动接口服务再启动 Vite |
| `vite.config.ts` | 只有页面、端口和代理 |
| `scripts/lib/sync-pipeline.mjs`、`scripts/lib/sync-stages.mjs` | 分阶段编排（采集 → 分析 → 校验 → 合并）、检查点与续跑、模型调用、取消与中断、保存、用量和变更记录 |
| `scripts/lib/sync-store.mjs`、`scripts/lib/rate-limit.mjs`、`scripts/lib/server-lock.mjs` | 同步数据库（任务、阶段检查点、课程快照）、限速与重试、单实例锁 |
| `shared/course-tools.ts`、`scripts/lib/chat-tool-loop.mjs` | 对话用的只读课程工具和工具调用循环 |
| `scripts/institutions/`、`scripts/sources/`、`scripts/browser/` | 学校插件（`unimelb` 放全部墨大特有内容，`generic` 适用任何 Canvas）、采集来源（Canvas、Ed）和浏览器桥；`test/no-institution-literals.test.ts` 保证其他代码里没有墨大字样 |
| `scripts/lib/source-settings.mjs`、`server/routes/source-settings.ts` | 数据来源设置的校验、读写和接口 |
| `scripts/mcp-server.mjs`、`scripts/lib/course-mcp.mjs` | `npm run mcp`：把同一组只读工具经 stdio 提供给 MCP 客户端（如 Claude Code） |
| `scripts/lib/` | 模型设置与适配器、对话存储与上下文、复习笔记存储、课程读取、修正存储、变更记录 |
| `shared/` | 课程 JSON 契约、成绩计算、排期、修正合并、变更比较 |
| `test/` | vitest 单元测试（只用合成数据） |

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 课程候选、采集快照、同步记录与用量 | `.local/lms/` |
| 同步任务、阶段检查点、课程快照（SQLite，权限 600） | `.local/studyorbit.db` |
| 本地服务单实例锁（服务退出时删除） | `.local/server.lock` |
| 截止时间和权重的变更记录（每行 `{ at, runId, courseId, assessmentId, name, field, before, after }`，权限 600，可随时删除） | `.local/lms/changes.jsonl` |
| 修正、手动考核、排序、合并基准和未处理冲突（每门课一个文件，权限 600，目录 700） | `.local/corrections/<课程 ID>.json` |
| 模型设置（权限 600，密钥只写） | `.local/config/llm.json` |
| 数据来源设置（权限 600，目录 700；删掉即回到墨大 + Edge） | `.local/config/sources.json` |
| 对话、复习笔记 | `.local/chat/`、`.local/revision/notes.json` |
| 每门课的课程 JSON | 墨大 `~/Desktop/墨尔本大学 <年份> S<学期>/<课程代码>/分数结构*.json`，其他学校 `~/Desktop/StudyOrbit <学期>/<课程代码>/分数结构*.json`（新文件不覆盖旧文件，读最新的有效文件） |
| 选课、任务、可用时间、目标档、外观、变更已读标记（`coursework.course-changes-seen.v1`）；迁移前的修正（迁移后只作备份） | 浏览器 localStorage（按浏览器和端口隔离，键名沿用 `coursework.` 前缀以保留已有数据） |
| 背景图片 | 浏览器 IndexedDB `coursework` |

`.local/` 和 `.local-backups/` 被 Git 忽略，但含个人数据。

存储只在本机；分析和对话时，课程数据会发给你选择的模型服务商（`scripts/lib/llm-config.mjs` 决定发给谁）。

## 当前边界

Node.js 24+；只在 macOS + Edge + 墨大 Canvas 上实际跑过。macOS Chrome、其他学校的 Canvas、Ed 美区和欧区都只有合成数据测试，未实测；Windows 和 Linux 的专用浏览器（CDP）是实验性的，只有单元测试，没有在这两个系统上跑过。「今天」和截止日期按学校时区计算（墨大是墨尔本时间，通用学校按设置）。`edstem` 和模型密钥属于外部依赖。同步状态存在数据库里，Vite 或本地服务重启不会丢；服务退出时正在跑的同步标为「已中断」，可以继续。分阶段同步还没有跑过真实同步（只用假采集器和假模型测过）；对话工具模式只用 DeepSeek 实测过 3 次请求，其他模型的真实调用在 v2 并入后还没有重新验证；MCP 没有从 Claude Code / Claude Desktop 实际连接过。
