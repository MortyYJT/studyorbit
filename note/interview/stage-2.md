# Stage 2 学习测验 · 存储、返回格式、抓取、成绩推算

> Session id：`session-4e16131a-0bc7-44ea-a4d9-403bc221bb18`
>
> `v1-foundation`（M0）第二阶段，对应已合并的 PR #13 / #14 / #15 / #17。

- **合并对象：**
  - PR #13 `src/protocol` —— 错误码集合 + agent 返回信封（envelope）。
  - PR #14 `src/store` —— `node:sqlite` 仓储、版本化迁移、事务内分配 `seq`。
  - PR #15 `src/config/data-dir.ts` + `src/capture` —— 数据目录、profile 锁、页面快照、`coursework capture` 命令。
  - PR #17 `src/domain/grade.ts` —— `projectGrade` 成绩推算（决策 #42 改为由 Claude 实现，不再留 `TODO(human)`）。
- **相关文件：** `src/protocol/errors.ts`、`src/protocol/envelope.ts`、`src/store/repository.ts`、`src/store/sqlite.ts`、`src/store/migrations/index.ts`、`src/store/migrations/001-initial.ts`、`src/config/data-dir.ts`、`src/capture/lock.ts`、`src/capture/snapshot.ts`、`src/capture/session.ts`、`src/capture/command.ts`、`src/cli.ts`、`src/domain/grade.ts`、`test/protocol/**`、`test/store/**`、`test/capture/**`、`test/config/**`、`test/domain/grade.test.ts`、`openspec/changes/v1-foundation/specs/**`、`note/decisions.md`
- **怎么用：** 先自己写，再回头对照；答不出的记到文件末尾「复习清单」。这里不给答案。

---

## 一、这一阶段做了什么（通俗版）

一句话：在 M0 第一阶段的「数据模型」之上，把四件基础设施做完——**怎么把结果交回给 agent**、**结果和数据存在哪里**、**怎么在人工浏览器里把页面存下来**、**怎么从考核项权重算期末要考多少分**。

### 1. PR #13 · 协议：一个信封 + 一组封闭的错误码

- `src/protocol/errors.ts` 定义了一份**错误码表** `retryable`，9 个码，每个码是否可重试是固定的（例如 `CONFLICT`、`SOURCE_UNAVAILABLE`、`LOCKED` 可重试；`INVALID_INPUT`、`NOT_FOUND`、`AUTH_EXPIRED`、`CITATION_MISMATCH`、`LIMIT_EXCEEDED`、`INTERNAL` 不可重试）。
- `ErrorCode` 不是手写的字符串联合，而是 `keyof typeof retryable`。这样加/删错误码只有一处，代码里写一个表外的码，**TypeScript 编译就不过**。
- `CourseworkError` 继承 `Error`，额外带 `code`、`next`。其中 `AUTH_EXPIRED` 的 `next` 被构造函数强制成「请用户重新登录」，调用方传什么都改不掉——恢复登录这件事永远属于用户。
- `src/protocol/envelope.ts` 规定所有面向 agent 的命令都返回**恰好一个 JSON 信封**：成功 `{ ok: true, data, ... }`，失败 `{ ok: false, error: { code, message, retryable, next? }, ... }`，两边都带 `meta.runId` 和 `meta.durationMs`。
- `ok()` / `fail()` / `run()` 是三个入口。`run()` 包住一段可能异步、可能抛错的工作，把已知错误映射成对应码，**把未知错误一律映射成 `INTERNAL`**，且消息被洗成固定文案。
- 输出有 **64 KiB 上限**：序列化后超限就整体变成 `LIMIT_EXCEEDED` 失败信封，并给「把请求收窄」的提示，而不是悄悄截断。

### 2. PR #14 · 存储：仓储接口 + node:sqlite + 迁移

