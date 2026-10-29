# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`。决定看 `note/decisions.md`（#1–#231）。

- **最后更新：** 2026-10-29 凌晨（任务 4、2、1、3 都已完成），Claude（主 agent，用户在睡觉）。
- **分支：** `claude/v2-consolidation` 已通过 PR #242 以 merge commit 合并进 `main`（`1679e60`，CI 通过），v2 的 75 个提交历史已去掉成绩后保留在主线。无用分支已删，删前打包在 `archive/deleted-branches-20261029.bundle`（本地，不推送）。当前工作分支：`claude/motion-backgrounds`（动画与背景）。

## 今晚的任务（用户 10-29 凌晨布置）

0. **清理（先做，已完成主体）：** 以桌面原型 v2 为准，旧代码归档进被忽略的 `archive/`，v2 并入，桌面 v2 删除。
1. **模型选择：** 设置里让用户选择分析用的 agent/LLM（#229）。
2. **配色：** 几套常规配色一键切换 + 参考 https://mortyyjt.github.io/ 的个人配色（#228）。
3. **Agent 对话：** 接入对话，设计由 Claude 按现有需求定（#230）。
4. **上下文：** 太长就换新会话、写好交接；主 agent 派子代理实现，自己只盯进度（#231）。

## 已完成（本地提交，均未推送）

- `0ad59c0` v2 快照成为主实现；v1 移到 `archive/v1/`。`4b098e9` 决定 #223–#231 与本交接。
- `4a68245` 清理：删掉依赖 v1 后端的死代码（旧协议客户端、旧 Agent 页、`shared/` 旧契约）；加 vitest，`check` = 类型检查 + 测试；AGENTS.md 项目段改为 v2。
- `98bf2ff` 任务 2 配色：设置里一键切换 墨/雾蓝/松/石/谷鱼（谷鱼取自 mortyyjt.github.io），各有浅/深色；`--accent` 只用在主按钮、今天、已得环、占比条、同步进度；对比度均 ≥ 4.5:1。
- `0fd51eb` 任务 1 模型选择：设置「分析模型」可选 DeepSeek / OpenAI 兼容 / Anthropic / Codex；配置存 `.local/config/llm.json`（0600，密钥只写）；环境变量作后备；新上下文子代理审查发现两处密钥路由问题（未知提供方退回 DeepSeek、兼容接口密钥跨 origin），已先写测试再修；31 个测试通过。
- `archive/`（被忽略）：`v1/`、`v2-history.bundle`（v2 完整历史）、`v2-private-docs/`（三份含个人成绩的实验记录）、`v2-import/`（可删）。桌面 v2 在 `~/.Trash/unimelb-coursework-v2-20261029`。
- 开发服务器从本仓库跑在 5173（用户浏览器的选课存在这个端口的 localStorage）。

## 任务 3 已完成

- `（本提交）` Agent 对话（#230）：`/api/local/chats*`（SSE 流式、停止、删除），对话存 `.local/chat/<uuid>.json`；上下文是已选课程的同步数据摘要（不含页面上的修正），系统提示只允许 L0；四家提供方都有流式（Codex 一次性）；课程页「问 Agent」。
- 新上下文审查发现 4 处问题并已修：同一对话并发发送的竞态、早关标签页不中止模型、配置错误留下空对话、**其他 localhost 页面可跨域读取 `/api/local/*`（含成绩）**——现在所有本地接口拒绝外来 Origin（含 GET），`server.cors: false`。62 个测试通过。
- 未验证：四家提供方的真实调用（DeepSeek Responses 流式事件名、Codex 真实输出）都没跑过；Codex 只读沙箱仍能读本机文件，只靠提示词约束。

## 下一步

1. 用户早上：在设置里配好模型，点「测试连接」，再在 Agent 页发一句话，确认真实调用可用（会花少量额度）。
2. 更新本交接，等用户早上复核 #223–#231 并决定是否推送 / 开 PR（仓库公开，推送前再确认没有个人成绩、密钥、本机路径）。

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
