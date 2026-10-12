# M2 Issue E 验证记录

范围：`v1-protocol` 5.1–5.2 / GitHub #64；不提交、不改 handoff/decisions、不归档整个 change。

- Red：`npx vitest run test/protocol/cli.test.ts`，空适配器下 31/31 failed。
- Red：保留原 registry read schema 时，`test/quiz/command.test.ts` 中 2 failed，定位到 Q1 `sourceRevision` 与严格输出 schema 的不兼容；以可选摘要字段修复。
- Red：Q1 失败输出对照测试 2 failed，证明非法引用被误归为 INVALID_INPUT、文件失败措辞改变；复用纯 proposal 分类函数和既有 safeQuizError，保留原始错误输出。
- Red：union flags 测试 1 failed；收集 schema 分支字段后通过。unknown 命令带 help 的测试 2 failed；验证命令路径后通过。
- Green：生成 CLI 36 passed；Q1 分类／文件兼容回归与 CLI 合计 66 passed（之后新增 unknown+help 回归）；原 Q1 读／提案／审阅和 capture/version 回归通过。
- 独立只读审查：第一轮发现 Q1 citation 分类问题，第二轮确认修复，结论 ready to merge（仅本 issue 范围）。
- 全量检查首次发现 5 个 capture mock 用例未传 capture 参数；显式设定测试 argv 后定向 5 passed。第二次全量检查有 1 个未修改的 capture 用例触发 5 秒超时；该文件单独重跑 21 passed。
- 最终 `npm run check`：exit 0；TypeScript 通过；71 files passed，792 tests passed / 2 skipped，12.68s。
- `git diff --check` 通过；handoff、decisions、package.json、lockfile 没有改动。

生产服务接线仍属 Issue I；不接真实 repository，不构建 HTTP/MCP，不测试真实课程／浏览器登录／owner 操作。capture 实现与认证逻辑未修改。没有需要 owner 决策的新设计项。