- `src/store/repository.ts` 只定义**接口**（`Repository`）和批量写入的形状（`SaveBatch`）。领域对象用 zod schema 表达，调用方不写 SQL。
- 只有 `src/store/` 里可以 `import 'node:sqlite'`；`test/store/guards.test.ts` 会在 `npm run check` 时扫描全仓库源码，发现别处出现这个 import 就让检查失败。以后想换数据库，只动这一个实现。
- `src/store/sqlite.ts` 的 `SqliteRepository`：每张表把常用查询列（`id`、`moduleId`、`courseId`……）单独建列，整条实体 JSON 存进 `json` 列。写入前 `schema.parse`，读取时也 `schema.parse`，所以**数据库里被改坏的数据在读取时会被拒绝**，不会流进业务层。
- `saveBatch` 用 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` 包住整批：任务、课程、变更要么全写，要么全不写。`seq` 在**同一个写事务里**用 `SELECT COALESCE(MAX(seq), 0)` 加一分配，调用方就算伪造 `seq: 900` 也会被忽略。
- `src/store/migrations/`：迁移是**有序函数数组**，`latestVersion = migrations.length`。打开时读 `PRAGMA user_version` 当已应用版本；落后就逐个应用并递增版本，全程一个事务；如果数据库记录的版本比代码知道的新，直接报错，两个版本号都写进消息，且**不改文件**。

### 3. PR #15 · 配置与抓取：数据目录、锁、快照、capture

- `src/config/data-dir.ts`：数据目录默认是「包根目录」下的 `.local/`，包根目录靠从当前模块往上找 `package.json`（且 `name === 'coursework'`）确定，所以不管从哪个工作目录启动，指的都是同一个地方。环境变量 `COURSEWORK_HOME` 非空时覆盖它。数据库、`snapshots/`、`profiles/` 都在这个目录下，目录用 `0o700` 权限创建（只有本人可读）。
- `src/capture/lock.ts`：同一份浏览器 profile 同一时间只能被一个进程用。锁文件 `<data dir>/profiles/default.lock` 里写持有者 PID。创建用 `openSync(path, 'wx', 0o600)`——`wx` 的含义是「不存在才创建，已存在就报 `EEXIST`」，这一步是原子的。发现锁时：PID 还活着就抛 `LOCKED`；PID 已退出（`ESRCH`）就清掉锁重来；锁文件为空且新鲜就当作别人正在写，抛 `LOCKED`；空且超过 10 秒才回收；内容乱七八糟且非空则永不回收。
- `src/capture/snapshot.ts`：保存页面时 URL 先 `cleanUrl` 去掉 query、fragment、用户名、密码，只允许 http/https。目录是 `<data dir>/snapshots/<host>/<ISO 时间>-<标题 slug>/`，里面写 `page.html`、`page.png`、`meta.json`。重名就加 `-1`、`-2` 后缀，不覆盖旧快照。写完前还会再检查一次 URL 有没有变（页面在截图/取 HTML 期间跳走了就报错）。
- `src/capture/session.ts` + `command.ts` + `cli.ts`：`coursework capture` 打开带界面的 Chrome，用持久化 profile `<data dir>/profiles/default`，人在里面手动登录、手动点，终端里按 `s` 存快照、按 `q` 退出。找不到 Chrome 时（且只在找不到时）才提示改用已装的 Playwright 自带 Chromium。锁被别人占着时，`cli.ts` 把 `LOCKED` 映射成退出码 3 并打印持有者 PID。工具**不读、不存、不打密码**。

### 4. PR #17 · 成绩推算：projectGrade

- `src/domain/grade.ts` 是纯函数，没有 I/O：输入课程、考核项列表、目标等级，输出 `gradedWeight`（已出分占比）、`earned`（已拿到的加权分）、`currentAverage`（已出分项的平均分，可能为 `null`）、`need`（期末要考多少）。
- 等级线：H1 80、H2A 75、H2B 70、H3 65、P 50。
- `need` 有四种状态：`score`（带 `value` 和 `setByHurdle`）、`unreachable`（要的分超过 100）、`secured`（已经稳了）、`unavailable`（带原因 `nothing_graded` / `no_final` / `final_graded`）。
- 判断顺序很重要：先按 `nothing_graded` → `no_final` → `final_graded` 出 `unavailable`；否则把未出分的非期末项**按当前平均分估**，算出期末需要多少；超过 100 是 `unreachable`；有 `hurdleMin` 时取 `max(原始需要, 门槛)` 并标 `setByHurdle`；没有门槛且需要 ≤ 0 是 `secured`。

---

## 二、这一阶段为什么这样做（要点）

- **为什么要统一的信封和封闭错误码：** 这是给外部 agent 用的机器接口，不是给人看的日志。固定形状让调用方能可靠判断「成了没、要不要重试、下一步干嘛」；错误码收敛到 9 个，避免每个命令自己造词。
- **为什么 `seq` 是整数单调递增：** 增量同步的核心问题是「上次看到哪了」。一个只增不减的整数游标，`listChangesSince(seq)` 就能稳定地只拿新变化；用时间戳会有同秒、时钟回拨的问题。
- **为什么数据必须留在 `.local/`：** 这是隐私红线（决策 #2）。iCal 链接、浏览器 profile、抓来的课程数据绝不进仓库；`.gitignore` 忽略 `.local/`，并且有测试用 `git check-ignore` 守住。
- **为什么锁是「文件 + PID」而不是数据库锁：** 被锁住的是 Chrome 的 profile 目录，不是数据库；而且捕获进程可能崩溃，所以需要能识别「持锁进程已死」并自动回收。锁模块抛 `LOCKED`，是为了让以后面向 agent 的命令也能拿到一个规范的信封。
- **为什么成绩推算要细分 `need` 状态：** 「期末要考 80 分」「已经稳了」「无论如何都到不了」对用户是三种完全不同的提示，UI 和 agent 需要区分；`setByHurdle` 才能解释「为什么明明已经够了还要考到 50」。

---

## 三、关键 TypeScript 写法 × Java 类比

> 你只会 Java；这一节把本阶段用到的 TS 写法逐个对应到 Java 概念上。看完再做题。

### 1. 联合类型（union type）—— `A | B`

```ts
export type SuccessEnvelope = BaseEnvelope & { ok: true; data: unknown };
export type FailureEnvelope = BaseEnvelope & { ok: false; error: {...} };
export type Envelope = SuccessEnvelope | FailureEnvelope;
```

- 读法：一个值只要是 `SuccessEnvelope` **或者** `FailureEnvelope` 之一，就是合法的 `Envelope`。
- **Java 类比：** Java 没有 `A | B` 这种类型。最接近的是「密封接口 + 两个 record 实现」（Java 17+ 的 `sealed interface`）。区别是 TS 的联合是**结构化**的：不需要显式 `implements`，只要字段形状对得上就算数；Java 必须显式声明继承/实现关系。
- 本阶段还有两个相关写法：
  - `type ErrorCode = keyof typeof retryable` —— 从**值**推出**类型**（`retryable` 对象的键名集合）。Java 里没有直接的等价物；近似是「枚举 + `EnumSet`」，但那是先有类型再有值，方向相反。
  - 联合里带一个**字面量判别字段**（这里是 `ok: true` / `ok: false`），叫「可辨识联合（discriminated union）」，等价于 Java 密封接口里的一个 `type()` 方法，只不过 TS 不用手写 `type()`。

### 2. 对象字面量（object literal）

```ts
return { protocol: 'coursework.agent/v1', ok: true, command, data, meta };
```

- 读法：`{ 键: 值, ... }` 直接写一个对象，`command` 是 `command: command` 的简写。返回类型由函数的声明或上下文决定，字段多了少了类型都不通过。
- **Java 类比：** Java 没有对象字面量。最接近的组合是：
  - `record` 的构造调用：`new SuccessEnvelope("coursework.agent/v1", true, command, data, meta)`；
  - 或匿名类 `new Object() { ... }`（几乎没人这么用）；
  - 或 `Map.of(...)`（但它丢掉字段类型）。
- 关键差别：TS 对象字面量是**临时构造一个符合某类型的值**，不需要预先写类；Java 必须先有类/record。面试里如果被问「TS 怎么表达 DTO」，答「直接写对象字面量，类型由接口或推断给出，不需要 class」即可。

### 3. 类型收窄（type narrowing）

```ts
if (result.ok && !Object.hasOwn(result, 'data')) { ... }

