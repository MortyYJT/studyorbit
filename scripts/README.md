# 脚本

运行入口是 `npm run dev`（页面和本地接口）和 `npm run sync:courses`（只采集课程列表）。权限、登录和数据位置见 [项目 README](../README.md) 与 [项目结构和数据流](../docs/overview.md)。

| 脚本 | 用途 |
| --- | --- |
| `canvas-background.mjs` | 在已登录的 Edge 里读取 Canvas 课程，或单课的作业分组、作业和本人提交；按 Link 分页 |
| `collect-ed-course.mjs` | 通过 `edstem` CLI 获取 Ed 目录、部分成绩和选定介绍 |
| `edstem-scores.mjs` | 只读获取本人最终提交成绩，供 Ed 采集器使用 |
| `collect-handbook.mjs` | 在 Edge 后台读取对应年份的 Handbook 考核页 |
| `course-sync-runner.mjs` | 串行采集、并行模型整理、本地校验、取消、保存和用量 |
| `dsh-attach-session.mjs` | 协作工具：把 dsh 无界面会话归到 DeepSeek Harness 的项目下（见 dispatch 流程），与应用无关 |
| `lib/course-list.mjs` | Canvas JSON 解析与课程代码筛选 |
| `lib/course-analysis.mjs` | 统一提示词及模型输出 Schema |
| `lib/course-reports.mjs` | 读取已选课程和桌面课程文件夹里最新的有效课程 JSON |
| `lib/llm-config.mjs`、`lib/llm-providers.mjs` | 模型设置（`.local/config/llm.json`）和四家模型的适配器 |
| `lib/chat-store.mjs`、`lib/chat-context.mjs`、`lib/chat-replies.mjs` | 对话存储、对话上下文与系统提示、进行中的回复 |
| `lib/revision-store.mjs` | 复习笔记存储（`.local/revision/notes.json`） |
| `lib/local-origin.mjs` | 本地接口的同源检查 |

`.d.mts` 文件是这些模块给 TypeScript 用的类型声明。旧的复制式采集脚本和 Cookie 实验脚本已移除，需要时查 Git 历史。
