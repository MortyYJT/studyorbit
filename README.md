# StudyOrbit

**UniMelb coursework assistant** · 墨大课业助手

本地优先的墨大课业助手。它从你已登录的 Canvas、Ed 和 Handbook 读取课程信息，由你选择的模型整理成结构化的课程 JSON，经代码校验后在网页里展示成绩、算出期末还需要多少分、自动排出每周计划、帮你复习，并能就你的课程回答问题。存储只在本机；分析和对话时，课程数据会发给你选择的模型服务商。

> 仍是原型：只在 macOS + Microsoft Edge + 墨大 Canvas 上实际跑过，其他组合见下面的「支持的环境」。一次同步的结果需要人工核对，不要当作必然正确。

## 支持的环境

在「设置 → 数据来源」里选择学校、Canvas 地址、浏览器和 Ed 区域；不改设置就是下表第一行（和以前完全一样）。

| 组合 | 状态 |
| --- | --- |
| macOS + Microsoft Edge + 墨尔本大学（Canvas、Ed 澳区、Handbook） | 已实测 |
| macOS + Google Chrome（同一套 Apple 事件脚本） | 未实测：只核对过脚本字典，没有用真实 Chrome 跑过 |
| 其他学校的 Canvas（学校选「其他学校（通用 Canvas）」） | 未实测：只用另一个 Canvas 地址的合成接口响应测过；没有 Handbook 这类官方考核框架，分析只用 Canvas 和 Ed |
| Ed 美区、欧区（`us`、`eu`） | 未实测：接口地址照抄 `edstem` CLI 的区域表，课程链接格式只在澳区确认过 |
| Windows、Linux（专用浏览器，CDP） | 实验性，未实测：只有单元测试（假管道、假文件系统、假浏览器）；没有在 Windows 或 Linux 上跑过，也没确认单点登录在专用浏览器里能保持多久 |

## 功能

