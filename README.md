# ChatGPT Embed（Obsidian 插件）

在 Obsidian 里直接打开 ChatGPT 网页（仅桌面版）。

## 安装

1. 打开你的 vault 文件夹，进入 `.obsidian/plugins/`（没有就新建）。
2. 新建文件夹 `chatgpt-embed`，把 `main.js`、`manifest.json`、`styles.css` 放进去。
3. Obsidian → 设置 → 第三方插件 → 关闭“安全模式” → 刷新列表 → 启用 **ChatGPT Embed**。

## 使用

- 左侧功能区的 💬 图标，或命令面板（Cmd/Ctrl+P）搜索 “ChatGPT”。
- 第一次打开需要登录；登录状态会保存下来，下次不用再登。
- 工具栏：后退 / 前进 / 刷新 / 首页 / 在浏览器中打开。
- 设置里可以改网址、默认打开位置（右侧边栏或新标签页）、缩放比例。

## 说明

- ChatGPT 禁止被 iframe 嵌入，所以插件使用 Electron 的 `<webview>`，只能在桌面版运行。

## Google 不让登录怎么办

Google 会拦截内嵌浏览器里的登录（提示 “This browser or app may not be secure”）。

**推荐：用 Chrome 登录（自动）**

1. 点 ChatGPT 工具栏上的「登录」图标（箭头进门），或命令面板搜“用 Chrome 登录”。
2. 插件会打开一个独立的 Chrome 窗口（单独的配置，不影响你平时的 Chrome）。
3. 在里面正常用 Google 登录 ChatGPT。
4. 登录成功后 Chrome 会自动关闭，Obsidian 里就已经是登录状态了。

登录过期（大约一个月）后再点一次；因为那个 Chrome 配置会记住 Google 账号，之后基本是一键完成。
找不到 Chrome 时，在插件设置里填写 Chrome 路径（也支持 Edge、Brave）。

**用 Cookie 登录**

1. 在 Chrome 里打开 chatgpt.com，确认已登录。
2. Cmd+Option+I 打开开发者工具 → Application → Cookies → https://chatgpt.com，筛选框输入 `session-token`。
3. 点 Obsidian 里 ChatGPT 工具栏上的🔑按钮（或命令面板“导入 ChatGPT 登录状态”）。
4. 把 `__Secure-next-auth.session-token.0` 和 `.1` 的 Value 分别粘到两个框里，点「登录」。
5. 几秒后会提示“✅ 已登录 ChatGPT：你的邮箱”。

只有一个不带 .0/.1 的 session-token 时，展开「其他格式」直接粘贴；也支持 Cookie-Editor 扩展导出的 JSON。
Cookie 过期（大约一个月，或者你在别处点了退出登录）后，重新复制一次即可。

## 安全说明

- 插件只访问 chatgpt.com，不向任何其他地方发送数据。
- 独立的 Chrome 配置保存在 `~/.obsidian-chatgpt-embed/`，不在笔记库里，不会被同步。
- “用 Chrome 登录”通过进程管道和 Chrome 通信，不开任何网络端口；同步完成后 Chrome 会关闭。
