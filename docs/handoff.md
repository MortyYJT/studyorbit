# 项目交接

更新：2026-10-29。接手时先读 [README](../README.md) 和 [项目结构与数据流](overview.md)；历史过程保留在 [历史交接记录](handoff-history.md)，与本文件冲突时以代码和本文件为准。

## 当前状态

- 本地第一版主流程已有实际四门课试跑：课程发现、选择、三来源采集、DeepSeek 结构化分析、JSON 保存和课程页展示。四门课不代表跨课程稳定；详细结果及 Token 在 [第一版试跑](first-sync-run-20261029.md)。
- DeepSeek Flash 为当前默认；模型输出必须经过本地校验，格式合格不保证语义正确。用户确认过本次特定课程的判断，不要据此对所有课程硬编码。
- COMP20003 的 Ed A3 成绩接口曾返回 403；该课 Workshop 的“全部完成”0.04 分条目是否影响汇总仍待核对。Handbook / Canvas / Ed 偶发登录或读取失败。
- 当前用户菜单保留头像上传、同步数据和设置；头像仅存于当前浏览器。同步用量按批次展示，旧记录尝试通过目录元数据恢复，推算耗时标为约值。
- 每日可用时间功能已移除。现有学习任务只有截止日期与预计分钟，周/月视图暂按截止日期展示，不具备完整的自动学习排期；添加独立任务按钮尚未接入。
- 用户要求暂不提前扩大功能，先逐项审查同步数据，再慢慢调整前端。用户通常自己做界面验收；需要模型、浏览器或付费调用时应以已授权的实验范围为准。

## 重要未完成项

1. Canvas 目前只读课程、分组、作业 / submission；大纲、独立测验和课程页面可能有重要信息未采集。Ed 候选和介绍页也有范围限制。采集完整性和课程代码过滤需跨课程验证。
2. 跨来源合并、稳定 ID、替代考试、hurdle、加分与父子计分仍可能出错。用户修改通过浏览器覆盖层保存，但模型 ID 变化可能导致覆盖不再匹配；需要专门验证重同步。
3. `course-reports` 按修改时间选最新有效文件，不按来源覆盖程度排序；部分采集结果可能替代页面上的较完整旧结果，但旧桌面文件仍保留。
4. 同步取消已在单课模型分析阶段试过；多课取消、异常中断恢复、模型计费和完整新批次展示仍需验证。服务重启会丢失内存中的活动状态。
5. 仅 macOS + Edge 路径试跑；Canvas / Handbook 依赖 Edge Apple Events，Ed 依赖单独 CLI token；Windows、其他浏览器及新安装配置尚未完成。
6. 旧 `Agent` 页面仍依赖原有协议服务；普通 Vite 开发服务未实现完整聊天后端。不要把显示入口当成 Agent 已打通。

## 使用与配置

- `npm ci`、`npm run dev`；`npm run build` 检查和构建。同步数据 API 属于 Vite 开发服务，静态产物不能独立同步。
- 默认 `COURSE_ANALYSIS_PROVIDER=deepseek`，模型默认为 `deepseek-flash`；密钥取 `COURSE_ANALYSIS_API_KEY` 或 `DEEPSEEK_API_KEY`。可选 `COURSE_ANALYSIS_PROVIDER=codex`；`openai-compatible` 需要 `COURSE_ANALYSIS_URL`、`COURSE_ANALYSIS_MODEL` 和 `COURSE_ANALYSIS_API_KEY`，使用 JSON 模式加本地校验。配置应出现在启动 Vite 的环境中，不要输出或提交密钥。
- 运行 `npm run sync:courses` 只重新获取 Canvas 候选，输出到 `.local/lms/courses.json`；它是新 Edge 分页采集器，不接受旧脚本的 `--browser` / `--wait` 参数。
- 恢复本机数据前先看 [数据位置](overview.md#数据位置)和 [迁移说明](migration.md)。不要清空 `.local`、`.local-backups`、桌面课程目录或浏览器存储来排查问题。

## 清理记录

旧版无入口的课程页、选课、周视图、指标、记忆组件及其未使用导入已从工作树移除；旧的独立采集实验与复制式课程脚本已移除，历史记录中提及的旧命令不再可运行。Git 历史可恢复，例如 `git show 49409d4:scripts/experiment-cookie.mjs`。实验结论文档保留；运行和构建入口以当前 README、package.json 和代码为准。未清理或迁移用户本机数据。
