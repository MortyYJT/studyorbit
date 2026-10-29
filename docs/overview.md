# 项目结构与数据流

更新：2026-10-29。StudyOrbit 是本地原型：Vite 开发服务器同时提供 React 页面和只接受本机同源请求的本地接口（`vite.config.ts`）。静态构建不含这些接口。

## 主流程

1. **发现课程：** `POST /api/local/sync-courses` 启动 `scripts/canvas-background.mjs discover`，在已登录的 Edge 里读取 Canvas 课程；`scripts/lib/course-list.mjs` 按课程代码筛出候选，存 `.local/lms/courses.json`。
2. **选课并同步：** `web/src/LocalCourseSelect.tsx` 把选择存进浏览器，调用 `POST /api/local/course-sync`（GET 查进度，DELETE 取消）。`scripts/course-sync-runner.mjs` 对每门课依次采集 Canvas、Ed、Handbook；采集串行，已采集课程的模型分析可与后续采集并行。
3. **模型整理：** `scripts/lib/course-analysis.mjs` 生成统一提示词和输出 Schema，`scripts/lib/llm-providers.mjs` 调用设置里选的模型（DeepSeek、OpenAI 兼容、Anthropic、Codex CLI）。结果经 `shared/course-data.ts` 校验，不合格时修复一次，合格的 JSON 存到桌面课程文件夹。
4. **展示与修正：** `GET /api/local/course-reports` 读每门课最新的有效 JSON；`web/src/LocalPlanning.tsx` 展示课程页和周视图。你的修正、新增、排序和隐藏只存在浏览器里，不改同步原件。
5. **计算：** 成绩与「期末需要」在 `shared/course-calculations.ts`，每周排期在 `shared/planning.ts`，都是纯函数，有单元测试。
6. **对话与复习：** `web/src/Agent.tsx` 通过 `/api/local/chats*` 流式对话，上下文是已选课程的同步数据（`scripts/lib/chat-context.mjs`，不含页面修正）。复习页可发预设提示词，把回复「存到复习」（`/api/local/revision-notes`）。

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
| `scripts/course-sync-runner.mjs` | 编排、模型调用、校验、取消、保存和用量 |
| `scripts/lib/` | 模型设置与适配器、对话存储与上下文、复习笔记存储、课程读取 |
| `shared/` | 课程 JSON 契约、成绩计算、排期 |
| `test/` | vitest 单元测试（只用合成数据） |

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 课程候选、采集快照、同步记录与用量 | `.local/lms/` |
| 模型设置（权限 600，密钥只写） | `.local/config/llm.json` |
| 对话、复习笔记 | `.local/chat/`、`.local/revision/notes.json` |
| 每门课的课程 JSON | `~/Desktop/墨尔本大学 <年份> S<学期>/<课程代码>/分数结构*.json`（新文件不覆盖旧文件，读最新的有效文件） |
| 选课、修正、任务、可用时间、目标档、外观 | 浏览器 localStorage（按浏览器和端口隔离，键名沿用 `coursework.` 前缀以保留已有数据） |
| 背景图片 | 浏览器 IndexedDB `coursework` |

`.local/` 和 `.local-backups/` 被 Git 忽略，但含个人数据。

## 当前边界

Node.js 24+；只在 macOS + Edge 上实际跑过，其他平台和浏览器未完成。`edstem` 和模型密钥属于外部依赖。Vite 重启会丢失内存中的同步状态。四家模型的真实调用和真实同步在 v2 并入后还没有重新验证。
