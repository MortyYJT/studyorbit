# Issue B 复审修复证据

- 范围：`ed-quiz-assist` 任务 2.3／2.4；当前分支 `codex/quiz-policy`，基线 `58158ac`。只修复本次两项 P1，不推进 C–E，不归档尚未完成的整体 change。
- 顺序：补合成回归测试 → 红灯 → 修复 → 针对性绿灯 → 新上下文只读复审 → 全量检查。
- 红灯：三个目标测试文件 12 failed / 40 passed；覆盖无句号、标点／空白、词序／部分材料重用、拆分声明、旧提案保留，以及仓库内 `..quiz-private` 等目录。
- 追加红灯：`even’or’odd` 词内标点回归 1 failed / 17 passed，随后统一将 Unicode 标点／符号视作词边界，保留 UTF-16 位置用于声明归属检查。
- 引用规则：NFKC、大小写归一、标点／空白分词，去除常见英文语法词；同一材料片段有两个不同内容词／符号重叠时保守要求材料声明和引用，单内容词材料完整重用也要求引用。不按百分比判定，避免加无关文字稀释重叠；跨声明检测，并检查每个接触匹配词的声明，避免拆分和无关材料标注绕过。
- 独立复审第一轮发现符号材料被忽略；追加纯逻辑符号、仅语法词和仅标点材料的拒绝／有材料支持接受测试，以及符号材料拒收后旧版本保留测试：修复前 5 failed / 37 passed。保留数学／逻辑符号作为有意义 token，无可解释 token 时保留规范化表面复用检查，保守拒收。
- 独立复审第二轮：ready to merge；复审代理独立运行全量检查，exit 0，51 files passed / 461 tests passed / 2 skipped；未修改文件。
- 边界：这是确定性词汇重叠检查，不证明答案正确或穷尽无共同词的语义改写；歧义重叠保守拒收。独立计算且只有常见语法词重叠仍可标作 prompt-only。
- 路径规则：只有完整 `..` 父路径段才算仓库外；仓库内根目录和 `.local/` 之外目录拒绝，包括显式根目录和 `COURSEWORK_HOME`。`.local/` 子目录及真正外部目录仍允许。
- 绿灯：`npx vitest run test/quiz/citations.test.ts test/quiz/files.test.ts test/quiz/proposal.test.ts`：3 files passed / 58 tests passed。
- 全量：`bash .claude/check.sh`（`tsc --noEmit && vitest run`）exit 0；51 files passed / 461 tests passed / 2 skipped。
- `git diff --check` 通过。没有提交，未修改 `note/handoff.md`；没有真实 Canvas／Ed 操作。
