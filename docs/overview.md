# 项目结构与数据流

更新：2026-10-30。StudyOrbit 是本地原型：Vite 开发服务器同时提供 React 页面和只接受本机同源请求的本地接口（`vite.config.ts`）。静态构建不含这些接口。

## 主流程

1. **发现课程：** `POST /api/local/sync-courses` 启动 `scripts/canvas-background.mjs discover`，在已登录的 Edge 里读取全部 Canvas 课程，存 `.local/lms/courses.json`；读取时（`/api/local/course-candidates`、`scripts/lib/course-reports.mjs`）再由 `scripts/lib/course-list.mjs` 按课程代码筛出候选。
2. **选课并同步：** `web/src/LocalCourseSelect.tsx` 把选择存进浏览器，调用 `POST /api/local/course-sync`（GET 查进度，DELETE 取消）。`scripts/course-sync-runner.mjs` 对每门课依次采集 Canvas、Ed、Handbook；采集串行，已采集课程的模型分析可与后续采集并行。
3. **模型整理：** `scripts/lib/course-analysis.mjs` 生成统一提示词和输出 Schema，`scripts/lib/llm-providers.mjs` 调用设置里选的模型（DeepSeek、OpenAI 兼容、Anthropic、Codex CLI）。结果经 `shared/course-data.ts` 校验，不合格时修复一次，合格的 JSON 存到桌面课程文件夹。
4. **展示与修正：** `GET /api/local/course-reports` 读每门课最新的有效 JSON；`web/src/LocalPlanning.tsx` 展示课程页和周视图。你的修正、新增、排序和隐藏存在 `.local/corrections/<课程 ID>.json`（`/api/local/corrections`，`scripts/lib/corrections-store.mjs`），不改同步原件；同步结果变了时按三方合并保留你的修改，双方都改且不同的显示为「同步冲突」（`shared/corrections.ts`）。浏览器 localStorage 里的旧修正迁移后只作备份。
5. **变更提醒：** 同步保存课程文件后，`scripts/lib/course-changes-log.mjs` 用 `shared/course-changes.ts` 的 `diffSnapshots` 按稳定 ID 和上一份有效文件比较，截止时间或权重变了就追加到 `.local/lms/changes.jsonl`（不记分数，第一次同步不记）；页面经 `GET /api/local/course-changes` 读最新 200 条，在「需要你处理」和课程页顶部提示，点「知道了」后不再显示。
6. **计算：** 成绩与「期末需要」在 `shared/course-calculations.ts`，每周排期在 `shared/planning.ts`，都是纯函数，有单元测试。
7. **对话与复习：** `web/src/Agent.tsx` 通过 `/api/local/chats*` 流式对话，上下文是已选课程的同步数据（`scripts/lib/chat-context.mjs`，不含页面修正）。复习页可发预设提示词；单门课对话里已完成的回复可以「存到复习」（`/api/local/revision-notes`）。

## 采集范围

- **Canvas：** `scripts/canvas-background.mjs` 用已登录 Edge 的同源请求读取活动课程、作业分组、作业和本人提交，按 Link 分页。不读大纲、测验、公告或作业正文。
- **Ed：** `scripts/collect-ed-course.mjs` 用独立的 `edstem` CLI 读取课程目录、最多 50 个成绩候选和有限的介绍；`scripts/edstem-scores.mjs` 读取本人最终提交成绩。接口可能返回 403，不能当作零分。
- **Handbook：** `scripts/collect-handbook.mjs` 在 Edge 后台读取对应年份的考核页面。

不下载课程文件，不提交作业。采集范围不保证完整；站点改版需要重新核对。

## 代码入口

| 位置 | 作用 |
| --- | --- |
| `web/src/App.tsx` | 外壳、侧边栏、同步弹窗、设置（模型、外观、背景） |
| `web/src/LocalPlanning.tsx` | 课程页（成绩、考核、复习）和周视图 / 月历（排期、需要你处理、任务用时） |
| `web/src/Agent.tsx`、`agent-request.ts` | 对话页；其他页面带课程和预设提示词打开新对话 |
| `web/src/palette.ts`、`background.ts`、`BackgroundLayer.tsx`、`motion.ts` | 配色、背景、动画 |
| `vite.config.ts` | 本地接口；所有 `/api/local/*` 拒绝其他来源（`scripts/lib/local-origin.mjs`） |
| `scripts/course-sync-runner.mjs` | 编排、模型调用、校验、取消、保存、用量和变更记录 |
| `scripts/lib/` | 模型设置与适配器、对话存储与上下文、复习笔记存储、课程读取、修正存储、变更记录 |
| `shared/` | 课程 JSON 契约、成绩计算、排期、修正合并、变更比较 |
| `test/` | vitest 单元测试（只用合成数据） |

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 课程候选、采集快照、同步记录与用量 | `.local/lms/` |
| 截止时间和权重的变更记录（每行 `{ at, runId, courseId, assessmentId, name, field, before, after }`，权限 600，可随时删除） | `.local/lms/changes.jsonl` |
| 修正、手动考核、排序、合并基准和未处理冲突（每门课一个文件，权限 600，目录 700） | `.local/corrections/<课程 ID>.json` |
| 模型设置（权限 600，密钥只写） | `.local/config/llm.json` |
| 对话、复习笔记 | `.local/chat/`、`.local/revision/notes.json` |
| 每门课的课程 JSON | `~/Desktop/墨尔本大学 <年份> S<学期>/<课程代码>/分数结构*.json`（新文件不覆盖旧文件，读最新的有效文件） |
| 选课、任务、可用时间、目标档、外观、变更已读标记（`coursework.course-changes-seen.v1`）；迁移前的修正（迁移后只作备份） | 浏览器 localStorage（按浏览器和端口隔离，键名沿用 `coursework.` 前缀以保留已有数据） |
| 背景图片 | 浏览器 IndexedDB `coursework` |

`.local/` 和 `.local-backups/` 被 Git 忽略，但含个人数据。

存储只在本机；分析和对话时，课程数据会发给你选择的模型服务商（`scripts/lib/llm-config.mjs` 决定发给谁）。

## 当前边界

Node.js 24+；只在 macOS + Edge 上实际跑过，其他平台和浏览器未完成。`edstem` 和模型密钥属于外部依赖。Vite 重启会丢失内存中的同步状态。四家模型的真实调用和真实同步在 v2 并入后还没有重新验证。
