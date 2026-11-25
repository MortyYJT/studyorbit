# 交接

> 单文件，只写当前状态，每次任务结束整份重写。信任之前先对照 `git status`、`git log`、`gh pr list`。历史看 git，决定看 `note/decisions.md`。

- **最后更新：** 2026-11-25，Claude。
- **项目是什么：** StudyOrbit（`MortyYJT/studyorbit`），本地优先的课业助手。已登录浏览器读 Canvas / Ed / Handbook → 分阶段同步（采集 → 分析 → 校验 → 合并，检查点存 `node:sqlite`）→ 课程 JSON v2 → 网页（独立本地服务 + Vite 代理）展示成绩、计划、复习。对话、记忆、出题由 DeepTutor（HKUDS/DeepTutor，装在仓库外）提供，课程数据经 StudyOrbit 的只读 MCP 服务给它。
- **主线：** `main` 含到 #300。没有未合并的 PR，没有进行中的 OpenSpec change（现行规格 `openspec/specs/`，18 份）。`npm run check`：64 个测试文件、922 条测试。
- **任务清单：** 用户桌面「2026-10-29-StudyOrbit待办」。10-29 的清单除 edstem-cli 两条外全部打勾（上游 `bunizao/edstem-cli` PR #18 当时未合并，之后没再查）；11-24 的 A–E 五条全部打勾。

## 2026-11-24 这一轮做了什么

| 项 | PR | 结果 | 决定 | 实测数字在 |
| --- | --- | --- | --- | --- |
| A 深浅色 | #294 | 只在设置里选，默认跟随系统；新键 `studyorbit.theme.v2` 只存选过的值；旧键里的 `light` 当作没选过 | #500–#505 | `docs/overview.md`「Theme」 |
| B 配色 | #295 | 照搬 Codex 桌面版（26.1117.41037）的浅色和深色；五套旧配色删除；令牌写成 `light-dark()`；默认背景改为纯色 | #510–#521 | `docs/palette.md` |
| C 动画 | #296 | 不再用 View Transition；切页是 150 ms 淡入；课程数据常驻；占位超过 150 ms 才画 | #530–#539 | `docs/motion.md` |
| D DeepTutor | #297、#298、#299 | Agent 页内嵌 DeepTutor 1.7.4；自建对话（页面、工具循环、存储、路由、评估脚本）删除 | #540–#557 | `docs/deeptutor.md` |
| E 走查 | #300 | 按学生的路径走一遍后改了入口、反馈和手机宽度下的问题 | #580–#594 | `docs/walkthrough.md` |

## DeepTutor 现在怎么接的

- **安装：** 在仓库外，`~/.local/share/studyorbit/deeptutor/venv`（uv 管的 Python 3.12，`uv` 在 `~/.local/bin`）。只装 `server, web, memory, questions, notebook`，没装 `solve` 和 `knowledge`。安装命令在 `docs/setup.md` 和 Agent 页的「还没有安装」面板里。
- **启动：** 本地接口服务（`server/main.ts` → `scripts/lib/deeptutor.mjs`）启动和停止它，所以 `npm run dev` 和桌面快捷方式不用改。没装、模型不是 DeepSeek、启动失败时，只有 Agent 页显示原因，其余页面照常。
- **端口：** 页面 5175、接口 5195、模型代理 5197（都只绑 127.0.0.1）；第二套是 5185、5196、5199。可用 `STUDYORBIT_DEEPTUTOR_WEB_PORT`、`STUDYORBIT_DEEPTUTOR_API_PORT` 改。
- **数据：** 各检出自己的 `.local/deeptutor/`（git 忽略；会话、记忆里会有成绩）。
- **密钥：** DeepTutor 拿不到密钥。它只拿到回环代理的地址和每次启动新生成的令牌，代理（`server/llm-proxy.ts`）加上密钥转发给 DeepSeek。没有用 DeepTutor 的 `api_key_env`，因为它会把密钥明文写进自己的配置文件（#542）。
- **防护：** `scripts/deeptutor/guard_app.py` 包在 DeepTutor 接口外面，拒绝外站 Host、Origin 和跨站请求（HTTP 和 WebSocket）。以你的身份运行的本机程序仍能直接调它。
- **课程数据：** DeepTutor 注册的 MCP 是 `scripts/mcp-server.mjs --page-context`。页面把已选课程、当前课程和规划快照存到 `.local/agent-context.json`，只有带这个参数的 MCP 读它；Claude Code 等其他 MCP 客户端行为不变。页面上的修正仍然不给助手（#297 的旧决定没动）。
- **不代做：** 没装 `solve` 模块，加一个每轮注入的规则技能（`scripts/deeptutor/skill/SKILL.md`）。这是提示词规则，不是硬保证。代码执行、联网搜索、更新检查已关；`web_fetch` 和 `github` 在 1.7.4 里关不掉。
- **没有知识库：** 没有向量化（embedding）服务的密钥。

