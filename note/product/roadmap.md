# 路线图

按依赖顺序做。每一项在开工前要有一个对应的 OpenSpec change（`openspec/changes/<id>`），规格在开工前一刻才写，不一次写完。
技术细节以 `docs/engineering/v1-technical-design.md` 为准（决策 #55–#77；iCal 已去掉，#77）；与 `v1-delivery`（PRD + #114–#153）冲突的地方以 `v1-delivery` 为准；需求以 `note/product/prd.md` 为准。

> 2026-10-12 修订：不设日期（#67，推翻 #32 的 10/15）；复习功能提前进第一版（#70）；做 L4（#56，推翻 #3）；Notion 挪到第二版（#71）；新增 Q1 真实 quiz 场景（#75）。每个里程碑结束给用户一份验收清单（#68）。
> 2026-10-13：本表是**唯一的进度表**，每合并一个 PR 就更新「状态」和「卡在哪」。
> 2026-10-14 重定范围（#100–#111）：agent 负责理解和操作网页，固定代码负责记忆、排期、视图和护栏。`v1-foundation`、`capture-selection-ed`、`v1-protocol` 已连规格归档（现行规格在 `openspec/specs/`）；`v1-sync`、`ed-quiz-assist`、`v1-ui` 已关闭；剩下的 v1 工作全部在 `v1-rescope`。
> 2026-10-24 重定方向（#165–#175）：所有 agent 换成 Codex，在你自己的 Edge 里读课程、对话、复习；课程信息由 agent 读取、脚本只做验证；分子项目 C-1～C-4 依次做。
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
| V-B/C | 前端会话 + 等级 | 前端会话密钥、HTTP 托管、agent 工具集；按作业类型分等级 | 已完成（B PR #116；C PR #118） | — | `v1-delivery` |
| V-D/E | 同步 + 批注 | `coursework sync`（按钮触发）；agent 批注和你的判定 | D 已完成（PR #121）；E 已完成（PR #129） | D 5.6 你在真机上跑一次同步 | `v1-delivery` |
| V-F/G | 排期 + 复习 | 按天排期、预计 / 实际用时、校外任务；学习记录、`source.fetch`、考试范围、练习统计 | 已完成：G（PR #119）、F（PR #126） | — | `v1-delivery` |
| V-H/I/J | agent 对话 | 适配器接口和对话存储；Claude Agent SDK 适配器和策略钩子；我们自己的浏览器工具和提交确认 | H 已完成（PR #127）；I 已完成（PR #131）；J 已完成（PR #134，3 处遗留等你决定） | I 10.4 你在真机上跑一次真实对话 | `v1-delivery` |
| V-K1–K4 | 前端 | 外壳和菜单、七列周视图、课程页和抽屉、Agent 对话页 | 已完成：K1（PR #139）、K4（PR #143）、K2（PR #144）、K3（PR #147）；合成数据 harness（PR #141）；补的读命令 `autonomy.read` 和平台提交状态（PR #146） | — | `v1-delivery` |
| V-L/M | 指标 + 验收 | 四项指标；你按 PRD 逐条验收后归档 | 已完成：L（PR #132、#142、#148）；M 17.1（PR #149）；`v1-delivery` 2026-10-24 未经真机验收先归档（#175），真机验收转到 Codex 子项目之后 | — | `v1-delivery`（已归档） |
| C-1 | Codex 对话 | 前端对话改用 Codex（`codex exec` 子进程），Codex 用电脑操作功能在你的 Edge 里工作；工具走 `coursework mcp`；护栏写进工作区 `AGENTS.md`（#167、#168、#173、#176、#177） | 已完成（PR #153、#155；2026-10-24 你真机验收通过，归档） | — | `codex-agent`（已归档） |
| C-2 | agent 读课程 | 你勾选课程 → Codex 填三层 JSON → 代码查格式、常识、必填 → 写库；删接口同步；每门课一个 `aiPolicy` 字段管能否用 AI（#165、#166、#169–#172、#180–#186） | 代码已完成（规格 PR #157，后端 #158，前端 #159），已归档；真机运行和你的验收转到早上统一做（#186） | 你早上解锁屏幕后真机验收 | `agent-course-reading`（已归档） |
| C-3 | 浏览器清理 | 删常驻 Edge、我们的浏览器工具和提交确认；Codex 只填不交（#173） | 进行中 | — | `codex-browser-cleanup`（未写） |
| C-4 | 长期记忆 | 事实由代码汇总、观察由 agent 记录；前端「记忆」页可看改删（#178） | 未开始 | C-1 | `long-term-memory`（未写） |
| 以后 | 邮件入口 | 邮件作为新的信息来源（#99） | 未开始 | — | 未写 |

实现说明：M2 已实现的接口见 `docs/engineering/protocol.md`；Canvas 探针见 `docs/engineering/canvas-student-session-spike.md`。

**并行（#76、#155）：** V-A 之后最多三条线：{B、C、F}、{D、E}、{G、H}（见 `v1-delivery` 设计 13）；最多 3 个 Codex 在独立 clone 里并行，由定时调度员无人值守调度（#155，推翻 #91）。2026-10-23 的 K2–K4、L 面板、M 17.1 改由 Claude 子代理在 worktree 里并行实现（#161）。

**风险项：** 登录能保持多久（R-B 实测）；Edge 是否允许在托管档案上开远程调试（R-B）；Ed 接口无文档、可能改版；仓库转私有后没有分支保护。

## 第二版

- Notion 只读集成（#27、#71）。
- 自我修复的抓取脚本：校验失败时由 Codex 经 Playwright MCP 修复，修复快照沉淀为回归测试。
- 尽量少改动的重排；学习个人节奏（预计和实际用时的偏差）。

## 第三版

- 规划、执行、验证分离：DeepSeek 规划 → Codex / Claude Code 在沙箱里执行 → 三层验收（可执行检查 → 评分标准覆盖检查 → 你把关），用于大作业（assignment）的完整代做。

状态只用：未开始 / 进行中 / 已完成 / 已搁置。
