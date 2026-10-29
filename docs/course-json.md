# 课程 JSON 契约 v2

字段定义和本地校验以 `shared/course-data.ts` 为准；设计细节见 `openspec/changes/course-contract-v2/design.md`。每门课程每次同步写一份 `分数结构*.json` 到桌面课程文件夹；字段未知使用 `null`，不要用 0 代替未知。

契约分两层：**模型输出**只写判断（分组、分类、权重、规则和它们的引文、引用了哪些平台条目）；**存盘文档**由代码在模型输出上补齐 ID、截止时间、分数、状态和来源链接，再核对引文。日期、分数和状态从不由模型填写（决定 #208）。

## 模型输出

模型返回外层 `{ status, reason, document }`：状态为 `completed`、`partial` 或 `failed`；`reason` 简短说明关键缺失，无缺失时为空字符串；`failed` 的 `document` 为 `null`。`document` 符合 `CourseModelOutputSchema`：

- `version: 2`；`course`（ID、代码、名称、学期，ID 与代码必须与输入一致）；`materials`（资料名称和链接，不下载文件）。
- `assessments[]` 每项只有下表字段。Schema 是严格的：写了 `id`、`parentId`、`due`、`score`、`maxScore`、`status` 或 `sources` 就校验失败，进入一次修复。

| 字段 | 含义 |
| --- | --- |
| `key` | 本次输出内唯一的任意字符串 |
| `parentKey` | 顶层为 `null`；子项指向顶层项的 `key`，最多两级 |
| `refs` | 依据：`{ platform, id }`，`canvas` 填 Canvas 作业 ID，`canvas-group` 填作业分组 ID，`ed` 填 Ed lesson ID，`handbook` 只能填提示里 `handbookComponents` 列出的考核项名 |
| `name` | 名称 |
| `kind` | `quiz`、`assignment`、`test`、`presentation`、`participation`、`hurdle` 或 `other` |
| `nature` | 普通 `regular`、不计分 `ungraded`、加分 `bonus` 或替代版本 `alternative` |
| `scoring` | 父项按分数合计 `points`、按明确权重合计 `weighted`，或不自动合计 `none`；子项为 `none` |
| `weight`、`weightQuote` | 占课程总分的百分比（不是原始分），以及证明它的逐字原文 |
| `rule`、`ruleQuote` | 简短的计分或通过规则，以及证明它的逐字原文 |

提示里另给两样由代码算出的数据：Handbook 考核表解析出的 `handbookComponents: [{ name, percent }]`，以及每个 Canvas 分组的 `rulesText`（把数值规则写成 `drop lowest 2`、`drop highest 1`、`never drop <作业名>`，多条用 `; ` 连接）。

## 引用校验

`validateAnalysis`（`scripts/lib/course-validation.mjs`）在 Schema 之外检查下列问题，任何一条都算校验失败，使用唯一一次修复；修复后仍失败则不保存：

- 引用必须存在于采集数据：Canvas 作业 ID、分组 ID、Ed lesson ID 按字符串比较；Handbook 名称规范化（见「引文核对」）后必须与某个解析出的考核项名完全相等，存盘时改用规范名称。某个来源没采集到时，引用它一律无效。
- 同一 Canvas 作业或 Ed lesson 只能被一个考核项引用；分组和 Handbook 引用可以重复。
- 没有任何引用的考核项必须有子项（纯分组）。
- `key` 唯一；`parentKey` 存在、不成环、只有一层。
- `points`/`weighted` 只用于有计分子项的顶层父项；`weighted` 要求每个计分子项都有正权重。
- 生成的 ID 不重复，且不超过 500 字符。

问题写成 `assessments.<序号>.refs.<序号>: 「名称」引用的 ...`，修复提示能直接指到出错的项。

## Handbook 考核项

