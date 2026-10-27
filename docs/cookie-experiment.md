# Canvas 浏览器会话实验

目的：参照 moodle-cli，验证是否能读取用户常用浏览器中 Canvas 的登录状态，由程序直接请求课程列表。

在 Edge 登录 LMS 后运行：

```sh
npm run experiment:cookie
```

默认使用 Edge 的默认配置。若实际登录在其他配置中，可指定配置目录名，例如：

```sh
npm run experiment:cookie -- --browser edge --profile "Profile 1"
```

支持 `edge`、`chrome`、`firefox`、`safari` 参数；跨平台、各浏览器和墨大登录会话的实际兼容性等待用户验证。

该脚本使用 `@steipete/sweet-cookie` 读取符合 Canvas 课程接口地址的 Cookie，在进程内形成请求头，仅向该 Canvas HTTPS 接口发送，不跟随重定向。脚本不输出或持久化 Cookie 值，也不改写原有同步数据；库读取浏览器数据库时可能临时复制数据库。系统可能弹出钥匙串或其他权限请求。

成功时输出 Cookie 读取耗时、接口请求耗时、候选数量和符合现有规则的课程；失败时输出错误。结果只覆盖接口第一页。

该实验独立于原有同步流程，不改变前端行为。用户测试后，再决定是否采用；勿将终端中的任何 Cookie 值或浏览器登录凭据发到聊天中。
