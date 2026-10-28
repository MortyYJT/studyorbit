# 同步管线优化记录

记录同步从「agent 逐页读网页」改为「代码采集 + 每门课一次模型调用」的过程和实测数字，供简历和面试使用。所有数字都来自实际运行记录，来源写在每一节末尾；没有记录的值写「未记录」，不估算。

## 结论

四门课（COMP20003、COMP20008、MAST10007、MUSI20163）完整同步：

| 阶段 | 日期 | 做法 | 端到端耗时 | 模型输入 token | 模型输出 token |
| --- | --- | --- | ---: | ---: | ---: |
| 0. 原项目 | 2026-10-27 | 33 个 Codex 任务，每个任务自己开 Edge 窗口、用 computer use 复制页面 | 21 分钟 | 未记录 | 未记录 |
| 1. v2 初版 | 2026-10-28 | 每门课一个 Codex 调度任务 + 一个 gpt-6-luna subagent 读页面，串行 | 17 分 19 秒 | 8,817,416（缓存 8,262,272） | 61,429 |
| 2. 代码采集 | 2026-10-28 | 代码通过 Edge 后台标签读 Canvas 接口、用 edstem CLI 读 Ed；每门课一个 Luna 子任务整理，并行 | 206.4 秒 | 917,810（缓存 693,120） | 42,780 |
| 3. 单次调用 | 2026-10-29 | 采集同阶段 2，加 Handbook；每门课一次 DeepSeek Flash 结构化调用，并行 | **116.5 秒** | **44,269**（缓存 20,224） | 36,740（推理 23,130） |

从阶段 0 到阶段 3：

- 耗时：21 分钟 → 116.5 秒，约快 **10.8 倍**。和阶段 1 比，约快 8.9 倍。
- 模型输入：8,817,416 → 44,269，约少 **199 倍**（和阶段 1 比，阶段 0 没有记录）。
- 模型输出几乎没少（61,429 → 36,740）。DeepSeek 的推理 token 占了输出的大部分。
- Canvas 采集本身每门课 2–6 秒，不花 token。

## 为什么快了

1. **读数据的活交给代码。** 课程、评分组、作业、截止时间、分值和得分，Canvas 接口都直接给了。阶段 0、1 让模型逐页看网页再抄出来，每一步都要把整个上下文重新发一遍（阶段 1 的输入里有 94% 是缓存输入）。
2. **去掉 agent 中间步骤。** 阶段 2 还是 agent：要读文件、开子任务。阶段 3 改成一次 API 调用，输入就是采集好的数据，输出直接按 schema 返回。输入少了约 20 倍，主要就省在这里，不是换模型省的。
3. **采集串行，分析并行。** 浏览器同一时间只做一件事，免得抢焦点；模型分析可以并行，所以总耗时约等于最慢那门课（COMP20003）的耗时。

## 计算方法

- 阶段 3 的耗时：用量日志里每门课的 `at` 是开始时间，`durationMs` 是这门课从采集到保存的耗时。端到端耗时 = 最晚的「开始 + 耗时」减去最早的开始时间。COMP20003 最先开始也最后结束，所以结果就是它自己的 116.5 秒。不含点「同步」和选课的时间。
- token：取模型提供方报告的数字。输入包含缓存，输出包含推理，都没有重复相加。不同提供方的计数和价格不同，**token 少不等于费用按同样比例减少**。
- 来源：
  - 阶段 0：原项目 OpenSpec 变更 `extension-course-list` 的 proposal。
  - 阶段 1、2：[同步用量](sync-measurements.md)、混合同步实验（含个人成绩，本机私人记录，未入库）。
  - 阶段 3：本机 `.local/lms/course-sync-usage.jsonl` 里 2026-10-28T15:15–15:16Z（UTC）开始的四条记录（第一条 COMP20003 结果，不含之后的重跑）、[第一版试跑](first-sync-run-20261029.md)。

## 局限（面试时要能说清楚）

- 每个阶段只完整跑了 1 次，只有 4 门课，只用了一个学生账号。不能说明在其他课程上一样稳定。
- 四个阶段读取的范围不同：阶段 1 读了教学资料目录，阶段 3 没读，但多读了 Handbook。比较的是「同一组课程跑完整同步」，不是同一份工作量。
- 快了不等于准了。阶段 3 仍有已知错误：COMP20003 的 A3 成绩接口返回 403；第一次分析把 A1 的 [已移除] 写成 [已移除]，改成按 lesson ID 关联后才修好；模型有时把分值当成权重。准确性靠人工核对四门课，没有自动化的准确率指标。
- 阶段 0 是我自己早先的设计。这次的提升有一部分是在纠正那个设计，不全是外部瓶颈。
- 只在 macOS + Edge 上跑过。

## 简历写法（草稿）

英文：

- Re-architected a university coursework sync pipeline from LLM browser agents reading pages to deterministic API capture plus one schema-constrained LLM call per course; a full four-course sync went from 21 min to under 2 min, and model input tokens dropped from 8.8M to 44K (measured on real runs).
- Split responsibilities so that code extracts facts (IDs, due dates, points, grades) from the Canvas and Ed APIs and the model only interprets rule text (assessment weights in the handbook, hurdles, bonuses), with local schema and relation validation before saving.

中文：

- 把课业同步从「LLM agent 逐页读网页」重构为「代码读接口 + 每门课一次带 schema 约束的模型调用」，四门课完整同步从 21 分钟降到 2 分钟以内，模型输入 token 从 880 万降到 4.4 万（真实运行实测）。

面试可能会问：

- 当初为什么是 21 分钟？学校不允许学生自己签发 Canvas token，所以最早选了让 agent 读页面。后来发现在已登录的浏览器里可以同源调用接口，就不需要 agent 逐页读了。
- 怎么知道结果是对的？目前是逐门人工核对，并记录了已知错误。下一步是让代码生成稳定 ID，再对同一份采集数据分析两次，检查 ID、权重、分值是否完全一致。
- token 少了 199 倍，钱也少了 199 倍吗？不是。提供方和单价不同，缓存输入的价格也不同。
