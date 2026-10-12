# M2 issue C 实施证据

范围：GitHub #60，`v1-protocol` tasks 3.1–3.3；共享精确引文校验、结构化学习条目和 Q1 兼容。没有改变存储、传输、依赖或模型调用；没有提交。3.4 与整个 change 的归档仍由后续交付处理。

- Red：`npx vitest run test/citations/exact.test.ts test/protocol/citations.test.ts`，exit 1，2 个套件因共享模块尚不存在而失败。
- 行为 Red：共享实现后，完整字段中的材料归属被拆成 reasoning statements 时没有拒收；`npx vitest run test/quiz/citations.test.ts test/citations/exact.test.ts test/protocol/citations.test.ts`，exit 1，1 failed / 50 passed。补充完整字段归属检查后通过，保留既有 Q1 的材料复用、逐条覆盖与 prompt-only 限制。
- 夹具修正：首个 UTF-16 期望 end 从 13 修正为 12（不含末尾空格）；第一次 check 的 TypeScript 错误由夹具 `provenance` / `redacted` 字面量推断扩大导致，使用 const 字面量后消除。它们不计作产品缺陷的 red 证据。
- 定向 Green：`npx vitest run test/citations/exact.test.ts test/protocol/citations.test.ts test/quiz/citations.test.ts test/quiz/proposal.test.ts`，exit 0，4 files / 73 passed。
- 全量 Green：`npm run check`，exit 0，TypeScript 通过，68 files / 716 passed / 2 skipped。既有 skip 保留；没有进行真实课程、浏览器、端点或上线验收。
- 独立审查：fresh-context 只读审查结论 ready to merge（仅 tasks 3.1–3.3），未发现影响正确性或需求的缺口；审查者独立重跑定向测试，4 files / 73 passed / exit 0。

接入契约：`docs/engineering/shared-citation-service.md`。B 负责真实可信证据适配；H 负责授权、隐私、账本／审计、保存及发布时版本复核。本服务只证明引文属于来源，不证明 claim 正确。