- **同步课程：** 从 Canvas 发现课程，你勾选后依次采集 Canvas（作业、分组、本人提交）、Ed（`edstem` CLI）和 Handbook（考核结构），再由模型合并成一份课程 JSON；格式或关系不对时自动修复一次，结果按课程保存在桌面课程文件夹。
- **成绩：** 课程页显示已得分、当前平均、已出分占比和各项权重；选目标档（H1 80 / H2A 75 / H2B 70 / H3 65 / P 50）后显示剩余未出分部分平均要拿多少，已稳或已无法达到会直接说明。
- **考核：** 一行一项，带子项的可以展开；可以手动修正、合并、新增或隐藏，修正保存在本机 `.local/corrections/`，不改同步原件；重新同步后你的修正都保留，同步和你都改了同一字段时在课程页顶部「同步冲突」里选用哪个。
- **每周计划：** 设置每天可用时间后，按「截止最早先排」把任务分到截止前的几天（同样的输入总得到同样的结果）；截止前放不下的、已过截止的，列在顶部「需要你处理」，同时列出 7 天内截止却还没安排的计分考核、同步失败的课程，以及重新同步后变了的截止时间和权重（点「知道了」后不再显示）。周视图和月历显示同步来的截止日期；可以添加课程之外的任务，记录实际用时并和预计对比。
- **复习：** 课程页「复习」分页列出考试的日期、权重和规则；一键让 Agent 带你复习、出练习题或整理笔记；单门课对话里已完成的回复可以「存到复习」，下次打开还在。
- **Agent 对话：** 根据已选课程的同步数据回答问题，例如解释权重、算期末需要的分数、排本周计划、出复习题。只做讲解和规划，**不代写、不代做、不提交任何作业**。
- **MCP：** 本机 stdio MCP 服务把对话用的只读课程工具（课程列表、考核、成绩、期末需要、近期截止、排期）开放给 Claude Code、Claude Desktop 等客户端，见 [在 MCP 客户端里使用](#在-mcp-客户端里使用)。
- **选择模型：** 在「设置 → 分析模型」选择 DeepSeek、OpenAI 兼容接口（OpenAI、通义、Kimi、本地 Ollama 等）、Anthropic Claude 或 Codex CLI；同步分析和对话共用这份设置。
- **外观：** 浅色 / 深色 / 跟随系统；五套配色；背景可选渐变、纯色或上传的图片（可调可见度、模糊和卡片不透明度）；系统开启「减少动态效果」时动画自动关闭。

## 启动

需要 Node.js **24 或更新版本**。在项目目录运行：

```bash
npm ci
npm run dev
```

打开 `http://localhost:5173/`。`npm run dev` 会先启动本地接口服务（`127.0.0.1:5190`），再启动页面（`localhost:5173`）；两个端口可用 `STUDYORBIT_API_PORT`、`STUDYORBIT_WEB_PORT` 修改，端口被占时直接报错，不会换端口。只看已同步的数据不需要额外准备；要同步课程还需要：

1. 在 **macOS Microsoft Edge** 中登录 Canvas（默认是墨大 Canvas），并保留一个浏览器窗口。Canvas 和 Handbook 采集依赖 Edge 的 Apple Events JavaScript 和系统自动化权限。采集前浏览器必须已经打开；没打开时会报「请先打开 Microsoft Edge 并登录」，不会替你启动。
   - **改用 macOS Google Chrome（未实测）：** 在「设置 → 数据来源」把浏览器改成 Google Chrome 并保存（第 2 部分的临时环境变量 `STUDYORBIT_BROWSER` 已去掉）。Chrome 需要在菜单 View → Developer → Allow JavaScript from Apple Events（中文界面在「显示 → 开发者」里）勾选，第一次采集时 macOS 会另外询问是否允许终端控制「Google Chrome」。Chrome 和 Edge 的脚本字典相同，但还没有用真实 Chrome 跑过。
   - **Windows、Linux：专用浏览器（实验性，未在 Windows 和 Linux 上验证）：** 在「设置 → 数据来源」选「Google Chrome（专用浏览器）」或「Microsoft Edge（专用浏览器）」（这两个系统上默认就是 Chrome 专用浏览器）。StudyOrbit 找已安装的 Chrome 或 Edge（Windows 在 Program Files、Program Files (x86) 和本机 AppData 下找，Linux 在 `PATH` 里找 `google-chrome`、`chromium`、`microsoft-edge` 等；找不到时在设置里填程序完整路径），用单独的配置目录 `.local/browser/<浏览器>`（只有你能读）和 `--remote-debugging-pipe` 启动它：不开调试端口，不碰你平时用的浏览器配置。点设置里的「打开专用浏览器」，在弹出的窗口里登录 Canvas（单点登录、两步验证都在这里自己完成，StudyOrbit 不输入任何密码）；同步期间不要关这个窗口。本地服务一直持有这个浏览器，跨课程、跨同步复用，所以只关浏览器才会丢掉登录；你关掉窗口、换浏览器设置或停止服务时它才关闭。采集时只能打开 Canvas 地址和学校框架来源的地址，只读页面正文或同源 JSON，不读 cookie、本地存储或密码。同步中遇到登录失效会报「Canvas：请在专用浏览器里登录后继续同步。」，登录后点「继续上次同步」。同一个配置目录已有专用浏览器在运行（例如上次服务异常退出后留下的）会报「StudyOrbit 专用浏览器已在运行，请先关闭它」。删掉 `.local/browser/` 就等于退出登录。
   - **其他学校（未实测）：** 学校选「其他学校（通用 Canvas）」，填你学校的 Canvas 地址（只要 `https://` 加域名）和时区，按需填一个只带一个括号的课程代码正则（例如 `^([A-Z]+\d+)_`，括号里的部分就是课程代码）。改了学校或 Canvas 地址后要重新「立即同步」获取课程；旧课程列表来自另一个 Canvas 时，同步和课程页会提示「Canvas 地址已更改，请重新获取课程」。
2. 安装并登录 `edstem` CLI（Ed 使用它自己的登录，不复用浏览器；墨大在澳区）。Ed 区域默认「自动」，跟随 CLI 的登录区域读取成绩，课程链接按澳区生成；在美区或欧区请在设置里直接选 `us` 或 `eu`，设置和 CLI 登录的区域不一致时这门课的 Ed 数据记为未读取。
3. 在「设置 → 分析模型」选择模型并填写密钥，点「测试连接」确认可用。也可以沿用环境变量（`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`，或 `COURSE_ANALYSIS_PROVIDER` / `_MODEL` / `_URL` / `_API_KEY`）；优先级是设置 > 环境变量 > 默认（DeepSeek `deepseek-flash`）。

然后在页面点「立即同步」，勾选课程并保存。**保存选课会立刻开始同步**，会用到浏览器（Edge、Chrome 或专用浏览器）、Ed 和模型额度；复习页的预设按钮和对话也会用模型额度。只采集课程列表可以运行 `npm run sync:courses`。

## 不用墨大账号试跑

仓库带一门合成课程（`test/fixtures/synthetic-course/`，课程代码 `SYNT10001`，数据全是编的），可以不登录、不用模型密钥，走一遍「模型输出 → 本地校验 → 拦截与修复 → 和标准答案对比打分」：

```bash
node scripts/eval-course-analysis.mjs --fixture test/fixtures/synthetic-course
```

第一份固定输出把 Ed 的得分配上了 Canvas 的满分，会被校验拦下并触发一次修复；另一份能通过校验但漏了一个 hurdle，只有对比标准答案才发现。终端会打印准确率、一致性和拦截次数，完整结果存在 `.local/eval/results/`。加 `--live` 改为调用你设置的模型。标准答案格式、指标定义和用真实采集数据评测的方法见 [课程分析评测](docs/eval-format.md)。

## 在 MCP 客户端里使用

`scripts/mcp-server.mjs` 是一个本机 stdio MCP 服务（服务名 `studyorbit`），提供和 Agent 对话相同的 6 个只读工具：`list_courses`、`get_assessments`、`calculate_grades`、`final_needed`、`upcoming_deadlines`、`plan_schedule`。同样的数据和参数，它和页面里的对话得到相同的结果。

- **只读、只在本机：** 每次调用重新读取 `.local/lms/courses.json` 和桌面课程文件夹里最新的有效课程 JSON（和页面同一份数据，同步后不用重启）；不同步、不写任何文件、不调用模型、不读模型设置和密钥、不联网。不应用你在页面里做的修正。
- **没有计划数据：** 每周计划的任务存在页面里，MCP 读不到；`plan_schedule` 只在对话中把任务作为参数传入时可用。
- **需要 Node.js 24 或更新版本：** 客户端启动的 `node` 必须是 24+。客户端（尤其是 Claude Desktop）找不到正确的 `node` 时，把下面的 `node` 换成它的绝对路径（终端里 `which node` 可查）。
- **要用 `node` 直接启动，不要用 `npm run mcp`：** npm 会往标准输出打印一行标题，破坏协议。`npm run --silent mcp` 只适合手动试运行。

下面的 `<仓库绝对路径>` 换成本仓库在你电脑上的绝对路径。

**Claude Code：**

```bash
claude mcp add studyorbit -- node <仓库绝对路径>/scripts/mcp-server.mjs
```

**Claude Desktop：** 编辑 `claude_desktop_config.json`（macOS 在 `~/Library/Application Support/Claude/`，也可从「设置 → 开发者 → 编辑配置」打开），加入后重启 Claude Desktop：

```json
{
  "mcpServers": {
    "studyorbit": {
      "command": "node",
      "args": ["<仓库绝对路径>/scripts/mcp-server.mjs"]
    }
  }
}
```

**其他 MCP 客户端：** 配置一个 stdio 服务，命令 `node`，参数 `["<仓库绝对路径>/scripts/mcp-server.mjs"]`，不需要任何密钥或环境变量。

**可选参数：**

| 参数 | 作用 |
| --- | --- |
| `--courses <课程ID,课程ID>` 或环境变量 `STUDYORBIT_COURSES` | 只开放这些课程（Canvas 课程 ID，可先不加筛选调用 `list_courses` 查看）；两者都给时以 `--courses` 为准，不在课程列表里的 ID 会被忽略 |
| `--project <目录>` | 读取哪个项目的 `.local/`，默认是脚本所在的仓库 |
| `--desktop <目录>` | 课程文件夹所在的目录，默认 `~/Desktop`（与页面相同） |

例如在 Claude Code 里只开放两门课：`claude mcp add --env STUDYORBIT_COURSES=<课程ID>,<课程ID> studyorbit -- node <仓库绝对路径>/scripts/mcp-server.mjs`；Claude Desktop 则在上面的配置里加 `"env": { "STUDYORBIT_COURSES": "<课程ID>,<课程ID>" }`。

> **数据流向：** 工具结果包含你的成绩和考核信息，会发给你在该客户端里使用的模型（例如 Claude Desktop / Claude Code 发给 Anthropic），按那家服务商的条款处理。不想开放某门课时用 `--courses` 限定。诊断信息（课程数量、读取失败的原因）只写到标准错误输出，在客户端的 MCP 日志里能看到，不含课程内容。

## 数据与隐私

| 内容 | 位置 |
| --- | --- |
| 采集快照、同步记录与用量、截止和权重变更记录、修正、模型设置、数据来源设置（`.local/config/sources.json`）、对话、复习笔记 | 项目内 `.local/`（被 Git 忽略；设置文件权限 600，密钥只写不回显） |
| 每门课的课程 JSON | 墨大：`~/Desktop/墨尔本大学 <年份> S<学期>/<课程代码>/`；其他学校：`~/Desktop/StudyOrbit <学期>/<课程代码>/`（只保留字母、数字、空格、点、下划线和连字符） |
| 选课、任务与用时、每天可用时间、外观设置、变更已读标记、背景图片（迁移前的修正留作备份） | 浏览器 localStorage / IndexedDB（背景图片不会上传） |

- 存储只在本机；分析和对话时，课程数据（含成绩）会发给你选择的模型服务商，按该服务商的条款处理，模型调用可能产生费用。接口地址指向本机模型（例如 Ollama）时，数据不出本机。
- 本地接口只接受本机、同源、带本次启动令牌的请求：令牌由 `npm run dev` 每次随机生成，只由页面服务器的代理加上，不发给浏览器；其他网站、本机其他端口的页面和局域网设备都读不到你的数据。
- 不使用自签 Canvas token（学校禁止）；登录和多因素认证始终由你自己完成，模型看不到密码。

## 开发

- `npm run check`：类型检查加 `test/` 下的 vitest 测试，与 CI 相同。成绩、「期末需要」和排期是 `shared/` 里的纯函数，测试只用合成数据。
- `npm run build`：构建静态资源。**静态构建不包含同步、对话和复习笔记接口**，它们在本地接口服务（`server/`）里，只有 `npm run dev` 会把页面和它连起来。
- 代码结构见 [项目结构和数据流](docs/overview.md)，脚本见 [scripts/README.md](scripts/README.md)；课程 JSON 契约见 [docs/course-json.md](docs/course-json.md)，分析提示词见 [docs/course-sync-prompt.md](docs/course-sync-prompt.md)，评测见 [docs/eval-format.md](docs/eval-format.md)；现行规格在 `openspec/specs/`。
- 开发规则见 [CLAUDE.md](CLAUDE.md)；决定记录在 `note/decisions.md`，产品定位和以后的想法见 [note/product.md](note/product.md)，当前交接在 [note/handoff.md](note/handoff.md)。

## 实验记录

[第一版试跑](docs/first-sync-run-20261029.md)、[同步用量](docs/sync-measurements.md)、[同步优化](docs/sync-optimization.md) 记录了真实运行的耗时和 token 用量。它们只代表当时那几门课，不等同于普遍结论。个人成绩已从这些记录中移除；含成绩的模型对比与混合同步实验只保存在本机。

## 仓库历史

2026-10-29 起，本仓库以本地原型 v2 为准：v2 的开发历史已在去掉个人成绩后并入主线。早先的 v1 实现（Codex 读页面、`coursework` CLI、SQLite 存储、v1 的 OpenSpec 规格）已从主线移除，仍可在 Git 历史中查看。

## 许可证

[MIT](LICENSE) © 2026 MortyYJT。依赖各自的许可证；外部命令 `edstem` CLI 不随本仓库分发。
