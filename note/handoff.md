# 交接

> 单文件，只写当前状态，每次任务结束整份重写。信任之前先对照 `git status`、`git log`、`gh pr list`。历史看 git，决定看 `note/decisions.md`。

- **最后更新：** 2026-10-30，Claude。
- **项目是什么：** StudyOrbit（`MortyYJT/studyorbit`），本地优先的课业助手。已登录浏览器读 Canvas / Ed / Handbook → 分阶段同步（采集 → 分析 → 校验 → 合并，检查点存 `node:sqlite`）→ 课程 JSON v2 → 网页（独立本地服务 + Vite 代理）展示成绩、计划、复习、工具调用式对话；同一套只读工具也作为 MCP 服务开放。
- **主线：** `main` 含到 #290。本地 `npm run check` 68 个文件、887 个测试通过，CI 绿色。没有打开的 PR，没有进行中的 OpenSpec change（现行规格 `openspec/specs/`，19 份）。
- **任务清单：** 用户桌面「2026-10-29-StudyOrbit待办」。除 edstem-cli 两条外全部打勾（上游 `bunizao/edstem-cli` PR #18 未合并）。
- **最近：** #285 同步失败写明原因、同步前检查浏览器和 Canvas 登录、采集不全不覆盖旧文件；#286 修了 `dev-launcher` 测试的偶发失败（替身脚本先装信号处理再写就绪文件）；#287 删除 `.claude` 钩子（用户决定以后不用钩子）；#288 删除学习用笔记 `note/interview/` 和 `note/resume-draft.md`（用户决定，git 历史里可找回）。
- **文档（10-30 精简，#289、#290）：** `docs/` 只剩 5 份英文文档：`overview.md`（结构、数据流、全部脚本）、`course-json.md`（契约和分析做法）、`sync-optimization.md`（同步实测，附录是原始记录）、`eval-course-analysis.md`、`eval-chat-qa.md`（各自方法加结果）；README 也改成英文。`note/` 保持中文：`handoff.md`、`decisions.md`（v1 的 #1–#222 已删，完整版在提交 `24621e3`）、`product.md`（定位、不做、以后的想法）。

## 未验证（重要）

- **新版同步只在合成数据和假模型上测过。** 唯一一次真实同步（2026-10-30）因为 Edge 没窗口、Canvas 登录过期而不完整；#285 的修复还没在真实同步里跑过。v2 提示词、引文核对、断点续跑、变更记录、三方合并同样没有真实验证。
- 评估的「准确率」是和一份未经核对的早先模型输出比，不是真值（`docs/eval-course-analysis.md`「Limits of the results」）。
- 真实 v1 → v2 键迁移、浏览器里的修正迁移（目前没有修正）。
- OpenAI 兼容和 Anthropic 的真实工具调用；DeepSeek「把推理放回下一轮」；经代理的真实流式对话。
- MCP 从 Claude Code / Claude Desktop 实际接入。
- Chrome 实机采集、其他学校 Canvas、Ed 美区/欧区、Windows/Linux。

## 下一步

1. **用户：** 拉代码后 `npm ci`（Node ≥ 24.15）；`npm run dev` 打开页面确认 4 门课正常显示。
2. **用户：** 开好 Edge、登录 Canvas 后做一次真实同步（会用 Edge、Ed 和 DeepSeek 额度），看新文件是不是 v2、「无出处」和变更提醒是否合理。出问题先看 `.local/lms/sync-errors/` 和页面「需要你处理」。
3. **用户：** 在页面上修正几条考核，再导出标准答案重跑评估，才有真正的准确率。
4. **用户：** 复核 Claude 自主决定 #254–#489（`note/decisions.md` 标「Claude 自主（待 MortyYJT 复核）」）。重点：#263 评估输入、#297 对话不接入修正、#313 `docs/course-json.md` 用中文、#330 MCP SDK 版本、#350 断点续跑只用假模型测、#420 取消会真的停掉脚本、#445 浏览器没开时报错不自动启动。
5. edstem-cli PR #18 合并后做清单剩下两条。
6. **Claude：** leapashore 也做同样的文档精简（用户已同意，等 StudyOrbit 这次看过效果）。

## 等用户决定

- 对话是否包含页面上的修正（#297 暂定不包含）。
- 以后评估的额度上限（问答评估一次约 138 万 token）。
- GitHub 上 `main` 没开分支保护；删掉钩子后，「不直接推 main」只靠规则。

## 运行与验证

- `npm ci`；`bash .claude/check.sh`（= `npm run check`，与 CI 相同）；`npm run dev`（页面 5173，你的浏览器数据在这个端口，不要换；本地接口 `127.0.0.1:5190`）。第二套开发服务器：`STUDYORBIT_WEB_PORT=5181 STUDYORBIT_API_PORT=5191 npm run dev`，不要用 `--port`。
- **不要随手点「立即同步」或保存选课**：会真用 Edge、Ed 和模型额度。复习页的预设按钮也会发消息、用额度。
- 截图验证用独立临时浏览器（taste-skill `scripts/lib/cdp.mjs`），写入 `coursework.canonical-reset-v1=done` 和 `coursework.selected-course-ids`；验证对话入口时拦截 `/api/local/chats` 的 POST。
- 合并：`gh pr checks N && gh pr merge N --squash --delete-branch`，CI 没过不能合。

## 陷阱

- 仓库公开：个人成绩、Cookie、密钥、本机路径不能入库。推送前扫「数字/数字」分数写法。
- 本机 shell 设了 `NODE_DEBUG=http,https,net,tls`，测试输出会混进大量 `NET ...` 日志；跑测试和服务器前加 `NODE_DEBUG=`。
- `.agents/`（给 Codex 的技能链接）没有提交，按用户决定保持不提交。
- git worktree 里给 `node_modules`、`.local` 建符号链接时，`.gitignore` 的目录规则不匹配链接，提交只按文件名暂存。
- `sync-usage` 靠 `.local/lms/runs/*` 目录创建时间：移动数据用 `mv`，不要 `cp`。
- 5174 端口被本机别的进程占用。
- 直接跑 `vite` 会报「请用 npm run dev 启动」：没有令牌就没有接口。同一项目只能跑一个本地服务（`.local/server.lock`）。