Handbook 采集只保存页面文字。`parseHandbookComponents`（`scripts/lib/course-refs.mjs`）按行读取：一行按制表符分格；最后一格是百分比（如 `30%`）或 `N/A`、`Nil`、`-`、`—` 的行是一行考核的结尾；含 `Percentage` 格的是表头。一行考核从上一行结尾或表头之后开始，到结尾行为止，所以多行描述会并在一起。名称取第一格的第一行，`percent` 取最后一格的数字（没有则为 `null`），行原文把制表符和换行折成单个空格。按学期重复出现、名称和百分比都相同的行合并为一项；名称相同、百分比不同的依次加 ` (2)`、` (3)`。Handbook 已采集但一项也解析不出时，Handbook 引用全部无效，课程最多 `partial`，原因注明「Handbook 考核表未能解析」。

## 存盘文档

`CourseDocumentSchema` 接受 `version: 1` 和 `version: 2`，其他版本无效。v2 在 v1 每个考核的字段上增加 `refs`、`weightQuote`、`ruleQuote`、`unsourced`，顶层增加 `legacyIds`：

| 字段 | 来源 |
| --- | --- |
| `id` | 代码生成，见下节 |
| `parentId` | `parentKey` 对应项的最终 ID |
| `name`、`kind`、`nature`、`scoring` | 模型输出（`scoring` 可能被引文核对降为 `none`） |
| `weight`、`rule` | 模型输出，核对不通过时清为 `null` |
| `due`、`score`、`maxScore`、`status` | 代码从主 Canvas 作业和主 Ed lesson 回填 |
| `sources` | 代码按 `refs` 生成：Canvas 作业链接、Ed lesson 链接、Handbook 页面链接；Canvas 分组记为 `platform: 'canvas'`、`url: null`；`evidence` 一律为 `null` |
| `refs` | 规范化、去重后的引用 |
| `weightQuote`、`ruleQuote` | 只保留核对通过的引文，否则为 `null` |
| `unsourced` | 被引文核对清空的字段名：`weight`、`rule` |
| `legacyIds`（顶层） | 上一份文档的旧 ID → 新 ID |

v1 的约束对 v2 同样成立：ID 唯一、得分不超过满分、父项存在且只有一层、不成环。另外：同一项的 `refs` 和 `unsourced` 不重复；列入 `unsourced` 的字段及其引文必须为 `null`；字段为 `null` 时引文也必须为 `null`。

### ID 生成

取 `refs` 中优先级最高的平台：Canvas 作业 → Ed lesson → Canvas 分组 → Handbook → 无。

| 依据 | ID |
| --- | --- |
| Canvas 作业 | `canvas:<id>` |
| Ed lesson | `ed:<id>` |
| Canvas 分组 | `canvas-group:<id>` |
| Handbook 考核项 | `handbook:<slug(规范名称)>` |
| 无引用（纯分组） | `group:<slug(名称)>` |

`slug` = NFKC、小写、每段非字母数字字符换成一个 `-`、去掉首尾 `-`，空则为 `item`。同一平台有多个引用时取 ID 最小的（纯数字排在前面并按数值，其余按码点），所以 ID 不随模型列出的顺序变化。Canvas 分组、Handbook 和纯分组的 ID 可能被多项共用；共用时每一项都改为 `<基础 ID>:<slug(名称)>`。

### 事实回填

- `due`：Canvas `due_at`，否则 Ed lesson `due`，否则 `null`。
- `score`/`maxScore` 成对取自同一来源：Canvas 已出分 → Canvas 得分和 `points_possible`；否则 Ed 已出分 → Ed 得分和满分；都没出分 → 得分 `null`、满分取 Canvas `points_possible`。得分超过满分（额外加分）时保留得分、满分置 `null`。
- `status`：各来源中最靠前的一个，`graded` > `submitted` > `not_started` > `unknown`。Canvas：`graded`→已出分，`submitted`/`pending_review`→已提交，`unsubmitted` 且无提交时间→未开始；Ed：`graded`→已出分，`not_available` 且有提交时间→已提交，`no_final_submission`→未开始。代码不产生 `in_progress`（v1 文件里可能有）。
- 只引用 Canvas 分组、Handbook 或没有引用的项：截止、得分、满分为 `null`，状态 `unknown`；父项成绩仍由页面按子项计算。

### 引文核对

`verifyQuotes`（`scripts/lib/course-quotes.mjs`）在校验与修复之后、保存之前运行，不触发修复（决定 #247）。

