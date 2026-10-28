# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`。决定看 `note/decisions.md`（#1–#231）。

- **最后更新：** 2026-10-29 凌晨，Claude（主 agent，用户在睡觉）。
- **分支：** `claude/v2-consolidation`（从 `main` 38500e3 开出），**只在本地，没有推送，没有 PR**（#227）。

## 今晚的任务（用户 10-29 凌晨布置）

0. **清理（先做，已完成主体）：** 以桌面原型 v2 为准，旧代码归档进被忽略的 `archive/`，v2 并入，桌面 v2 删除。
1. **模型选择：** 设置里让用户选择分析用的 agent/LLM（#229）。
2. **配色：** 几套常规配色一键切换 + 参考 https://mortyyjt.github.io/ 的个人配色（#228）。
3. **Agent 对话：** 接入对话，设计由 Claude 按现有需求定（#230）。
4. **上下文：** 太长就换新会话、写好交接；主 agent 派子代理实现，自己只盯进度（#231）。

## 已完成

- `b696cd2`（分支 `claude/ui-polish`，本地）：v1 前端的黑白灰侧栏改版预览，随 v1 一起归档，不再继续。
- `0ad59c0`（本分支）：v2 快照成为主实现；v1 移到 `archive/v1/`（含旧 `dist/`、`node_modules/`、未跟踪的 `experiment/`）。
- `archive/`（被忽略，不推送）：`v1/`、`v2-history.bundle`（v2 完整 Git 历史，`git clone archive/v2-history.bundle` 可恢复）、`v2-private-docs/`（三份含个人成绩的实验记录）、`v2-import/`（导出残留，可删）。
- v2 的 `.local/lms`、`.local/experiments`、`.local-backups/` 已 mv 到本仓库；三个本地接口（course-reports、course-candidates、sync-usage）在迁移前后返回完全相同的数据。
- 桌面 v2 已移到 `~/.Trash/unimelb-coursework-v2-20261029`（可恢复）。
- 开发服务器现在从本仓库跑：`npx vite --port 5173`（用户浏览器的选课存在 localhost:5173 的 localStorage，端口不能换）。

## 下一步（按顺序，每步一个子代理，做完由新上下文子代理审查，主 agent 跑检查、截图、提交）

1. **清理代码：** 删掉 v2 里依赖 v1 后端的死代码（`web/src/{client,shell,weekStore,week,chat,agent-client,course-contracts}.ts`、`Agent.tsx` 的旧实现、`shared/{domain,protocol,agent,memory,metrics,planning}`），App 不再轮询不存在的 `/api/*`；更新 `AGENTS.md` 的 Project-specific 段为 v2 技术栈；修 `.claude/launch.json`（指向已归档的原型）；加 vitest，`check` = 类型检查 + 测试。
2. **配色**（#228）。
3. **模型选择**（#229）。
4. **Agent 对话**（#230）。

## 运行与验证

- `npm ci`；`npm run check`（= `.claude/check.sh` = CI）；`npm run dev` 或 `npx vite --port 5173`。
- 同步接口只在 Vite 开发服务器里（静态构建不含）。**不要点「立即同步」或保存选课**：会真的用 Edge、Ed 和模型额度（保存选课会立刻开始同步）。
- 截图验证：用独立的临时浏览器（taste-skill 的 `scripts/lib/cdp.mjs`），在里面写入 `coursework.canonical-reset-v1=done` 和 `coursework.selected-course-ids`，再读真实课程报告；不要碰用户浏览器的数据。

## 等用户决定

- #223–#231 全部待复核，尤其：是否推送、v2 历史是否要以别的方式保留、`archive/v2-import/` 可删。
- 旧交接里的待决事项（Handbook hurdle 段、PDF 依赖、仓库公开等）针对 v1，已随 v1 归档；需要的话从 `archive/v1` 或 Git 历史找回。

## 陷阱

- 课程 JSON 输出在 `~/Desktop/墨尔本大学 <年> S<学期>/<课程代码>/`，不在仓库里，不要动。
- `sync-usage` 接口靠 `.local/lms/runs/*` 目录的创建时间还原旧批次：移动数据用 `mv`，不要 `cp`。
- `verify.sh` 在工作区不干净时要求 `.claude/check.sh` 通过才允许结束回合。
- 仓库公开：个人成绩、Cookie、密钥、本机路径不能入库。
