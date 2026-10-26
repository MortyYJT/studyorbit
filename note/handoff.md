# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（需求来源；2026-10-24 起课程获取和 agent 的改法见 #165–#197，PRD 待更新）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/`（进行中：`canvas-check-item-policy`，规格已合并，实现未开始）；决定看 `note/decisions.md`（#1–#198）；进度看 `note/product/roadmap.md`。

- **最后更新：** 2026-10-26 傍晚，Claude。
- **模式：** OpenSpec 变更 `layered-sync`（路线图 C-5，**并入了原来的 `canvas-check-item-policy`**），规格已写好，过了两轮审查，实现还没开始。代码交给 dsh（DeepSeek）写（#209）；需要 Codex 的实测，等额度恢复后再做。
- **本轮合并（10-26 凌晨）：** #175、#176 重写 README（项目说明、为什么读页面不用 token、功能、计划、进度），同时把决策 #193–#197 和路线图 C-5 带进了 main；GitHub 仓库的 About 说明也已更新；#178 合并了 C-5 规格。
- **#191 删除隐私检查（沿用）：** 姓名、邮箱、学号、凭证样式的文字、本地路径都会原样存储、原样发给模型。保留引用完整性检查和 `source.record` 的网址规则。仓库和测试数据里仍然不能放真实课程数据、密钥和浏览器配置。
- **分工（#189）：** 实现和审查优先交给 Codex；Claude 派活、提交、在本机重跑检查、浏览器验证、合并。Codex 额度用完时由 Claude 接手，审查改用只读的 Claude 子代理（#175、#176 就是这样审的）。

## 进行中：`layered-sync`（C-5，分层同步）

- **来源**：你在对话里和 Claude 一起定的设计稿「分层同步 v0.3」（桌面 `Develop/墨大课业agent/架构图.drawio` 第 4 页，不进仓库）。决定 #199–#212。
- **要点**：
  - 代码一门一门地调度小任务：课程列表和作业数字（截止、开始时间、分值、得分、权重）走 Canvas 接口，Codex 复制、代码从剪贴板读（#208）。
  - Handbook 作暂定骨架（#203）；按导航栏分流页面（#201）；主 agent 只读主页。
  - 作业只读表层，深层存到 `~/Desktop/UniMelb 26S2/<课程名>/`（#200、#204）；内容变了就提醒你（#205）。
  - 考核项收敛成 6 类，有计分规则（#202、#210–#212）；你点「开始」才读深层。
  - Ed 先试 edstem-cli（#207）；并行默认关，等实验结果（#206）。
- **下一步（按顺序）**：
  1. 等你答复「Handbook 由代码抓」（任务 1.3、4.1 在等）。
  2. 按任务第 2 组起开 issue，派给 dsh（`dsh headless`，独立 clone，TDD），Claude 审查、提交、开 PR、合并。
  3. Codex 额度恢复、你在场时做任务 1.1（接口参数）、1.4（多窗口并行实验），最后做 10.2（实测填表）。
- **Ed**：edstem-cli 0.8.2 已全局安装；`edstem auth login` 等你粘贴 token（任务 1.2）。它现在的代码只认 Ed API token，不读 cookie。
- **待你复核**：#210、#211、#212 是 Claude 根据审查意见做的细化。

## 本轮的调研结论（10-26）

- 看了 TuuHub/unicorn（Apache-2.0）和作者 bunizao 的 moodle-cli 等项目：思路是"抓浏览器 cookie + 调前端自己用的 JSON 接口"，部署到 Cloudflare 做"变化记忆层"。Canvas 用自签 token，在墨大不能用。
- 我们以前就做过同源调用 Canvas `/api/v1` 和 Ed JSON（#52、#58，#100 实测学生会话返回 200），后来按 #165 改成 agent 读页面，#172 删了接口代码。C-5 只把接口拿回来做窄核对，不恢复整套接口同步。
- 可以借的思路：变化流的存储和清理、跨平台课程合并、ADR 里写"后果"和"残留风险"。只借思路，不复制代码。

## 等你做（按顺序）

1. 看课程页（分数构成分组、平均推算的权重、未知字段）是否读对。
2. 「请先设置每天可用小时」：在周视图里点「设置」填上，才会排周计划。
3. Agent 页发一条消息试一下；头像菜单里看「记忆」面板（C-4），试新增、编辑、删除。
4. 发现的问题直接告诉 Claude，开 issue 修。
5. 以后再同步：解锁屏幕、打开 Edge 并登录 Canvas 和 Ed（#185），`npm ci && npm run build`，`node dist/cli.js ui`，点「立即同步」。

## 等你决定