## 未验证（重要）

- **你自己的浏览器还没打开过这一轮的任何改动。** 全部验证都在本机无头 Chrome、合成课程、第二套端口上做；Safari、Firefox、iOS 没开过。
- **你的真实 DeepTutor 实例只做过健康检查**（2026-11-24：`node scripts/dev.mjs` 在主检出起来，五个端口正常、MCP 连上、守卫生效），没有打开页面、没有调模型。那次验证在 #298 之前；之后的版本没有确认在真实端口上再起过。
- **桌面快捷方式没有真的双击过**，只读了脚本并用等价命令在第二套端口跑过。
- **新版同步仍然只在合成数据和假模型上测过。** 唯一一次真实同步（2026-10-30）不完整；#285 的修复、v2 提示词、引文核对、断点续跑、变更记录、三方合并都没有真实验证。只有真实同步才产生的页面状态（冲突、变更提醒、同步失败的行）在 11-24 的走查里也只读了代码。
- 助手只支持 DeepSeek；OpenAI 兼容和 Anthropic 没有接到 DeepTutor。课程分析仍支持四家，但后三家的真实调用自 v2 起没有复验。
- 装了 `knowledge` 模块时守卫的那一支只用等价的 FastAPI 结构测过。
- 评估的「准确率」是和一份未经核对的早先模型输出比，不是真值。
- MCP 从 Claude Code / Claude Desktop 实际接入；Chrome 实机采集、其他学校 Canvas、Ed 美区/欧区、Windows/Linux。

## 下一步

1. **用户：** 双击桌面快捷方式，确认页面和 Agent 页都起来；在 Agent 页问一个课程问题（约 3–6 万 token）。第一次打开时主题会按系统走（见 #501 的代价）。
2. **用户：** 复核这一轮的自主决定 #500–#594。重点：#501 主题迁移、#511 删五套配色（推翻 #228）、默认背景改纯色（推翻 #233 的一半）、#532 去掉三种入场动画、#542 密钥走代理、#544 端口防护、#585 复习笔记不能新存、#591 没改的十条。
3. **用户：** 开好 Edge、登录 Canvas 后做一次真实同步，仍是 10-31 留下的头号未验证项。
4. **Claude（等你点头）：** #591 第 1 条，让 DeepTutor 的框架常驻（要改 #548 和规格）；复习笔记补一个新存的入口。
5. edstem-cli PR #18 合并后做 10-29 清单剩下两条。

## 等用户决定

- 向量化服务：给了才能建知识库（课程文件进 DeepTutor）。
- `web_fetch`、`github` 关不掉，是否可接受。
- 两个 DeepTutor 上游缺陷要不要上报：DeepSeek 的 chat-completions 格式在第二轮工具调用报 400（现在用 Responses 格式绕过）；没装 `knowledge` 模块时页面发不出消息（守卫代答空列表绕过）。
- 每个问题 3–6 万 token 是否可接受（旧的自建工具模式平均约 6,700 输入 token，两者没在同一批题上比过）。
- 选中行、悬停底色照 Codex 不到 3:1，是否加深；输入框边比 Codex 深。
- 主检出 `.local/chat/` 里的旧对话文件已没有代码读，留还是删。
- 10-31 留下的：对话是否包含页面修正；GitHub 上 `main` 没开分支保护。

