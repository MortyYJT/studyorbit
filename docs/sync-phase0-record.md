# 第 0 阶段原始记录（2026-10-27，约 21 分钟）

[同步优化](sync-optimization.md) 里「阶段 0」的出处。两部分：当时写进 OpenSpec 变更的原文，和本机 v1 数据库里两次完整同步的时间记录。已去掉个人信息：没有成绩、Canvas 课程编号、内部课程 ID、账号和本机路径。

## 1. 原文摘录

来自 v1 的 OpenSpec 变更 `extension-course-list` 的 proposal（「Why」一节第一段，原文英文，未改动）：

> The last full sync (2026-10-27) took 21 minutes for four courses: 33 separate Codex jobs, each starting its own agent, opening and closing its own Edge window, and copying the page through computer use. The course list job alone cost about 200,000 input tokens and 4 computer-use steps. A layer-0 experiment on the owner's signed-in Edge read the same Canvas course list through a small browser extension in 233 ms (fetch) plus 2 ms (parse), with no model and no tab (decision #219).

v1 代码和这份变更已移出主线（决定 #223），只保存在本机。

## 2. 同步任务时间线

来源：v1 本机数据库 `sync_jobs` 表，2026-10-27 两次结果为 `OK` 的四门课完整同步（之前几次 20–60 秒、课程数为 0 的任务是空跑，不计）。时间是 UTC；「完成」取每门课结果的保存时间。

| | 第一次 | 第二次 |
| --- | --- | --- |
| 开始 | 05:04:08.6 | 09:27:07.2 |
| COMP20003 完成 | 05:08:24.4（+4 分 16 秒） | 09:32:18.6（+5 分 11 秒） |
| COMP20008 完成 | 05:12:53.5（+8 分 45 秒） | 09:36:27.1（+9 分 20 秒） |
| MAST10007 完成 | 05:20:17.3（+16 分 09 秒） | 09:41:09.5（+14 分 02 秒） |
| MUSI20163 完成 | 05:25:13.7（+21 分 05 秒） | 09:47:36.6（+20 分 29 秒） |
| 结束 | 05:25:13.7 | 09:47:36.6 |
| **总耗时** | **21 分 05 秒** | **20 分 29 秒** |

四门课串行，每门约 4 到 7.5 分钟。

## 3. 和后续阶段比较时要注意

- 两次运行的结果里，四门课 Canvas 一栏都记为 `absent`（没读到），MUSI20163 的 Ed 也是 `absent`。也就是说这 21 分钟并没有拿到完整数据，和后面阶段比的是「跑完一次同步」，不是「拿到同样多的数据」。
- 数据库没有记录 token。「课程列表约 20 万输入 token」只来自上面的原文，没有逐任务的用量日志可以核对；33 个任务的总 token 未记录。
- 运行机器同 [同步优化](sync-optimization.md#运行环境)。
