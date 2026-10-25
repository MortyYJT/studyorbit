# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。
> 产品看 `note/product/prd.md`（需求来源；2026-10-24 起课程获取和 agent 的改法见 #165–#197，PRD 待更新）；原型看 `design/prototype/index.html`；规格看 `openspec/specs/`（现行）和 `openspec/changes/`（进行中：`canvas-check-item-policy`，只在它自己的分支上）；决定看 `note/decisions.md`（#1–#197）；进度看 `note/product/roadmap.md`。

- **最后更新：** 2026-10-26 凌晨 3 点，Claude。
- **模式：** OpenSpec 变更 `canvas-check-item-policy`（路线图 C-5）进行中，只写了 proposal。真机验收（#186）也在进行中：第一次逐门读课已完成，4 门课都已存入，周视图能正常显示。
- **本轮合并（10-26 凌晨）：** #175、#176 重写 README（项目说明、为什么读页面不用 token、功能、计划、进度），同时把决策 #193–#197 和路线图 C-5 带进了 main；GitHub 仓库的 About 说明也已更新。
- **#191 删除隐私检查（沿用）：** 姓名、邮箱、学号、凭证样式的文字、本地路径都会原样存储、原样发给模型。保留引用完整性检查和 `source.record` 的网址规则。仓库和测试数据里仍然不能放真实课程数据、密钥和浏览器配置。
- **分工（#189）：** 实现和审查优先交给 Codex；Claude 派活、提交、在本机重跑检查、浏览器验证、合并。Codex 额度用完时由 Claude 接手，审查改用只读的 Claude 子代理（#175、#176 就是这样审的）。

## 进行中：`canvas-check-item-policy`（C-5）

- **分支：** `claude/canvas-check-item-policy`，一个本地提交（`f5faa58`），**还没推送**。里面只有 `proposal.md` 和决策 #193–#197（这两条决策已经通过 #176 进了 main，内容相同，以后合并不会冲突）。
- **还要写：** `specs/`（新的 `canvas-check`，以及修改 `coursework-sync`、`assessment-autonomy`、`domain-model`、`web-ui` 的增量规格）、`design.md`、`tasks.md`。改要求时整段复制原要求再改（MODIFIED），不要只写改动部分。
- **你已批准的设计（#193–#197）：**
  1. 读完一门课、`course.import` 存入后，Codex 在同一个 Edge 标签页里打开两个固定地址：`/api/v1/courses/{id}/assignments?include[]=submission&per_page=100` 和 `/api/v1/courses/{id}/assignment_groups?per_page=100`，把整页 JSON 原样交给一个新工具（不手抄）。代码只接受这两个路径，去掉 `while(1);` 前缀后解析。一页满 100 条时标"可能没读全"（这条是 Claude 加的实现细节，决策里没有，写规格时确认）。
  2. 按作业条目 key 里的 Canvas id（`CODE:canvas:assignment:<id>`）比对截止时间、分值、状态、得分；作业组权重通过"作业属于哪个 `assignment_group_id`"把分数构成和作业组对上，不靠名字猜。
  3. 对不上的存成冲突，在「需要你」里同时显示两边的值，你选定后存成你的批注；选之前排期和视图用 agent 的值并标"待确认"（#194）。
  4. 作业条目新增可选的 `aiPolicy`（读到时带原话和网址），读不到时保留上次的值（同 #184）；生效顺序：你在该作业上设的值 > 任何一层读到 `prohibited` > 离作业最近的已知值 > 未知（未知时按 #125 不设上限，#196）。`autonomy.policy.set` 扩展为也能传 `assessmentId`，作业抽屉里加政策选择。
  5. 改 `course-reading.md`（作业页写了 AI 条款的要读出来）和 `codex-instructions.md` 第 3 条（按作业查政策）。
  6. 数据模型：作业加 `aiPolicy` 及读取状态，新增核对冲突表，只加不删（`local-store` 规格「Additive migrations」）；#195 就是这次改模型的许可。
- **理由待补：** #193 的取数方式、#194、#196。

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

- **等 Codex 额度恢复（10-26 03:41 后）再派：**
  - [#172](https://github.com/MortyYJT/unimelb-coursework-agent/issues/172) 课程页排序、`得分/满分 · 百分比`、两色圆环（#192）。界面工作，要在真浏览器里验证并截图。
  - [#173](https://github.com/MortyYJT/unimelb-coursework-agent/issues/173) 读课指令：页面写了单项分值时要读出来，不要留给平均推算。合并后要重新同步才能看到效果。
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