- **仓库现在是公开的（PUBLIC）。** #57 要求"回答或提交作业的代码只在仓库私有后才推送"，而 Q1 和 L1/L2 的代码都已经公开。你还没说是有意公开还是要改回私有（GitHub → Settings → Danger Zone）；改回私有后，要给别人看就得加成 collaborator。
- **纯文档 PR 要不要跳过 CI：** 在 `.github/workflows/ci.yml` 的 `pull_request` 下加 `paths-ignore`（`**/*.md`、`note/**`、`openspec/**`）。改 CI 要先问你。以后如果开分支保护、要求 CI 必须通过，被跳过的 PR 会卡住。
- **#187（部分推翻你选的 #109）：** 引用来源改为 Codex 把读到的页面文字交给代码存（`source.record`）。同意就不用动。
- **保存课程选择后不知道下一步：** 保存后在弹窗里给「开始读取这 N 门课」按钮，还是保存后自动开始？
- 旧的几项：`plan.read` 会清开始时间；手动任务必须挂模块；计划外工作的实际用时读不到；`metrics.read` 的分页参数要不要写进规格。
- 补理由：#127、#158、#159、#161、#172、#190、#193（取数方式）、#194、#196，以及旧的 #6、#9、#15–18、#23、#27、#29、#53、#67、#70。

## 待开的小 PR

- **已完成（10-26）：** [#179](https://github.com/MortyYJT/unimelb-coursework-agent/pull/179) 读课指令会读页面写明的单项分值（积分只在三种情况下换算）；[#180](https://github.com/MortyYJT/unimelb-coursework-agent/pull/180) 课程页按 #192 排序、不计分条目折叠到底部、显示 `得分/满分 · 百分比`、两色圆环（OpenSpec `course-page-display` 已归档；C-5 的增量已同步包含 #192 的规则，模拟归档通过）。**要看到效果：** `npm run build` 后重启 `node dist/cli.js ui`，再点「立即同步」重读一次（单项分值和满分要重新读才有）。
- **不稳定测试 [#181](https://github.com/MortyYJT/unimelb-coursework-agent/issues/181)：** `test/agent/codex.test.ts` 的「SIGTERM 后 SIGKILL」测试偶尔超时，重跑通过；CI 失败时先看是不是它。
- **「需要你」面板太挤：** COMP20003 的 12 个「截止时间未知」挤在一行，可以和课程选择那项一起改。

## 第一次逐门读课的结果（10-25 22:50–23:00）

- 4 门课都存入了，每门都提交了 3 次才通过（导入器要求重读缺失字段）。
- **COMP20003：** 7 个组成部分、32 项。3 份大作业的 Canvas 条目因读不到状态被丢弃，Ed 条目保留。participation 组的 12 项没有截止日期。
- **COMP20008：** 权重合计只有 50%，期末权重没读到（syllabus 链接跳回首页，复习 PDF 预览不出来）。
- **MAST10007：** 实验课测试按每人的分班时间进行，截止时间记为未知。
- **MUSI20163：** 出勤 80% 是 hurdle。Ed 上没有这门课。
- **AI 政策全部读成「允许」：** COMP20003 禁止的是用 AI 写报告和反思，MUSI20163 禁止用 AI 生成作业。C-5 的作业层政策就是为这个改的。

## 后续事项（已知限制）

- 复习笔记引用含 `<`、「student X」这类文字会被拒：应该已经随 #191 解决，但没有专门验证。
- 每门课要提交 3 次才存入：读课指令对"读不到就标 unknown"讲得不够清楚。
- C-4 浏览器检查只做了新增和删除，编辑只有测试覆盖。

## 运行与验证

- `npm ci && npm run check`（= `.claude/check.sh` = CI）；`npm run build`。看退出码。
- 前端检查：`npm run build && node test/web/harness.ts`（合成数据，会打印带会话的本地 URL，别贴出去）。真浏览器检查用 Claude 应用内的浏览器面板；直接打开带 `#s=` 的地址，不要先开无会话的地址再改 hash。
- Codex：需要 `codex` 已登录、电脑操作插件开着、屏幕解锁。切回 Claude：`COURSEWORK_AGENT=claude`。
- 纯文档 PR：审查通过就合并，不等 CI（#156）。

## 陷阱

- 课程读取只能在屏幕解锁、Edge 打开时进行（#185）。
- Codex 的工具调用在单独的 `coursework mcp` 进程里执行，任何跨进程状态都要放进库（`sync_jobs`）。
- Codex 的最终回复可能描述没发生的操作；只信事件和工具结果。
- Codex 沙箱不能开本地端口，它报的全量检查退出码 1 不算数，必须在本机重跑。
- `codex exec` 结尾打印的 token 数不含缓存读取；真实用量看 `~/.codex/sessions` 里的 `total_token_usage` 和 `rate_limits`。Codex 会自开子代理，简报里要写明禁止。
- 记录抄录来源时每页上限 60,000 字节（UTF-8 JSON），更长的用 `#part-N` 分段。
- 文档只能引用已经在同一分支上的东西（#175 第一轮审查就是因为 README 引用了没合并的变更）。
- 对外分享前用 `gh repo view --json visibility` 现查仓库是否公开，不要只信交接里的说法。
- 测试默认超时 20 秒；合并后也要看 main 的 CI；提交身份用 noreply（见 CONTRIBUTING）。
- 规格被全部删除的目录要在归档时手动删。
- 其余同前：HTTP 写命令要凭证；多分支改 `test/cli.test.ts` 的 MCP 工具数；只加表不删表（`local-store` 规格「Additive migrations」）；理由要标来源。
