# 路线图

按依赖顺序做。每一项在开工前要有一个对应的 OpenSpec change（`openspec/changes/<id>`），规格在开工前一刻才写，不一次写完。
技术细节以 `docs/engineering/v1-technical-design.md` 为准（决策 #55–#77；iCal 已去掉，#77）；与 `v1-rescope`（#100–#111）冲突的地方以 `v1-rescope` 为准。

> 2026-10-12 修订：不设日期（#67，推翻 #32 的 10/15）；复习功能提前进第一版（#70）；做 L4（#56，推翻 #3）；Notion 挪到第二版（#71）；新增 Q1 真实 quiz 场景（#75）。每个里程碑结束给用户一份验收清单（#68）。
> 2026-10-13：本表是**唯一的进度表**，每合并一个 PR 就更新「状态」和「卡在哪」。
> 2026-10-14 重定范围（#100–#111）：agent 负责理解和操作网页，固定代码负责记忆、排期、视图和护栏。`v1-foundation`、`capture-selection-ed`、`v1-protocol` 已连规格归档（现行规格在 `openspec/specs/`）；`v1-sync`、`ed-quiz-assist`、`v1-ui` 已关闭；剩下的 v1 工作全部在 `v1-rescope`。

## 第一版：自动 + 可信 + 排得动 + 复习 + 分级代做

| 顺序 | 里程碑 | 内容 | 状态 | 卡在哪 | OpenSpec change |
| --- | --- | --- | --- | --- | --- |
| M0 | 基建 | 脚手架、仓储、CI、浏览器档案和检测 | 已完成（2026-10-14 归档） | — | `v1-foundation`（已归档） |
| S0 | Ed 读取 | Ed JSON 读取和限速（Canvas 爬取、终端选课被 #100 砍掉） | 已完成（2026-10-14 归档） | — | `capture-selection-ed`（已归档） |
| Q1 | 第一个真实作业 | COMP20003 Week 11 Workshop，agent 直接操作浏览器完成并提交（#94、#97） | 已完成（2026-10-13） | — | `ed-quiz-assist`（已关闭） |
| M2 | agent 协议 | 命令注册表 → CLI / MCP / HTTP；读接口；带引文核对的写接口；政策、授权、审计 | 已完成 A–H（2026-10-14 归档）；收尾 I 并入 R-C | — | `v1-protocol`（已归档） |
| R-A | 删掉被砍的代码 | `src/quiz/`、填写 / 提交关卡、Canvas 爬取、终端选课、变化检测 | 未开始 | — | `v1-rescope` |
| R-B | 常驻浏览器 | 常驻 Edge、可连接、登录状态、点击前高亮 | 未开始 | R-A | `v1-rescope` |
| R-C | 协议收尾 | 生产组装（不带关卡）、`autonomy.check`、`audit.record` | 未开始 | R-A | `v1-rescope` |
| R-D | 复习技能 | 定时准备 + 对话复习；`source.fetch`；学习记录入 SQLite | 未开始，**目标 10/26** | R-B；装 `unpdf` 要你在场 | `v1-rescope` |
| R-E/F | 数据模型 + `coursework sync` | 新实体；Canvas JSON + Ed 写入本地库；按课程代码合并 | 未开始 | R-B | `v1-rescope` |
| R-G/H | 批注 + 排期 | agent 带出处的批注、考核项绑定；可用时间 + 截止优先排期 | 未开始 | R-E | `v1-rescope` |
| R-I/J | 界面读真实数据 + 验收 | 原型页面读本地数据；整体验收后归档 | 未开始 | R-F–H | `v1-rescope` |
| 以后 | 邮件入口 | 邮件作为新的信息来源（#99） | 未开始 | — | 未写 |

实现说明：M2 已实现的接口见 `docs/engineering/protocol.md`；Canvas 探针见 `docs/engineering/canvas-student-session-spike.md`。

**并行（#76、#91）：** R-D 可以和 R-E/F 并行；最多 3 个 Codex 在独立 clone 里并行，Claude 在用户在线时调度。

**风险项：** 登录能保持多久（R-B 实测）；Edge 是否允许在托管档案上开远程调试（R-B）；Ed 接口无文档、可能改版；仓库转私有后没有分支保护。

## 第二版

- Notion 只读集成（#27、#71）。
- 自我修复的抓取脚本：校验失败时由 Codex 经 Playwright MCP 修复，修复快照沉淀为回归测试。
- 尽量少改动的重排；学习个人节奏（预计和实际用时的偏差）。

## 第三版

- 规划、执行、验证分离：DeepSeek 规划 → Codex / Claude Code 在沙箱里执行 → 三层验收（可执行检查 → 评分标准覆盖检查 → 你把关），用于大作业（assignment）的完整代做。

状态只用：未开始 / 进行中 / 已完成 / 已搁置。
