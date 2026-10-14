# 路线图

按依赖顺序做。每一项在开工前要有一个对应的 OpenSpec change（`openspec/changes/<id>`），规格在开工前一刻才写，不一次写完。
技术细节以 `docs/engineering/v1-technical-design.md` 为准（决策 #55–#77；iCal 已去掉，#77）；与 `v1-delivery`（PRD + #114–#153）冲突的地方以 `v1-delivery` 为准；需求以 `note/product/prd.md` 为准。

> 2026-10-12 修订：不设日期（#67，推翻 #32 的 10/15）；复习功能提前进第一版（#70）；做 L4（#56，推翻 #3）；Notion 挪到第二版（#71）；新增 Q1 真实 quiz 场景（#75）。每个里程碑结束给用户一份验收清单（#68）。
> 2026-10-13：本表是**唯一的进度表**，每合并一个 PR 就更新「状态」和「卡在哪」。
> 2026-10-14 重定范围（#100–#111）：agent 负责理解和操作网页，固定代码负责记忆、排期、视图和护栏。`v1-foundation`、`capture-selection-ed`、`v1-protocol` 已连规格归档（现行规格在 `openspec/specs/`）；`v1-sync`、`ed-quiz-assist`、`v1-ui` 已关闭；剩下的 v1 工作全部在 `v1-rescope`。
> 2026-10-15：暂停开发写 PRD（#114）。`v1-rescope` 只带已实现的 A–C 规格归档（#151）；剩下的 v1 工作全部在 `v1-delivery`，按 PRD 拆成 issue A–M（下表 V-*）。

## 第一版：自动 + 可信 + 排得动 + 复习 + 分级代做

| 顺序 | 里程碑 | 内容 | 状态 | 卡在哪 | OpenSpec change |
| --- | --- | --- | --- | --- | --- |
| M0 | 基建 | 脚手架、仓储、CI、浏览器档案和检测 | 已完成（2026-10-14 归档） | — | `v1-foundation`（已归档） |
| S0 | Ed 读取 | Ed JSON 读取和限速（Canvas 爬取、终端选课被 #100 砍掉） | 已完成（2026-10-14 归档） | — | `capture-selection-ed`（已归档） |
| Q1 | 第一个真实作业 | COMP20003 Week 11 Workshop，agent 直接操作浏览器完成并提交（#94、#97） | 已完成（2026-10-13） | — | `ed-quiz-assist`（已关闭） |
| M2 | agent 协议 | 命令注册表 → CLI / MCP / HTTP；读接口；带引文核对的写接口；政策、授权、审计 | 已完成 A–H（2026-10-14 归档）；收尾 I 并入 R-C | — | `v1-protocol`（已归档） |
| R-A | 删掉被砍的代码 | `src/quiz/`、填写 / 提交关卡、Canvas 爬取、终端选课、变化检测 | 已完成（PR #86） | — | `v1-rescope`（已归档） |
| R-B | 常驻浏览器 | 常驻 Edge、可连接、登录状态、点击前高亮 | 代码已合并（PR #88） | 3.5 你在真机上登录并验证、记录登录能保持多久 | `v1-rescope`（已归档） |
| R-C | 协议收尾 | 生产组装（不带关卡）、`autonomy.check`、`audit.record`、作业技能 | 已完成（PR #91） | — | `v1-rescope`（已归档） |
| V-0 | 拆任务 | PRD → OpenSpec change `v1-delivery`；建 GitHub issue | 已完成（PR #97；issue #99–#114） | — | `v1-delivery` |
| V-A | 数据模型 | 所有新实体和一次性加表迁移 | 已完成（PR #115） | — | `v1-delivery` |
| V-B/C | 前端会话 + 等级 | 前端会话密钥、HTTP 托管、agent 工具集；按作业类型分等级 | B 已完成（PR #116）；C 未开始 | — | `v1-delivery` |
| V-D/E | 同步 + 批注 | `coursework sync`（按钮触发）；agent 批注和你的判定 | D 进行中（已实现，待审查）；E 未开始 | D 5.6 你在真机上跑一次同步 | `v1-delivery` |
| V-F/G | 排期 + 复习 | 按天排期、预计 / 实际用时、校外任务；学习记录、`source.fetch`、考试范围、练习统计 | G 进行中（已实现，待审查）；F 未开始 | — | `v1-delivery` |
| V-H/I/J | agent 对话 | 适配器接口和对话存储；Claude Agent SDK 适配器和策略钩子；我们自己的浏览器工具和提交确认 | 未开始 | V-A、V-B、V-C | `v1-delivery` |
| V-K1–K4 | 前端 | 外壳和菜单、七列周视图、课程页和抽屉、Agent 对话页 | 未开始 | V-B 及各自的数据 | `v1-delivery` |
| V-L/M | 指标 + 验收 | 四项指标；你按 PRD 逐条验收后归档 | 未开始 | 以上全部；R-B 3.5 | `v1-delivery` |
| 以后 | 邮件入口 | 邮件作为新的信息来源（#99） | 未开始 | — | 未写 |

实现说明：M2 已实现的接口见 `docs/engineering/protocol.md`；Canvas 探针见 `docs/engineering/canvas-student-session-spike.md`。

**并行（#76、#155）：** V-A 之后最多三条线：{B、C、F}、{D、E}、{G、H}（见 `v1-delivery` 设计 13）；最多 3 个 Codex 在独立 clone 里并行，由定时调度员无人值守调度（#155，推翻 #91）。

**风险项：** 登录能保持多久（R-B 实测）；Edge 是否允许在托管档案上开远程调试（R-B）；Ed 接口无文档、可能改版；仓库转私有后没有分支保护。

## 第二版

- Notion 只读集成（#27、#71）。
- 自我修复的抓取脚本：校验失败时由 Codex 经 Playwright MCP 修复，修复快照沉淀为回归测试。
- 尽量少改动的重排；学习个人节奏（预计和实际用时的偏差）。

## 第三版

- 规划、执行、验证分离：DeepSeek 规划 → Codex / Claude Code 在沙箱里执行 → 三层验收（可执行检查 → 评分标准覆盖检查 → 你把关），用于大作业（assignment）的完整代做。

状态只用：未开始 / 进行中 / 已完成 / 已搁置。
