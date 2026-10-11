# Ed 实地调研（2026-10-11）

> Claude 用应用内置浏览器、在用户登录后只读浏览得出。真实课程代码、课程 id、帖子内容和同学姓名都不写在这里。

## 页面和接口
- 网页在 `edstem.org/au/...`，接口在同域 `edstem.org/api/...`（AU 区）。登录后页面用 `/api/user`、`/api/renew_token` 维持会话。
- 每门课的栏目因课而异：有的有「讨论 / Lessons / Workspaces」，有的只有「讨论 / Resources」。不能假定每门课都有 Lessons。
- 用到的接口（都是 GET）：
  - `/api/courses/{id}/lessons`：所有 lesson 的元数据。字段含 `title`、`kind`（`attempt` 是作业，`content` 是普通课件）、`due_at`、`effective_due_at`、`available_at`、`locked_at`、`solutions_at`、`status`（completed / attempted / unattempted）、`submitted_at`、`module_id`、`late_submissions`。时间带时区（ISO 8601）。
  - `/api/lessons/{id}?view=1`：单个 lesson 和幻灯片列表。
  - `/api/lessons/slides/{id}?view=1`：单张幻灯片，正文是 Ed 自己的 XML（`<document version="2.0">…`）。
  - `/api/courses/{id}/threads?limit=30&sort=new`：讨论帖列表，分页加载。
  - `/api/courses/{id}/resources`：资源列表。
- 网页打开幻灯片时带 `view=1`，会把它记成已读或已完成。抓取不能带这个参数（待实测：不带时接口是否照常返回）。

## 截止日期
- 作业 lesson 的截止日期就在 `due_at` / `effective_due_at`（个人延期后的值可能在 effective 字段里，待确认）。界面上显示成「截止日期: Fri October 23rd, 11:59pm」，同一门课的讨论区里也有学生问「Ed 和 LMS 上的截止日期不一致」，所以要两边都存并标出差异。

## 隐私
- 讨论帖列表里有同学的真实姓名（非匿名帖），存进 `.local/` 可以，进模型前必须去掉（红线）。

## 鉴权和课程列表（2026-10-11 第二次核实，只看状态码和字段名）
- **只带 cookie 不够**：页面里同源 `fetch('/api/user')` 返回 401。Ed 的网页把登录后拿到的会话令牌存在 `localStorage` 的 `authToken:<region>`（AU 区是 `authToken:au`），每次请求放进 `x-token` 请求头；带上后返回 200。用 `Authorization: Bearer` 返回 400。
  - 这个令牌是 Ed 登录后发给浏览器的会话令牌，不是用户自建的 API 令牌（红线禁止的是后者）。实现时代码在页面里读取并附加它：不打印、不写日志、不存进快照、不返回给模型。
- **课程列表在 `GET /api/user`**：顶层字段 `courses`、`realms`、`user`、`push_key`、`push_subscriptions`、`time`；`courses[]` 每项是 `{course, role, lab, last_active}`，`course` 有 `id`、`code`、`name`、`year`、`session`、`status`。本学期 3 门课都是 `year` 2026 + `session` "Semester 2" + `status` "active"，可以作为「当前学期」的依据。
  - 这个响应里还有用户本人的信息和推送订阅（`user`、`push_key`、`push_subscriptions`），**不能原样存成快照**，只存 `courses`（去掉 `role.digest` 这类个人设置也可以）。
- **不带 `view` 也能读**：`GET /api/lessons/{id}` 不带 `view=1` 返回 200。

## 未核实
- 登录会话能保持多久、是否触发 MFA（5.5 要记录）：本次没测。