## 运行与验证

- `npm ci`；`bash .claude/check.sh`（= `npm run check`，与 CI 相同）；`npm run dev`（页面 5173，你的浏览器数据在这个端口，不要换；本地接口 `127.0.0.1:5190`；DeepTutor 5175 / 5195 / 5197）。
- 第二套：`STUDYORBIT_WEB_PORT=5181 STUDYORBIT_API_PORT=5191 npm run dev`（DeepTutor 自动用 5185 / 5196 / 5199），不要用 `--port`。
- **不要随手点「立即同步」或保存选课**：会真用 Edge、Ed 和模型额度。复习页的预设按钮会向 DeepTutor 发消息，一次约 4–8 万 token。**打开 Agent 页本身也会调模型**（DeepTutor 每次加载会要输入建议，约 1,000 token）。
- 用合成数据看页面：在仓库外开 worktree，`.local/lms/courses.json` 写合成课程清单（课程 ID 必须是数字），课程文件放到临时 `HOME` 下的 `Desktop/<学校的课程文件夹>/<课程代码>/分数结构.json`，用临时 `HOME` 加第二套端口启动；合成课程在 `test/fixtures/qa/`。截图用独立的临时浏览器，种子写 `studyorbit.canonical-reset-v1=done` 和 `studyorbit.selected-course-ids`。
- 合并：先确认 PR 最新提交的 CI 结论是成功，再 `gh pr merge N --squash --delete-branch`，合并后再查一次 PR 状态。

## 陷阱

- 仓库公开：个人成绩、Cookie、密钥、本机路径不能入库。推送前扫「数字/数字」分数写法。
- 本机 shell 设了 `NODE_DEBUG=http,https,net,tls`；跑测试和服务器前加 `NODE_DEBUG=`。
- `gh pr checks N | tail && gh pr merge` 这种写法里，管道的退出码是 `tail` 的，CI 没查到也会合并（11-24 的 #296 就这样合了，事后核对那次提交的 CI 是成功的）。分开两步写。11-24 当晚 `gh` 的 GraphQL 请求多次返回 EOF，合并要重试并核对状态。
- 换配色令牌：每个颜色只在 `:root` 写一次 `light-dark(浅, 深)`，测试不许重复声明、不许写死颜色；半透明底色不叠加（#521）。
- 样式表里 `:is()`、`:where()` 的参数里不能放伪元素（会整个不匹配），有测试守着。
- DeepTutor 升级前先看：`scripts/deeptutor/prepare_web.py` 用了它的私有函数；守卫靠 Starlette 路由的 `matches`；规则技能装在 `data/user/workspaces/<id>/skills/`。
- 子代理停进程必须按核实过的 PID；11-24 有三次没做到（一次杀了没核实的 PID，一次 `pkill -P`，一次按 `pgrep` 的结果杀），事后看都是它自己的进程。
- git worktree 里不要把整个 `node_modules` 链接过去再跑 `npm run dev`（Vite 的依赖缓存会在主目录重建）；新建 `node_modules` 目录、逐个包建链接。`.gitignore` 的目录规则不匹配符号链接，提交按文件名暂存。
- `sync-usage` 靠 `.local/lms/runs/*` 目录创建时间：移动数据用 `mv`，不要 `cp`。
- 5174 端口被本机别的进程占用。同一项目只能跑一个本地服务（`.local/server.lock`）。
- `.agents/`（Codex 的 OpenSpec 技能副本）不提交；`interview-prep/` 是用户的学习资料，不动、不提交。
