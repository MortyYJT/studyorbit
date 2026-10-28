# UniMelb coursework · 本地原型

这是一个本地优先的墨大课程同步与计划原型。当前主流程：从 Canvas 发现课程，用户选课后读取 Canvas、Ed 和 Handbook，用 DeepSeek 整理成课程 JSON，再在前端展示、编辑和计划。

## 启动

需要 Node.js **24 或更新版本**。在项目目录运行：

```bash
npm ci
npm run dev
```

打开终端显示的本地地址，通常是 `http://localhost:5173/`。保持开发服务器运行。只看已有前端数据不必重新同步；完整同步还需准备：

1. 在 **macOS Microsoft Edge** 中登录墨大 Canvas，并保留一个浏览器窗口；Canvas 和 Handbook 采集依赖 Edge 的 Apple Events JavaScript 和系统自动化权限。
2. 安装并登录澳区 `edstem` CLI；Ed 使用其独立认证，**不是**自动复用 Edge 登录。当前本机曾使用 0.8.2；未确认其他版本。
3. 在启动开发服务器的进程环境配置 `DEEPSEEK_API_KEY`（或 `COURSE_ANALYSIS_API_KEY`）。不要把密钥写进仓库或截图。默认使用 DeepSeek Responses API 与 `deepseek-flash`；课程和成绩数据会发送给配置的模型服务，模型调用可能产生费用。

配置完成后，从页面点击“立即同步”，选择课程并保存。只采集课程列表也可执行 `npm run sync:courses`；它使用相同的 Edge 后台采集器。

`npm run check`（与 CI 相同）运行类型检查和 `test/` 下的 vitest 测试。`npm run build` 检查 TypeScript 并构建静态资源；**静态构建不包含同步 API**，目前同步接口由 Vite 开发服务器提供。

## 文档

- [当前交接](note/handoff.md)：当前状态、下一步、限制与注意事项；[v2 合并前交接](docs/handoff.md)保留旧记录。
- [项目结构和数据流](docs/overview.md)：入口、来源、保存位置。
- [JSON 契约](docs/course-json.md)与[提示词](docs/course-sync-prompt.md)。
- [四门课采集快照](docs/collection-snapshot.md)、[第一版试跑](docs/first-sync-run-20261029.md)：实验记录，不等同于其他课程的验证。含个人成绩的模型对比与混合同步实验只保存在本机，不入库。
- [历史交接记录](docs/handoff-history.md)：保留讨论和过程，可能描述旧实现。

本项目仍是原型：当前采集器以 macOS + Edge 为主；Windows 和其他浏览器尚未实现完整兼容。不要把四门课的一次结果视为普遍正确。

## 仓库历史

2026-10-29 起，本仓库以这个本地原型（原桌面 `unimelb-coursework-v2`）为准。早先的 v1 实现（Codex 读页面、`coursework` CLI、SQLite 存储、OpenSpec 规格）已从主线移除，仍可在 Git 历史中查看。协作规则见 [AGENTS.md](AGENTS.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)，决定记录见 `note/decisions.md`。