- **规范化**（引文和语料相同）：去 HTML 标签，解码 `&amp; &lt; &gt; &quot; &#39; &nbsp;` 和数字实体，NFKC，小写，弯引号统一为直引号，各种横线统一为 `-`，所有空白（含制表符、换行）折成一个空格。
- **语料单元**：Handbook 考核表每一行（行原文）、Handbook 其余每个非空行、每段 Ed context 文本、每个 Canvas 分组名和分组规则文本。Canvas 作业名、Ed lesson 标题、链接、ID 不在语料里。引文必须落在单个单元内，规范化后长 6–500 字符。
- **权重**有出处的条件，满足任一即可：所引 Canvas 分组的 `group_weight` 等于权重（保留两位小数比较）；所引 Handbook 考核项的百分比等于权重；引文落在某个单元里，且含有与权重相等的独立数字（不与其他数字或小数点相连），后跟 `%`、`per cent` 或 `percent`——引文落在 Handbook 考核行里时还必须包含该行的考核项名。只有第三种情况保留 `weightQuote`。
- **规则**有出处的条件：引文落在某个单元里。
- **失败**：字段和引文置 `null`，字段名写进 `unsourced`，文档其余部分照常保存。清空子项权重后，若 `weighted` 父项有计分子项缺正权重，父项 `scoring` 改为 `none`。课程状态不变，`reason` 追加「N 项权重或规则无出处」。

页面在权重和规则旁显示「无出处」，对话上下文写作「权重无出处」「规则无出处」；你保存了修正值时页面改用修正值并不再显示该标记。

### 旧 ID 映射 `legacyIds`

v2 的 ID 与 v1 不同，而浏览器里的修正、手动考核的归属、学习任务和排序都按 ID 记录。同步保存前，`buildLegacyIds` 把同一课程上一份有效文档（v1 或 v2，按与页面相同的「最新有效文件」规则选取）与新文档配对：

1. ID 相同的先配对（不写映射），并排除在后续步骤外；
2. 按平台身份：v2 用 `canvas`/`ed` 引用；v1 从 `sources` 链接解析 Canvas 作业 ID（`/courses/<课程>/assignments/<id>`）和 Ed lesson ID（`/lessons/<id>`），以及形如 `<数字>`、`canvas-<数字>`、`canvas:<数字>`、`ed-<数字>`、`ed:<数字>` 的 ID（纯数字先按 Canvas、再按 Ed）；
3. 找不到任何平台身份候选的，按两边都唯一的名称 slug 配对；
4. 只保留一一对应的配对；
5. 上一份是 v2 时接续它的 `legacyIds` 并合成（`a → b`、`b → c` 得 `a → c`），目标已不存在的条目丢弃。

页面每次读取课程数据时，用 `shared/local-keys.ts` 的 `migrateLocalKeys` 把本机数据迁到新键（可重复执行，第二次不再变化）：修正的条目键 `<课程>:<id>` 和分组键 `<课程>:group:<课程>:<id>`、修正里的 `parent`/`mergeInto`、手动考核的 `parent`、学习任务键和排序列表。新键已有修正时保留新键的，旧修正原样留下不用；学习任务的新键已被占用时旧任务保留旧键；排序列表改写后去重。无法映射的旧数据（没有平台身份且名称不唯一、合并或拆分方式不同、已消失的考核、找不到上一份文档）原样保留，不再显示。

## v1 兼容

v1 文件不改写，照常读取。所有读取方（课程报告接口、课程页、对话上下文）都经 `toDisplayDocument` 转成同一种显示格式：v1 考核得到空 `refs`、`null` 引文、空 `unsourced`，v1 文档得到空 `legacyIds`，因此 v1 课程不会出现「无出处」。同一文件夹里有 v1 和 v2 时，仍按修改时间取最新的有效文件。

## 其他约定

权重只对有依据的考核填写，不用差额推算；子项和汇总项不得重复计入课程总分。已发布的提交得分是实际得分；不可读取不等于未提交或零分。用户编辑存于独立覆盖层，不由模型改写。
