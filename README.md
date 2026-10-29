# StudyOrbit

**UniMelb coursework assistant** · 墨大课业助手

本地优先的墨大课业助手。它从你已登录的 Canvas、Ed 和 Handbook 读取课程信息，由你选择的模型整理成结构化的课程 JSON，经代码校验后在网页里展示成绩、安排每周学习，并能就你的课程回答问题。数据留在你自己的电脑上。

> 仍是原型：采集器以 macOS + Microsoft Edge 为主，Windows 和其他浏览器尚未完整支持。一次同步的结果需要人工核对，不要当作必然正确。

## 功能

- **同步课程：** 从 Canvas 发现课程，你勾选后依次采集 Canvas（作业、分组、本人提交）、Ed（`edstem` CLI）和 Handbook（考核结构），再由模型合并成一份课程 JSON；格式或关系不对时自动修复一次，结果按课程保存在桌面课程文件夹。
- **成绩与考核：** 课程页显示已得分、当前平均、已出分占比和各项权重；考核按原型的样子一行一项，带子项的可以展开；可以手动修正、合并、新增或隐藏考核，修正只保存在浏览器里，不改同步原件。
- **计划：** 周视图和月历，给考核安排学习时间。
- **Agent 对话：** 根据已选课程的同步数据回答问题，例如解释权重、算期末需要的分数、排本周计划、出复习题。只做讲解和规划，**不代写、不代做、不提交任何作业**。
- **选择模型：** 在「设置 → 分析模型」选择 DeepSeek、OpenAI 兼容接口（OpenAI、通义、Kimi、本地 Ollama 等）、Anthropic Claude 或 Codex CLI；同步分析和对话共用这份设置。
- **外观：** 浅色 / 深色 / 跟随系统；五套配色一键切换；背景可选渐变、纯色或上传的图片（可调可见度、模糊和卡片不透明度）；界面过渡动画在系统开启「减少动态效果」时自动关闭。

## 启动

需要 Node.js **24 或更新版本**。在项目目录运行：

```bash
npm ci
npm run dev
```

打开 `http://localhost:5173/`。只看已同步的数据不需要额外准备；要同步课程还需要：

1. 在 **macOS Microsoft Edge** 中登录墨大 Canvas，并保留一个浏览器窗口。Canvas 和 Handbook 采集依赖 Edge 的 Apple Events JavaScript 和系统自动化权限。
2. 安装并登录澳区 `edstem` CLI（Ed 使用它自己的登录，不复用 Edge）。
3. 在「设置 → 分析模型」选择模型并填写密钥，点「测试连接」确认可用。也可以沿用环境变量（`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`，或 `COURSE_ANALYSIS_PROVIDER` / `_MODEL` / `_URL` / `_API_KEY`）；优先级是设置 > 环境变量 > 默认（DeepSeek `deepseek-flash`）。

然后在页面点「立即同步」，勾选课程并保存。**保存选课会立刻开始同步**，会用到 Edge、Ed 和模型额度。只采集课程列表可以运行 `npm run sync:courses`。

## 数据与隐私

| 内容 | 位置 |
| --- | --- |
| 采集快照、同步记录与用量、模型设置、对话记录 | 项目内 `.local/`（被 Git 忽略；设置文件权限 600，密钥只写不回显） |
| 每门课的课程 JSON | `~/Desktop/墨尔本大学 <年份> S<学期>/<课程代码>/` |
| 选课、修正、学习计划、外观设置、背景图片 | 浏览器 localStorage / IndexedDB（背景图片不会上传） |

- 课程和成绩数据会发送给你选择的模型服务，模型调用可能产生费用。
- 本地接口只接受本机、同源的请求；其他网站或本机其他端口的页面读不到你的数据。
- 不使用自签 Canvas token（学校禁止）；登录和多因素认证始终由你自己完成，模型看不到密码。

## 开发

- `npm run check`：类型检查加 `test/` 下的 vitest 测试，与 CI 相同。
- `npm run build`：构建静态资源。**静态构建不包含同步和对话接口**，它们只在 Vite 开发服务器里。
- 代码结构见 [项目结构和数据流](docs/overview.md)；课程 JSON 契约见 [docs/course-json.md](docs/course-json.md)，分析提示词见 [docs/course-sync-prompt.md](docs/course-sync-prompt.md)。
- 协作规则见 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)；决定记录在 `note/decisions.md`，当前进度在 [note/handoff.md](note/handoff.md)。

## 实验记录

[第一版试跑](docs/first-sync-run-20261029.md)、[同步用量](docs/sync-measurements.md)、[同步优化](docs/sync-optimization.md) 记录了真实运行的耗时和 token 用量；[四门课采集快照](docs/collection-snapshot.md) 只记录各来源读到了多少条目。它们只代表当时那几门课，不等同于普遍结论。个人成绩已从这些记录中移除；含成绩的模型对比与混合同步实验只保存在本机。

## 仓库历史

2026-10-29 起，本仓库以本地原型 v2 为准：v2 的开发历史已在去掉个人成绩后并入主线。早先的 v1 实现（Codex 读页面、`coursework` CLI、SQLite 存储、OpenSpec 规格）已从主线移除，仍可在 Git 历史中查看。
