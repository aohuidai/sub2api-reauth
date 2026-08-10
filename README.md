# sub2api reoauth

一个与 `FlowPilot` 分离的最小 Manifest V3 Chrome 扩展，包含两部分：

1. 只读查询指定 SUB2API 分组中需要重新授权的 OpenAI OAuth 账号。
2. 用于学习的 OpenAI 登录、验证码、OAuth 授权和 localhost 回调流程。

第二部分不是“批量重授权器”。它把每个页面动作拆成可单独点击的小步骤，让你能同时看页面变化和代码。

## 安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本项目目录。
4. 点击扩展图标打开侧边栏。
5. 首次查询 SUB2API 或执行 OpenAI 学习流程时，Chrome 会只针对相关站点请求访问权限。

## SUB2API 的只读边界

查询部分只会执行：

1. `POST /api/v1/auth/login`
2. `GET /api/v1/admin/groups/all`
3. `GET /api/v1/admin/accounts?...`

它不会生成授权链接、交换授权码、创建账号、更新账号、删除账号或清除错误状态。扩展只保存地址、管理员账号和分组；管理员密码仅保留在当前侧边栏页面内，不写入 Chrome 存储。

分组匹配会先尝试 `platform=openai` 的列表，再回退到完整分组列表，并兼容数组、`items`、`groups` 等返回结构。找不到时，错误信息会显示接口实际返回的前 20 个分组名。

## OpenAI 学习流程

先在普通浏览器标签页中打开你自己的 OpenAI OAuth 登录或授权页面，再从侧边栏按 1 到 9 的顺序操作。扩展会在当前标签页中填写和点击，不会自行打开邮箱或生成 OAuth 链接。

邮箱、密码、验证码不会写入 Chrome 存储；关闭侧边栏即会丢失。localhost 回调地址会放在 `chrome.storage.session`，仅在本次浏览器会话中保留，方便你复制；回调中可能含有一次性授权信息，使用完应点击“清除”。

完整的原项目函数对照和每一步说明见 [docs/flowpilot-openai-login-map.md](docs/flowpilot-openai-login-map.md)。

## 项目结构

```text
manifest.json                     MV3 入口、动态注入和导航监听权限
sidepanel/                        查询界面与九步学习界面
background/background.js          service worker：消息路由、内容脚本注入、回调监听
background/sub2api-client.js      SUB2API 只读客户端和候选账号筛选
background/openai-learning.js     可测试的验证码适配器和 localhost 回调边界
content/openai-login-learning.js  当前 OpenAI 页面上的 DOM 查找、填写和点击
docs/                             FlowPilot 原函数到教学版函数的对照
test/                             纯 Node 单元测试
```

## 学习顺序

1. 从 `manifest.json` 看为什么学习流程需要 `scripting` 和 `webNavigation`，而 SUB2API 请求仍使用可选站点权限。
2. 看 [sidepanel/sidepanel.js](sidepanel/sidepanel.js)：按钮 -> 权限 -> `runtime.sendMessage`。
3. 看 [background/background.js](background/background.js)：消息 -> 当前标签 -> 注入内容脚本；以及 localhost 导航 -> session 状态。
4. 看 [content/openai-login-learning.js](content/openai-login-learning.js)：每个步骤旁边都有对应的 FlowPilot 原函数名。
5. 对照 [docs/flowpilot-openai-login-map.md](docs/flowpilot-openai-login-map.md)，理解为什么原版要处理更多重试和邮箱服务商分支。
6. 运行 `npm test`，查看回调地址过滤、验证码适配器和既有只读查询断言。
