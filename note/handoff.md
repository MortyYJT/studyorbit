# 交接

> 单文件，只写当前状态，覆盖不追加。信任之前先对照 `git status`、`git log`、`gh pr list`。决定看 `note/decisions.md`（#1–#240）。

- **最后更新：** 2026-10-30，Claude。
- **主线：** `main` 含 PR #245（期末需要、复习页、添加任务）、#246（每周计划）、#247（全局清理，#239）；规则精简为单一文件 `CLAUDE.md`（#241）。
- **项目是什么：** StudyOrbit（仓库 `MortyYJT/studyorbit`，本地 `origin` 已指向新地址），本地优先的墨大课业原型。Edge 已登录会话发现 Canvas 课程 → 脚本采集 Canvas / Ed / Handbook → 模型整理成课程 JSON（`shared/course-data.ts` 校验）→ 网页展示成绩、计划、复习、Agent 对话。本地接口只在 Vite 开发服务器（`vite.config.ts`）。
- **OpenSpec：** 进行中的 change：`course-contract-v2`（课程 JSON v2）。第 1 部分（v2 存盘 Schema、兼容读取）已合并（PR #259）。第 2 部分（模型输出 v2 接入同步：Handbook 考核项解析、引用校验、代码生成 ID、回填截止/得分/状态、`legacyIds`、存盘写 v2；分支 `claude/contract-v2-sync`）已开 PR 待审查合并，决定 #300–#305；引文核对、本地键迁移、「无出处」显示和评测按平台身份配对在第 3 部分，见其 `tasks.md`。合并后新同步写 v2，页面仍按 v1/v2 兼容读取；本地修正要等第 3 部分迁移才会跟到新 ID。
- **现行规格：** 在 `openspec/specs/`（`grade-target`、`revision`、`weekly-plan`）。进度表在 `note/product/roadmap.md`。

## 已完成

- **期末需要（#235）：** `finalNeeded()`，按 100 − 已出分占比算剩余平均需要多少；已稳 / 无法达到；每门课记住目标档；注明未识别权重。测试 `test/grade-target.test.ts`。
- **复习页（#236）：** 考试信息；三个预设提示词按钮（点击才发送，用模型额度）；单课程对话里完成的回复可「存到复习」，存 `.local/revision/notes.json`（0600），接口 `/api/local/revision-notes`。读不了文件时拒绝写入，避免覆盖。测试 `test/revision-store.test.ts`、`test/agent-request.test.ts`。
- **添加任务：** 校外任务（不选课程）也可以；存在原来的 `coursework.local-planning.work.v1`。
- **每周计划（#237，PR #246）：** `shared/planning.ts` 截止最早先排，从今天往后、按每天可用时间拆分到多天，按整分钟、最多排一年；排不下和已过截止列进「需要你处理」；周视图和月历显示同步来的截止日期（含你的修正）；任务可记已用时间和完成。测试 `test/planning.test.ts`。
- **清理（#239）：** 删了 6 份过时文档和约 130 条死 CSS 规则（13 个页面状态 × 6 种主题和背景组合，逐元素对比新旧计算样式，0 差异；同步弹窗和选课弹窗没测，因为打开会触发真实同步）；README、overview、scripts/README、OpenSpec 项目背景按代码重写；品牌名改为 StudyOrbit。
- **验证：** `npm run check` 13 个文件、89 个测试通过；两份 PR 都经新上下文子代理两轮审查；无头浏览器用合成任务验证了桌面和 390 px 手机宽度。

## 未验证

- 预设提示词发出后的真实模型回复、真实回复「存到复习」（测试里拦截了对话请求，没花额度）。
- 「7 天内截止但没排期」这一行在真实数据上没出现过（当前 7 天里没有符合条件的考核）。
- 四家模型真实调用、真实同步、Safari / Firefox（同上一次交接）。

## 下一步

1. 你：打开 `localhost:5173`，在复习页点一个预设按钮，确认对话正常，把一条回复「存到复习」。
2. L0/L1/L2（#238 先不做）：以后做时先定方案；Claude 的立场是执行器只在合成演示课程上跑。
3. 小问题（未排期）：`RichText` 遇到「标题 + 列表」混在一段时列表符号原样显示。

## 等用户决定

- 对话是否要包含页面上的修正（现在只用同步原件）。

## 运行与验证

- `npm ci`；`npm run check`；`npm run dev`（端口 5173，你的浏览器数据在这个端口，不要换）。
- **不要随手点「立即同步」或保存选课**：会真用 Edge、Ed 和模型额度。复习页的预设按钮也会发消息、用额度。
- 截图验证用独立临时浏览器（taste-skill `scripts/lib/cdp.mjs`），写入 `coursework.canonical-reset-v1=done` 和 `coursework.selected-course-ids`；要验证对话入口时拦截 `/api/local/chats` 的 POST。

## 陷阱

- 仓库公开：个人成绩、Cookie、密钥、本机路径不能入库。推送前扫「数字/数字」分数写法。
- git worktree 里给 `node_modules`、`.local` 建符号链接时，`.gitignore` 的目录规则不匹配链接，提交只按文件名暂存。
- 本机 shell 设了 `NODE_DEBUG=http,...`，跑测试和服务器时用 `NODE_DEBUG=`。
- `sync-usage` 靠 `.local/lms/runs/*` 目录创建时间：移动数据用 `mv`，不要 `cp`。
- 5174 端口被本机别的进程占用，第二个开发服务器用别的端口。
- 规则以 `CLAUDE.md` 为准（#241）：Claude 开发并合并；大改动先写 OpenSpec；逻辑用 TDD；合并前新上下文审查；只有设计选择先问用户。
- 下一阶段任务清单在用户桌面「StudyOrbit待办」，做完一条勾一条。
