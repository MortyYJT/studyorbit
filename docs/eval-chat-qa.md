# 对话问答评测

用一套合成题集比较 Agent 对话的两种模式：**上下文模式**（工具调用之前的做法：系统提示里放整份课程数据，模型自己算）和**工具模式**（只给课程索引，成绩、权重合计、期末需要的分数和排期由 `shared/course-tools.ts` 的工具算）。同一模型、同一题集、同样的次数，每题都是一段全新的单条消息对话。

- 脚本：`scripts/eval-chat-qa.mjs`；评分：`scripts/lib/qa-grade.mjs`（纯函数）。
- 测试：`test/qa-grade.test.ts`（评分）、`test/qa-fixtures.test.ts`（题集和标准答案）、`test/eval-chat-qa.test.ts`（runner，用固定输出，不联网）。
- 题集全部是合成数据，只有它会发给模型；脚本不读同步得到的课程文件，也不碰桌面。
- 结果见 [评测结果](eval-results.md#对话问答改造前后)。

## 题集

在 `test/fixtures/qa/`：

| 文件 | 内容 |
| --- | --- |
| `SYNT10001.json` | 合成课程 v2 文档：按原始分合计的测验组、按权重加权的作业组（只出了一半分）、已出分的期中考试、替代方案、加分项、不计分的 hurdle、权重无出处的项目、带 hurdle 规则的期末考试 |
| `SYNT20002.json` | 合成课程，什么都还没出分 |
| `planning.json` | 计划快照：已过期任务、个人任务、排不下的任务，周三周日不可用，SYNT10001 保存的目标是 H2B |
| `context.json` | 今天 `2026-09-14`、课程列表（第三门 `SYNT30003` 没有同步数据）、默认范围、文档和快照文件名 |
| `questions.json` | 32 道题，中英文都有 |

每道题：

```json
{
  "id": "final-h1-en", "category": "final", "language": "en", "scope": ["qa-syn-1", "qa-syn-2", "qa-syn-3"],
  "question": "What average do I need on the rest of SYNT10001 to get an H1?",
  "gold": {
    "answer": "84.25% across the remaining 55%.",
    "numbers": [{ "value": 84.25, "source": { "tool": "final_needed", "args": { "courseId": "qa-syn-1", "target": "H1" }, "path": "neededAverage" } }],
    "facts": [], "forbidden": [], "refusal": false, "expectTools": ["final_needed"]
  }
}
```

- `category`：`lookup`（截止、得分、规则、近期截止）、`weight`（单项、组合计、已确认权重合计、无出处）、`grade`（平均、已得分、组得分、剩余权重、假设分数）、`final`（保存的目标、指定等级、达不到、已稳拿、未出分的课）、`schedule`（某天做什么、今天、排不下、已过期）、`refusal`（代写、代交、给测验答案）、`out-of-scope`（别的同学的成绩、天气）、`missing`（没出分的课、没同步的课）。
- `answer` 是参考答案，只给人看，不打分。
- `numbers`：必须出现的数字，`tolerance` 默认 0.1。`source` 是能算出这个数的工具调用和结果里的路径（点和方括号，如 `counted[0].earned`、`days.2026-09-17[0].minutes`）。`test/qa-fixtures.test.ts` 用工具注册表在题集上逐个重算并要求完全相等，所以标准答案写错或工具算法改了都会让测试失败。
- `facts`：每组至少出现一个写法。
- `forbidden`：出现任何一个就算错（例如拒绝题里泄露的答案）。
- `refusal`：为 `true` 时回答里必须有拒绝用语（见下）。
- `expectTools`：预期会用的工具，只记录，不打分。

## 评分规则

`gradeAnswer(answer, gold)` 只看回答文字和标准答案：

1. **调用失败**：模型调用出错或被停止，直接算错，并单独计入「调用失败」。
2. **规范化**：先去掉英文逗号形式的千位分隔符（`1,500` → `1500`；中文全角逗号不当千位分隔符），再做 NFKC（全角数字和符号变半角）、转小写、弯引号变直引号。
3. **数字**：从回答里取出所有不带符号的小数（日期 `2026-09-18` 会取出 2026、9、18），每个标准数字要有一个在容差内的数。
4. **关键事实和禁止内容**：去掉空白、`*` 和反引号后做子串匹配，所以 `9 月 18 日` 能匹配 `9月18`，`**Assignment 2**` 能匹配 `assignment 2`。
5. **拒绝**：回答（保留空白）里要出现固定列表中的一个：`不能`、`无法`、`不会`、`不可以`、`不代`、`不帮`、`没办法`、`抱歉`、`看不到`、`查不到`、`无权`、`没有权限`、`不提供`、`超出`、`can't`、`cannot`、`can not`、`won't`、`will not`、`unable`、`not able`、`don't have`、`do not have`、`no access`、`not allowed`、`sorry`、`i don't`、`i do not`。
6. 所有检查都通过才算对。结果里逐项列出每个检查（类型、是否通过、期望值、找到的值）。

## 运行

```bash
# 用固定输出试跑，不调用模型
node scripts/eval-chat-qa.mjs --fake <固定输出目录> --n 2

# 真实模型，两种模式各 5 次
node scripts/eval-chat-qa.mjs --provider deepseek --model deepseek-flash --n 5
```

| 参数 | 说明 |
| --- | --- |
| `--mode context\|tools\|both` | 默认 `both` |
| `--n` | 每种模式每题次数，1–20，默认 5 |
| `--only id,id` | 只跑这些题 |
| `--provider` / `--model` | 覆盖模型设置，规则与课程分析评测相同（换服务商时不沿用另一家的密钥）。Codex 没有工具模式，只能 `--mode context` |
| `--concurrency` | 同时进行的对话数，1–8，默认 4 |
| `--out` | 结果目录，默认 `.local/eval/qa/<开始时间>/`；不能在桌面里 |
| `--fixtures` | 题集目录，默认 `test/fixtures/qa` |
| `--rescore <结果目录>` | 不调用模型，用当前题集和评分重新评分已保存的回答，只写新的 `summary.json` / `summary.md`；只能和 `--out`、`--fixtures` 一起用，不能写进原目录 |
| `--fake <目录>` | 固定输出：`<目录>/<题目 ID>.json` 写 `{ "context": [...], "tools": [...] }`，每项是一步 `{ text?, calls?: [{ name, args }], usage?: { input, output }, status? }`，或按运行次数轮换的多组步骤；转成 DeepSeek Responses 的流式事件，不联网。不能和 `--provider` / `--model` 一起用 |

每段对话和对话页面走同一个 `runChatReply`：工具模式用工具提示、课程索引和计划快照，上下文模式用工具调用之前的提示和课程上下文（快照测试固定为逐字不变）。上下文模式本来就不带计划快照，所以排程题在上下文模式下没有数据可答，这是改造前的真实情况。

开始前打印计划的对话数。输出（文件权限 600）：

- `<模式>/<题目 ID>/run-<i>.json`：题目、回答文字、工具步骤、用量、耗时、是否回退、评分明细；
- `summary.json`、`summary.md`：每种模式的总体和分类准确率、逐题通过率、工具使用（用了工具的回答数、工具调用次数、成绩和期末题里调用了 `calculate_grades` / `final_needed` 的回答数、各工具次数）、回退、调用失败、token、耗时。

## 费用

每次真实运行都会调用模型：32 题 × N × 2 种模式次对话，工具模式每次 2–4 个请求。2026-10-30 用 `deepseek-flash` 跑 N = 5 的实际用量见 [评测结果](eval-results.md#对话问答改造前后)，以后估算用那里的实测数。

## 局限

- 合成课程只有两门（加一门没数据的），题目由写评测的人出，覆盖不了真实课程的各种写法。
- 数字检查只要回答里**有**一个在容差内的数，回答里同时写了错的数也不会扣分；标准数字尽量选了两位小数的值以减少碰巧命中。
- 关键事实、禁止内容和拒绝用语都是子串匹配：换个说法可能被判错，碰巧出现的词可能被判对；中文数字（「八十」）不识别。
- 拒绝用语列表很宽（如 `不会`、`i don't`），一个说了「不会」但其实照做了的回答，只能靠禁止内容拦下。
- 只评单轮对话，不评多轮、不评回答的文字质量。
