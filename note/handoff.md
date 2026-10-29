# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。决定看 `note/decisions.md`（#1–#234）。

- **最后更新：** 2026-10-29，Claude。
- **主线：** `main` 已包含 v2 整合（PR #242，merge commit `1679e60`）与动画、背景（PR #243，`61ddbc2`），两次 CI 都通过。当前分支 `claude/docs-refresh`（README、About、本交接）。
- **项目是什么：** StudyOrbit（仓库与包名 `study-orbit`，#234），本地优先的墨大课业原型（原桌面 v2）。Edge 已登录会话发现 Canvas 课程 → 脚本采集 Canvas / Ed（`edstem` CLI）/ Handbook → 用户选的模型整理成课程 JSON（`shared/course-data.ts` 校验）→ 网页展示成绩、计划、Agent 对话。本地接口只在 Vite 开发服务器（`vite.config.ts`）。

## 已完成（都在 `main`）

- **整合（#223–#227、#232）：** v1 代码移出主线（Git 历史可查，本地另有 `archive/v1/`）；v2 代码并入，v2 的 75 个提交历史在逐个去掉个人成绩、三份私人实验记录和本机路径后以 ours 合并接入；死代码（v1 协议客户端、`shared/` 旧契约）已删；加 vitest，`npm run check` = 类型检查 + 测试 = CI。
- **配色（#228）：** 墨 / 雾蓝 / 松 / 石 / 谷鱼（取自 mortyyjt.github.io），各有浅深色，一键切换；`--accent` 只用于主按钮、今天、已得环、占比条、同步进度。
- **模型选择（#229）：** DeepSeek / OpenAI 兼容 / Anthropic / Codex；设置存 `.local/config/llm.json`（0600，密钥只写）；环境变量作后备；不会把密钥发给别的提供方或别的地址；未知提供方直接报错。
- **Agent 对话（#230）：** `/api/local/chats*`（SSE 流式、停止、删除），对话存 `.local/chat/<uuid>.json`；上下文是已选课程同步数据摘要（不含页面修正）；系统提示只允许讲解和规划，不代做不提交；课程页「问 Agent」。
- **安全：** 所有 `/api/local/*` 拒绝外来 Origin（含 GET），`server.cors: false`；同一对话并发发送互斥，关页即中止模型。
- **动画与背景（#233）：** 默认渐变背景，可选纯色或上传图片（浏览器内压缩存 IndexedDB，不上传；可调可见度、模糊、卡片不透明度）；页面过渡、滑动选中块、成绩环与数字动画、列表依次出现、折叠平滑、弹窗与抽屉进出、对话消息动画；尊重「减少动态效果」。
- **测试：** 9 个文件、68 个测试（成绩计算、配色、模型配置与适配器、对话上下文 / 存储 / 防护 / 流式解析、背景设置）。
- **分支：** 本地和远端只剩 `main` 与当前工作分支；删掉的分支打包在 `archive/deleted-branches-20261029.bundle`（本地，含改写前的成绩备份，不推送）。

## 未验证

- 四家模型的真实调用（「测试连接」、同步分析、对话）都没跑过；DeepSeek Responses 流式事件名与 Codex 真实输出最不确定。
- 真实同步（「立即同步」、保存选课）在 v2 并入本仓库后没跑过。
- Safari、Firefox、真机流畅度。
- Codex 只读沙箱仍能读本机文件，对话里只靠提示词约束它只用课程数据。

## 下一步

1. 用户：设置里配好模型，点「测试连接」，在 Agent 页发一句话，确认真实调用可用（会花少量额度）。
2. 视结果修模型适配器（真实流式事件、错误信息）。

## 等用户决定

- 对话是否要包含用户在页面上的修正（现在只用同步原件）。

## 运行与验证

- `npm ci`；`npm run check`；`npm run dev`（端口 5173；用户浏览器的选课、修正、计划存在这个端口的 localStorage，端口不要换）。
- **不要随手点「立即同步」或保存选课**：会真的用 Edge、Ed 和模型额度（保存选课会立刻开始同步）。
- 截图验证用独立的临时浏览器（taste-skill 的 `scripts/lib/cdp.mjs`），写入 `coursework.canonical-reset-v1=done` 和 `coursework.selected-course-ids`（取 GET `/api/local/course-reports` 的 id）后读真实课程报告；不要碰用户浏览器的数据，不要在测试里发对话消息。

## 陷阱

- 仓库公开：个人成绩、Cookie、密钥、本机路径不能入库。文档里的分数写法（如「数字/数字」）推送前要扫。
- 课程 JSON 在 `~/Desktop/墨尔本大学 <年> S<学期>/<课程代码>/`，不在仓库里。
- `sync-usage` 接口靠 `.local/lms/runs/*` 目录的创建时间还原旧批次：移动数据用 `mv`，不要 `cp`。
- `verify.sh` 在工作区不干净时要求 `.claude/check.sh` 通过才允许结束回合；子代理改到一半时会报错，属正常。
- 本机 shell 设了 `NODE_DEBUG=http,...`，跑测试和服务器时用 `NODE_DEBUG=` 清掉，否则日志刷屏。
- `guard.sh` 会拦截带变量路径的 `rm -rf`；临时目录换新名字即可。
- 删分支、改写历史前先打包备份；合并保留历史的 PR 要用 merge commit，不能 squash。