function mappedError(error: unknown): CourseworkError {
  return error instanceof CourseworkError && Object.hasOwn(retryable, error.code)
    ? error : new CourseworkError('INTERNAL', 'An unexpected error occurred.');
}
```

- 读法：在 `if` 分支里，TS 编译器会根据条件**自动把类型收窄**。`result.ok` 为真时，`result` 被当作 `SuccessEnvelope`；`error instanceof CourseworkError` 成立的分支里，`error` 从 `unknown` 变成 `CourseworkError`，可以直接访问 `.code`。
- `unknown` 是「还不知道是什么」的安全版 `any`：不先收窄就不能随便用。
- **Java 类比：** 就是 `instanceof` 模式匹配：`if (e instanceof CourseworkError ce) { ce.code(); }`。Java 17 的 `switch` 模式匹配、密封接口的穷尽检查也和 TS 的判别联合收窄很像。
- 差别：TS 的收窄是**编译期**的，运行时没有任何类型信息（类型在运行时全被擦掉）；Java 的 `instanceof` 依赖运行时的 `Class` 对象。

### 4. async / await —— 异步

```ts
export async function run(command: string, fn: () => unknown | Promise<unknown>): Promise<Envelope> {
  const data = await fn();
  ...
}
```

- 读法：`async` 函数一定返回 `Promise<T>`；`await` 等一个 `Promise` 落定，成功就拿到值，失败就以异常形式抛出。
- **Java 类比：** 最接近的是 `CompletableFuture<T>`：
  - `async function f(): Promise<T>` ≈ 返回 `CompletableFuture<T>` 的方法；
  - `const x = await p` ≈ `T x = p.join()`（或 `thenApply` 链）；
  - 返回 `Promise` 的方法不会阻塞线程，逻辑上像异步回调。
- **重要差别：**
  - JS 运行在**单线程事件循环**上，`await` 只是让出执行权，不是开新线程；Java 的 `CompletableFuture` 可能跑在线程池里，或者用虚拟线程写同步阻塞代码。
  - Java 有 **checked exception**，`throws IOException` 必须出现在签名上；TS 没有 checked exception，任何函数都可能抛，错误通过 `Promise` 的 reject / `try...catch` 传递。本阶段正是靠这一点，用一个统一的 `run()` 把所有异常收进信封。
  - `Promise` 可以没有 catch 而变成「未处理的 rejection」，Java 的 `Future` 不调用 `get()` 就不会知道异常。

### 5. zod —— 运行时校验 + 类型推导

```ts
export const GradeNeedSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('score'), value: z.number(), setByHurdle: z.boolean() }),
  z.object({ status: z.literal('unreachable') }),
  ...
]);
export type GradeNeed = z.infer<typeof GradeNeedSchema>;
```

- 读法：zod schema 是**运行时的对象**，`schema.parse(x)` 会真的检查 `x` 并返回一个规范化后的值（未知字段可能被剥掉），不合法就抛错。同时 `z.infer<typeof Schema>` 在**编译期**把这个 schema 对应的 TS 类型推导出来。一份定义，两处使用。
- **Java 类比：** 最接近的是 **Bean Validation（Jakarta Validation / Hibernate Validator）**：在字段上挂 `@NotNull`、`@Min(0)`、`@Valid`，运行时校验。zod 的 `z.infer` 可以类比成「用注解处理器（annotation processor）从注解生成类型」，但 Java 这条路要额外代码生成，平时还是手写类。
- 关键差别：Java 的校验注解挂在**已经写好的类**上；zod 是**先有 schema，类型是它推出来的**。这一阶段所有领域类型（`Module`、`Assessment`、`Task`、`Change`……）都是 `z.infer`，所以不会出现「类改了、校验规则忘了改」的两份定义漂移。
- 存储层把这个用到了读和写两端：`write()` 里 `schema.parse(input)`，`load()` 里 `schema.parse(JSON.parse(row.json))`，所以**数据库被改坏的数据读时会报错**，坏数据进不了业务层。

---

## 四、题目（12 题：6 设计 + 6 读代码）

### A 部分 · 设计题

**A1.** 迁移版本为什么存进 `PRAGMA user_version`，而不是新建一张 `schema_migrations` 表？请回答：

1. `user_version` 存在数据库文件的什么位置，为什么它天然和 schema 改动「在同一个事务里」这件事很好配合？
2. 迁移函数为什么必须先读一次版本，拿到写锁之后再**重新读一次**？
3. 如果换成一张 `schema_migrations` 表，会多出哪些步骤和风险？还有哪些替代方案（独立的版本文件、Flyway/Liquibase 这类哈希校验工具、按时间戳命名的迁移），它们各自的代价是什么？

> 作答：
>
>
>
>
>
>
>

**A2.** `seq` 为什么必须在**同一个写事务**里分配（`MAX(seq) + 1`），而不是先查再加、或者交给调用方给？请回答：

1. 如果「查最大值」和「插入」分成两个事务，两个并发进程可能发生什么？为什么 `BEGIN IMMEDIATE`（立刻拿写锁）能避免它，而普通的延迟事务不能？
2. 如果让调用方自己传 `seq`（像测试里伪造的 `seq: 900`），会对 `listChangesSince` 这个增量游标造成什么后果？
3. 有哪些替代方案（SQLite 的 `AUTOINCREMENT`、单独一张计数器表、UUID/ULID、每个进程各留一段号），它们和「整数单调 + 可比较大小」这个需求相比各有什么得失？

> 作答：
>
>
>
>
>
>
>

**A3.** 未知错误的信封为什么要把原始消息丢掉，换成固定的 `An unexpected error occurred.`？请回答：

1. 原始的 `Error.message`、`error.stack` 里通常会出现哪些不该给外部 agent 或模型看的东西？和本项目的隐私红线有什么关系？
2. 为什么 `mappedError` 连一个「长得像 `CourseworkError`、但 code 不在封闭集合里」的对象也不认，而是当 `INTERNAL`？这种「失败也要失败得安全（fail closed）」的设计，对调用方判断「要不要重试」有什么好处？
3. 有哪些替代方案（原样透传、只做正则脱敏、加一个 debug 开关返回详细信息、完整错误只写本地日志而信封返回洗过的版本），各自的代价是什么？

> 作答：
>
>
>
>
>
>
>

**A4.** 为什么信封要有 64 KiB 上限，并且超限时返回 `LIMIT_EXCEEDED` 而不是把 `data` 截断？请回答：

1. 这个协议是给谁消费的？如果一次返回几 MB 的 JSON，下游（agent 的上下文、终端、管道）分别会发生什么？
2. 为什么把超限做成一个**正常可解析的失败信封**，而不是抛异常、也不是「截断后照常返回 `ok: true`」？截断会让调用方误以为数据完整，这为什么比报错更糟？
3. `LIMIT_EXCEEDED` 的 `retryable` 为什么是 `false`，而 `next` 提示「收窄请求」？替代方案有哪些（无上限、流式 NDJSON、游标分页、把大数据写到文件只返回路径），分别适合什么场景？

> 作答：
>
>
>
>
>
>
>

**A5.** 锁文件为什么用 `openSync(path, 'wx', 0o600)` 创建？请回答：

1. `wx` 在系统调用层面是什么含义？如果改成「先 `existsSync` 判断，再 `writeFileSync`」，两个进程同时启动会发生什么？这个竞态为什么用 `wx` 一次消除？
2. `0o600` 这个权限想防住什么？（顺着想：这个目录里还有浏览器 profile 和快照。）
3. 锁文件写的是 PID。为什么 PID 已不存在的锁可以回收，而「内容非空但格式不对」的锁反而永不回收？空文件为什么要有 10 秒宽限期？
4. 有哪些替代方案（`mkdirSync` 当锁、操作系统的 `flock`/`lockf`、不带 `O_EXCL` 的 PID 文件、SQLite 里记一行锁），它们对「进程崩溃后自动解锁」和「跨平台」的支持各如何？

> 作答：
>
>
>
>
>
>
>

**A6.** `projectGrade` 的判断顺序里，`hurdleMin`（门槛）这一支为什么排在 `raw <= 0 → secured` 前面？请回答：

1. 规格里「hurdle 在已经稳了的时候仍然生效」表达的是什么业务含义？如果先判断 `raw <= 0` 返回 `secured`，用户会得到什么错误提示？
2. `setByHurdle` 这个布尔值想区分哪两种「都需要考同一个分数」的情形？没有它的话，UI/agent 能解释清楚为什么吗？
3. 注意 `raw > 100 → unreachable` 排在 hurdle 之前。为什么「超过 100」要压过 hurdle，而「≤ 0」要被 hurdle 压过？这两条规则的优先级你想怎么解释？
4. 有哪些替代方案（先判 secured 再判 hurdle、把 secured 和 hurdle 拆成两个独立字段、由 UI 层再判断），各自的问题是什么？

> 作答：
>
>
>
>
>
>
>

### B 部分 · 读代码题

**B1.** 阅读 `src/domain/grade.ts` 的 `projectGrade`。某课程的目标等级是 H2A（75），考核项如下（`score` 未写就是没出分）：

| id | weight | score | isFinal | hurdleMin |
| --- | --- | --- | --- | --- |
| a | 30 | 70 | false | — |
| b | 20 | — | false | — |
| final | 50 | — | true | — |

请算出并写出 `gradedWeight`、`earned`、`currentAverage`、`need` 四个字段的值（`currentAverage` 保留足够精度；`need` 写清 `status` 和其余字段）。并说明 `b` 这个没出分的项在计算里是怎么被处理的。

> 作答：
>
>
>
>
>
>
>

**B2.** 还是 `src/domain/grade.ts`。现在有另一个课程，考核项是：

- `a`：weight 100，没有 `score`，不是期末；
- 没有任何 `isFinal` 的考核项。

调用 `projectGrade(course, assessments, 'H1')`，`need` 是什么？请写出完整结果，并解释 `decideNeed` 里哪一行决定了这个结果、为什么不是另一个 `unavailable` 原因。

> 作答：
>
>
>
>
>
>
>

**B3.** 阅读 `src/capture/lock.ts`。假设 `<data dir>/profiles/default.lock` 已经存在，且内容是一个空字符串（0 字节）。分别回答：

1. 这个空锁是刚刚（1 秒前）被创建的，`acquireProfileLock()` 会返回还是抛错？抛错的话 `message` 里持有者写的是什么？
2. 这个空锁的修改时间已经是 11 秒前，又会怎样？代码在真正删除它之前，多做了哪一步检查？
3. 如果锁文件内容是 `invalid`（非空、格式不对），即使放了 60 秒，代码为什么仍然不回收它？

> 作答：
>
>
>
>
>
>
>

**B4.** 阅读 `src/capture/snapshot.ts`。设 `COURSEWORK_HOME` 指向某个数据目录，调用：

```ts
snapshotPath(
  'https://user:secret@canvas.example.test:8443/courses/42?token=secret#part',
  'Assignment: One',
  new Date('2026-01-02T03:04:05.006Z'),
);
```

请写出**相对于数据目录**的完整路径（包含 `snapshots/`）。并回答：

1. 端口 `:8443` 在路径里变成了什么？为什么？
2. 这个快照保存后，`meta.json` 里的 `url` 是什么？
3. 标题里的空格和冒号去哪了？如果标题全是中文，slug 会是什么？

> 作答：
>
>
>
>
>
>
>

**B5.** 阅读 `src/protocol/envelope.ts` 和 `src/protocol/errors.ts`。回答：

1. 执行 `await run('get', () => { throw new Error('/home/example/secret/token.txt'); })`，返回的信封里 `ok`、`error.code`、`error.message`、`error.retryable` 分别是什么？`error.next` 存在吗？
2. 执行 `new CourseworkError('AUTH_EXPIRED', 'Session expired.', 'Sign in automatically.')`，这个错误的 `next` 是什么？是谁把它改成这样的、为什么？
3. `error.message` 里会不会出现那串路径？是哪一段代码保证的？

> 作答：
>
>
>
>
>
>
>

**B6.** 阅读 `src/store/sqlite.ts` 的 `saveBatch` 和 `appendChange`。假设数据库中已经有一条 `seq = 1` 的变更，然后调用：

```ts
store.saveBatch({
  tasks: [task],
  changes: [input, invalid],
});
```

其中 `invalid` 是一条 `kind: 'deadline.changed'`、缺少 `before` 的变更（不满足 `ChangeSchema`）。请回答：

1. 这次调用会成功还是抛错？
2. 抛错之后，`store.loadTask(task.id)` 返回什么？`store.listChangesSince(0)` 里有哪些 `seq`？
3. 紧接着再调用 `store.recordChange(input)`，它拿到的 `seq` 是多少？为什么不是 3？
4. `BEGIN IMMEDIATE` / `ROLLBACK` 在这里各起了什么作用？

> 作答：
>
>
>
>
>
>
>

---

## 复习清单（答完后填）

| 题号 | 标记 ✅/⚠️/❌ | 需要复习的点 |
| --- | --- | --- |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
|  |  |  |
