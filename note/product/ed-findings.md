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

## 未核实
- 接口的鉴权方式（请求头里的 token 名称）没看；在页面里同源 `fetch` 能否直接带上会话，要在实现时验证。
- 登录会话能保持多久、是否触发 MFA（5.5 要记录）：本次没测。
