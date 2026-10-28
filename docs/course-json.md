# 课程 JSON 契约 v1

字段定义和本地校验以 `shared/course-data.ts` 为准。每门课程一份 JSON；字段未知使用 `null`，不要用 0 代替未知。

- `course`：课程 ID、代码、名称和学期；ID 与代码必须与输入一致。
- `assessments`：考核列表。一个实际考核只保留一次；多个来源合并到 `sources`。
- `materials`：采集结果中有用的资料名称和链接，不下载文件。

每个考核包含：

| 字段 | 含义 |
| --- | --- |
| `id`、`name` | 稳定 ID 和名称；优先使用平台 ID |
| `kind` | `quiz`、`assignment`、`test`、`presentation`、`participation`、`hurdle` 或 `other` |
| `nature` | 普通 `regular`、不计分 `ungraded`、加分 `bonus` 或替代版本 `alternative` |
| `parentId` | 顶层为 `null`；子项指向顶层 ID，最多两级 |
| `weight` | 课程总成绩中的百分比；不是原始分数 |
| `score`、`maxScore` | 已获得的分数和原始满分；bonus 的 `maxScore` 是上限 |
| `due` | 有依据的截止时间；不以提交时间或可用截止代替 |
| `status` | `not_started`、`in_progress`、`submitted`、`graded` 或 `unknown` |
| `scoring` | 父项按分数合计 `points`、按明确权重合计 `weighted`，或不自动合计 `none`；子项为 `none` |
| `rule` | 简短记录计分或通过条件；独立 hurdle 使用单独考核项 |
| `sources` | 来源平台、链接和简短判断依据 |

权重只对有依据的考核填写，不用差额推算；子项和汇总项不得重复计入课程总分。已发布的提交得分是实际得分；不可读取不等于未提交或零分。用户编辑存于独立覆盖层，不由模型改写。

模型返回外层 `{ status, reason, document }`：状态为 `completed`、`partial` 或 `failed`；`reason` 简短说明关键缺失，无缺失时为空字符串；`failed` 的 `document` 为 `null`。原生 Schema 约束字段形状，本地还会校验 ID、分数和父子关系。
