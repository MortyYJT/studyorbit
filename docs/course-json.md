# 课程 JSON 契约 v1

每门课一份 JSON，编码 UTF-8。agent 判断课程信息并输出此结构；代码校验和处理，不按课程代码或标题猜测语义。定义以 `shared/course-data.ts` 为准。以下为虚构例子，不是用户课程数据。

```json
{
  "version": 1,
  "course": { "id": "123", "code": "ABCD10001", "name": "Example", "term": "2026 Semester 2" },
  "assessments": [
    { "id": "canvas:42", "name": "Project", "kind": "assignment", "nature": "regular", "parentId": null, "weight": 30, "score": null, "maxScore": null, "due": null, "status": "unknown", "scoring": "points", "rule": null, "sources": [{ "platform": "canvas", "url": "https://example.com/course/42", "evidence": "Project is worth 30%." }] },
    { "id": "ed:99", "name": "Part 1", "kind": "assignment", "nature": "regular", "parentId": "canvas:42", "weight": null, "score": 8, "maxScore": 10, "due": "2026-09-01 17:00", "status": "graded", "scoring": "none", "rule": null, "sources": [{ "platform": "ed", "url": "https://example.com/lesson/99", "evidence": "Part 1 belongs to Project." }] }
  ],
  "materials": [{ "name": "Lecture notes", "url": "https://example.com/notes", "platform": "canvas" }]
}
```

## 分类规则

`kind` 描述考核是什么；`nature` 描述它怎样计分。两者独立，练习测验仍是 `quiz`，只需将 `nature` 设为 `ungraded`。架构图中的“不计分”因此通过性质表达，不丢失原始类型。

| kind | 适用内容 |
| --- | --- |
| `quiz` | 测验、每周 quiz |
| `assignment` | 作业、论文、报告、项目及其部分 |
| `test` | 期中、期末等考试或 test |
| `presentation` | 演讲、展示、表演 |
| `participation` | 出勤、课堂参与、workshop 参与 |
| `hurdle` | 与已有考核不重合的独立通过门槛 |
| `other` | 无法归入以上类型的项目 |

`nature` 分别为 `regular` 普通考核、`ungraded` 不计分、`bonus` 加分和 `alternative` 替代版本。替代考试仍是 `test`；附属于现有考核的 hurdle 写在该项 `rule`，不再建立重复条目。根据课程实际含义判断，而不是只靠名称或固定关键词。

展示顺序为测验、作业、考试、展示、参与、独立 hurdle。正权重的参与项直接展示；不计分、0% 和没有权重的普通参与项，以及替代版本，统一折叠到“其他项目”。父项和子项保持原有关系；用户可调整分类和归属。

- `id` 在相同课程、学期的后续同步中保持稳定，优先使用平台及原始 ID；同一考核的多个来源合并到 `sources`，不要用顺序或名称作为 ID。`parentId` 为同一文件内的父项 ID；目前支持一层父子，不形成循环。
- `weight` 是课程百分比；`score` / `maxScore` 是得分与满分。未知写 `null`，不是 0。`due` 是来源可确认的时间原文，不能用提交时间或可用截止冒充；不要求假造时区。
- `nature` 区分正常考核、不计分、加分和替代版本；加分得分不自动当成课程百分比。`kind` 中 `hurdle` 是独立门槛；属于已有考核的门槛写在该项 `rule`。
- `scoring` 描述父项：`points` 表示根据子项分值合计，`weighted` 表示子项各有明确课程权重，`none` 表示不自动汇总。没有依据不要猜测规则。子项 `scoring` 为 `none`。
- `sources` 保留平台链接和判断依据；agent 应结合上下文直接作判断，例如能判断 points 与课程占比的关系时直接填写，同时保留依据。无法判断才留空。`materials` 只留名称和链接，不下载。
- 用户编辑、新增、排序保存在独立覆盖层，按课程 ID + 考核 ID 合并；同步不覆盖修改。手动移除是隐藏覆盖，不删来源数据。来源结果与覆盖层都不放入 Git。
