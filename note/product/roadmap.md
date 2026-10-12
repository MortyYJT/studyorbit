# 路线图

按依赖顺序做。每一项在开工前要有一个对应的 OpenSpec change（`openspec/changes/<id>`），规格在开工前一刻才写，不一次写完。
技术细节以 `docs/engineering/v1-technical-design.md` 为准（决策 #55–#77；iCal 已去掉，#77）。

> 2026-10-12 修订：不设日期（#67，推翻 #32 的 10/15）；复习功能提前进第一版（#70）；做 L4（#56，推翻 #3）；Notion 挪到第二版（#71）；新增 Q1 真实 quiz 场景（#75）。每个里程碑结束给用户一份验收清单（#68）。
> 2026-10-13：本表是**唯一的进度表**，每合并一个 PR 就更新「状态」和「卡在哪」。还没有任何 change 归档，所以 `openspec/specs/` 是空的：归档要等用户验收（各 change 的最后一组 tasks）。

## 第一版：自动 + 可信 + 排得动 + 复习 + 分级代做

| 顺序 | 里程碑 | 内容 | 状态 | 卡在哪 | OpenSpec change |
| --- | --- | --- | --- | --- | --- |
| M0 | 基建 | Node 24 + TS 脚手架、vitest、zod、`node:sqlite` 仓储；`check.sh` 和 CI；浏览器抓取 | 进行中（代码全部合并） | 5.5 用户登录实测（登录能保持多久）→ 归档 | `v1-foundation` |
| S0 | 选课 + Ed 抓取 | 只爬选定课程；Ed JSON 抓取 | 进行中（3.1–3.8 合并） | 3.9 用户登录实测 → 3.10 归档 | `capture-selection-ed` |
| Q1 | 第一个真实 quiz | Ed quiz（**10/25 截止**）：读题 → agent 作答 → 终端审核 → Playwright 填页面 → **用户点提交**，同时记录 Ed 的提交请求 | 进行中（A–C 合并） | D 在分支 `codex/quiz-fill`，等用户选「填写怎么接管浏览器」；E 在 D 之后；5.4 真实结构检查要登录 | `ed-quiz-assist` |
| M1 | 取数与同步 | Canvas `/api/v1` + Ed + 课件 PDF 文字；规范化、去个人信息、变化事件、`Run` 账本 | 进行中（1.1、B、D、F 合并） | 1.2 Canvas 实测要登录，C 在它之后；E 要装 `unpdf`；G、H 在 C–F 之后 | `v1-sync` |
| M2 | agent 协议 | 一张命令注册表生成 CLI / MCP / HTTP；读接口；带引文核对的写接口；课程 AI 政策、授权和审计日志 | 进行中（A–H 合并） | I（收尾）在分支 `claude/protocol-integration`，修复后待复审；新记录的 SQLite 表要用户批准 | `v1-protocol` |
| M3 | 界面 | 月历 / 周视图、任务、模块、成绩推算、EDF 排程、学习页、答案审核与提交确认、聊天窗口 | 进行中（change 合并） | issue A 清单在分支 `codex/ui-inventory` 待审查；Hermes 接口未实测 | `v1-ui` |
| M4 | 主动循环 | Hermes 挂 MCP + 技能；定时同步、推送；考前自动整理复习；L4 走 Ed 提交接口（默认确认） | 未开始 | M2、M3 | `v1-loop`（未写） |

实现说明：M2 已实现的接口见 `docs/engineering/protocol.md`；Canvas 探针见 `docs/engineering/canvas-student-session-spike.md`。

**并行（#76、#91）：** 同步、协议、界面三条线可由最多 3 个 Codex 在独立 clone 里并行，Claude 在用户在线时调度。

**风险项：** Canvas 接口是否允许学生会话读取（M1 第一步实测）；Hermes 是否有可调用接口（M3 第一步实测）；Ed 接口无文档、可能改版；仓库转私有后没有分支保护。

## 第二版

- Notion 只读集成（#27、#71）。
- 自我修复的抓取脚本：校验失败时由 Codex 经 Playwright MCP 修复，修复快照沉淀为回归测试。
- 尽量少改动的重排；学习个人节奏（预计和实际用时的偏差）。

## 第三版

- 规划、执行、验证分离：DeepSeek 规划 → Codex / Claude Code 在沙箱里执行 → 三层验收（可执行检查 → 评分标准覆盖检查 → 你把关），用于大作业（assignment）的完整代做。

状态只用：未开始 / 进行中 / 已完成 / 已搁置。
