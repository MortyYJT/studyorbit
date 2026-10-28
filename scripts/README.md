# 同步脚本

当前运行入口为 `npm run dev` 和 `npm run sync:courses`。权限、登录、环境和数据位置见 [项目 README](../README.md) 与 [数据流](../docs/overview.md)。

| 脚本 | 用途 |
| --- | --- |
| `canvas-background.mjs` | Edge 已登录会话读取 Canvas 课程或单课考核分组、作业和提交成绩；按 Link 分页 |
| `collect-ed-course.mjs` | 通过 `edstem` CLI 获取 Ed 目录、部分成绩和选定介绍 |
| `edstem-scores.mjs` | 只读获取本人最终提交成绩，供 Ed 采集器使用 |
| `collect-handbook.mjs` | 在 Edge 后台读取对应年份的 Handbook 考核页 |
| `course-sync-runner.mjs` | 串行采集、并行模型整理、本地校验、取消和保存 |
| `lib/course-list.mjs` | Canvas JSON 解析与课程代码筛选 |
| `lib/course-analysis.mjs` | 统一提示词及模型输出 Schema |

旧复制式 `get-courses.mjs`、Cookie / Canvas / Ed 实验脚本已从工作树移除；历史文档保留了当时的命令和结果，如需源代码请查看 Git 历史。不要把旧记录中的运行步骤当成当前操作。
