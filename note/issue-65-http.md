# Issue #65 / M2 v1-protocol F

- 范围：只实现 6.1–6.3 的 standalone `node:http` adapter；不接 UI、CLI 启动命令、生产仓库或真实 Canvas/Ed 写操作。未改 CI、部署、依赖、handoff 或 decisions；未提交。
- 实施顺序：读取 change / registry / dispatcher → 编写真实 ephemeral-port 请求测试 → red → adapter → socket-free 补充验证 → 独立只读审查 → 完整 check。
- Red：`npx vitest run test/protocol/http.test.ts`，exit 1，HTTP 模块尚不存在，suite 无法加载。实现后实际监听仍被沙箱拒绝；独立最小 `node:http` probe 得到 `EPERM` / `listen` / `127.0.0.1`，不能将此失败当作业务断言的 red 或 green。
- Green（有限）：`npx vitest run test/protocol/http-boundary.test.ts`，8 passed；该 suite mock 服务器和请求流，不建立 TCP socket，不替代真实 loopback 测试。覆盖全部 registry 命令、授权及 owner 隔离、Host/Origin、防跨源、body/URL/header 数量、超时、dispatcher parity、64 KiB 和一次执行。
- `npx tsc --noEmit`：exit 0。`openspec validate v1-protocol --strict`：valid / exit 0。`git diff --check`：exit 0。
- 独立 fresh-context 只读审查：范围内无 correctness/security/requirement gaps，结论 ready to merge（只指代码审查，不表示真实 HTTP、完整 check 或 CI 通过）。
- 早期沙箱内 `npm run check` 曾 exit 1（19 个失败均为真实 HTTP suite 因 `EPERM` 无法 listen）。之后在主机上重跑：真实 loopback 测试通过，`npm run check` exit 0；6.1–6.3 依此勾选。
- O5：每进程随机 256-bit capability，独立 0700 目录、0600 文件，默认 `.local/http-*/capability`；mutation / owner command 必须通过 `X-Coursework-Capability`。只把路径返回 embedding host；HTTP / logs 不输出 token，不接受 owner/confirmed 等请求授权字段；实际 owner port 由服务器建立，dispatcher 原有 policy/grant/evidence 检查仍执行。
- 并发限制直到 handler 完成才释放，客户端断开不会无限放大后台执行。`close()` 关闭 socket、移除本进程 capability，不虚构已经执行操作的取消／回滚。
- O6：capability 不代表 L4 consent；确认签发、绑定 exact filled revision、一次性消费、版本检查和 serialized submit lifecycle 留给 H。B/D/H 实际服务挂载留给 I；这里仅使用 injected fakes。
- 审查修复（fresh-context review）：同一连接上 pipelined 的第二个请求不再 dispatch（每连接只服务一个请求）；开始 dispatch 后关闭该 socket 的 idle/request 超时，慢命令也能拿到完整响应，未收完的 body 仍 408 且不执行；新增 `requestTimeoutMs`（只能收紧，最大 10s）；capability 存储先 realpath 父目录，只拒绝最终目录本身是 symlink。先写失败测试（handler 执行 2 次 / socket hang up / symlink 父目录被拒），修复后 green。最终 `npm run check`：exit 0，74 files passed，827 passed / 2 skipped。6.4 仍待审查签字；整个 change 不归档。
- 建议提交：`feat(protocol): add protected registry-generated loopback HTTP transport`；body: `- Generate bounded JSON POST routes through the shared dispatcher.` / `- Gate mutations and owner actions with a private per-process local capability.` / `- Document transport conventions and add synthetic HTTP security/parity coverage.`
- 无待选设计问题；先前的沙箱 listen 阻塞已在主机上解除。正式 O6 expiry/confirmation lifecycle 由 H 决定。
