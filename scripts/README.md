# 脚本

运行入口是 `npm run dev`（`dev.mjs`：本地接口服务加页面）和 `npm run sync:courses`（只采集课程列表）。权限、登录和数据位置见 [项目 README](../README.md) 与 [项目结构和数据流](../docs/overview.md)。

| 脚本 | 用途 |
| --- | --- |
| `dev.mjs` | `npm run dev` 的启动脚本：生成本次令牌，先启动 `server/main.ts`（端口 5190），看到监听行再启动 Vite（端口 5173），转发 Ctrl-C，一个退出就停另一个 |
| `canvas-background.mjs` | 在已登录的 Edge 里读取 Canvas 课程，或单课的作业分组、作业和本人提交；按 Link 分页 |
| `collect-ed-course.mjs` | 通过 `edstem` CLI 获取 Ed 目录、部分成绩和选定介绍 |
| `edstem-scores.mjs` | 只读获取本人最终提交成绩，供 Ed 采集器使用 |
| `collect-handbook.mjs` | 在 Edge 后台读取对应年份的 Handbook 考核页 |
| `eval-course-analysis.mjs` | 用已采集的数据或合成课程跑 N 次分析，与标准答案对比，统计准确率、一致性和校验拦截；不采集、不写桌面（[说明](../docs/eval-format.md)） |
| `mcp-server.mjs` | 本机 stdio MCP 服务（`node scripts/mcp-server.mjs`），把对话用的只读课程工具开放给 MCP 客户端；参数 `--project`、`--desktop`、`--courses`（或 `STUDYORBIT_COURSES`），不写文件、不调用模型、不联网（[接法](../README.md#在-mcp-客户端里使用)） |
| `lib/course-mcp.mjs` | MCP 服务本体：每个注册表工具一个 MCP 工具（只读标注），每次调用重新读取课程文件；所有 MCP SDK 用法都在这里 |
| `lib/eval-score.mjs` | 评测的配对与打分纯函数 |
| `eval-chat-qa.mjs` | 用合成题集比较对话的上下文模式和工具模式：每题 N 次单轮对话、确定性评分、`--fake` 固定输出、`--rescore` 重新评分（[说明](../docs/eval-chat-qa.md)） |
| `lib/qa-grade.mjs` | 问答评测的评分纯函数 |
| `lib/course-list.mjs` | Canvas JSON 解析与课程代码筛选 |
| `lib/course-analysis.mjs` | 统一提示词及模型输出 Schema |
| `lib/course-reports.mjs` | 读取已选课程和桌面课程文件夹里最新的有效课程 JSON |
| `lib/llm-config.mjs`、`lib/llm-providers.mjs` | 模型设置（`.local/config/llm.json`）和四家模型的适配器 |
| `lib/chat-store.mjs`、`lib/chat-context.mjs`、`lib/chat-replies.mjs` | 对话存储、对话上下文与系统提示、进行中的回复 |
| `lib/revision-store.mjs` | 复习笔记存储（`.local/revision/notes.json`） |
| `lib/local-origin.mjs` | 本地接口的同源检查 |
| `lib/server-lock.mjs`、`lib/sync-store.mjs` | 本地接口服务的单实例锁（`.local/server.lock`）和同步记录数据库（`.local/studyorbit.db`） |
| `lib/sync-pipeline.mjs`、`lib/sync-stages.mjs` | 分阶段的课程同步：每门课采集 → 分析 → 校验 → 合并，各阶段检查点存进数据库，失败、取消或中断后可从检查点继续；取消、中断和用量记录 |
| `lib/rate-limit.mjs`、`lib/collector-exit.mjs` | 各平台的限流与有限次重试（采集器一次一个、模型每家最多 4 个；HTTP 429/5xx 和网络错误最多试 3 次），以及采集器的临时失败退出码 75 |

`.d.mts` 文件是这些模块给 TypeScript 用的类型声明。旧的复制式采集脚本和 Cookie 实验脚本已移除，需要时查 Git 历史。
