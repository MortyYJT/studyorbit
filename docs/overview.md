# 项目结构与数据流

更新：2026-10-29。当前项目是本地原型，开发服务同时提供 React 页面和本地 API。

## 主流程

1. `web/src/App.tsx` 调用 `POST /api/local/sync-courses`；`vite.config.ts` 启动 `scripts/canvas-background.mjs discover` 获取课程，`scripts/lib/course-list.mjs` 按 Canvas 课程代码筛选候选。
2. `web/src/LocalCourseSelect.tsx` 将选择保存在浏览器 localStorage，调用 `POST /api/local/course-sync`；取消使用 DELETE，GET 读取当前进度。
3. `scripts/course-sync-runner.mjs` 对课程依次启动 Canvas、Ed、Handbook 采集。浏览器采集串行；已采集课程的模型分析可以与后续课程采集并行。来源缺失时保留状态，并不自动视为零分。
4. `scripts/lib/course-analysis.mjs` 根据统一提示词和 `shared/course-data.ts` 输出 Schema 生成模型输入。默认 DeepSeek Responses API 原生 JSON Schema；支持 `codex` 和 `openai-compatible` 适配。代码进行关系、计分与部分 Ed 分数一致性检查；校验失败最多修复一次，保存诊断。
5. 合格的课程 JSON 保存到桌面课程文件夹，`GET /api/local/course-reports` 读取对应课程最新有效文件；`web/src/LocalPlanning.tsx` 展示、允许用户编辑/新增，并使用 `shared/course-calculations.ts` 计算成绩。用户覆盖与学习任务保存在浏览器 localStorage。

## 采集范围

- **Canvas**：`scripts/canvas-background.mjs` 使用已登录 Edge 同源请求读取活动课程、作业分组、作业及本人 submission，按 Link 分页。没有单独读取大纲、测验、公告或作业正文。
- **Ed**：`scripts/collect-ed-course.mjs` 使用独立的 `edstem` CLI 认证读取课程目录，筛选最多 50 个成绩候选，并有限读取课程 / workshop 介绍；`scripts/edstem-scores.mjs` 读取本人最终提交成绩。接口可能返回 403，不能解释成零分。
- **Handbook**：`scripts/collect-handbook.mjs` 读取对应年份考核页面文本；模型判断对应学期和考核框架。

不下载课程文件，不提交作业，也不读取作业正文、附件、代码或图片。无 Ed 课程不必然是同步失败。采集范围不保证完整；站点页面或接口变化需要重新核对。

## 代码入口

| 位置 | 作用 |
| --- | --- |
| `web/src/main.tsx`、`App.tsx` | 页面入口、同步弹窗、设置、头像和用量 |
| `web/src/LocalPlanning.tsx` | 本地课程页、用户编辑和日历；文件较大，是后续拆分候选 |
| `vite.config.ts` | Vite 与 `/api/local/*` 接口；同步不是独立生产服务 |
| `scripts/course-sync-runner.mjs` | 编排、模型调用、验证、取消、保存和用量 |
| `scripts/lib/course-analysis.mjs` | 模型无关的提示词与原生输出 Schema |
| `shared/course-data.ts`、`course-calculations.ts` | 课程契约与确定性分数计算 |
| `test/` | vitest 单元测试（只用合成数据） |

## 数据位置

- `.local/lms/courses.json`：本机课程候选；`.local/lms/runs/<批次>/<课程ID>/`：采集快照；`.local/lms/sync-errors/`：校验失败输出；`.local/lms/course-sync-usage.jsonl`：用量。
- `~/Desktop/墨尔本大学 <年份> S<学期>/<课程代码>/分数结构*.json`：模型输出。新文件不覆盖旧文件；页面按修改时间选最新有效 JSON。
- 浏览器 localStorage：课程选择、考核修正和手动项、学习任务、头像及界面偏好。按浏览器和端口隔离；首次迁移备份行为见 [迁移说明](migration.md)。
- `.local/` 与 `.local-backups/` 均忽略于 Git，但可能含个人数据；桌面课程文件和浏览器数据也不在 Git 中。交接前应由用户自行决定备份和传递方式。

## 当前边界

Node.js 24+；macOS + Edge 已实际试跑，其他平台 / 浏览器未完成。`edstem` 和模型密钥属于外部依赖，不随仓库提供。Vite 重启会丢失内存中的运行状态，运行中不要修改服务端文件。同步批次耗时从保存选课后开始；旧批次只在可用目录元数据唯一匹配时还原，总耗时为估算。
