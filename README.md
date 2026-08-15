# sub2api reoauth

## 作者亲笔：


插件功能：填写sub2api的地址和秘钥以后，查询相应分组的错误账号，并依次执行重新授权操作，只能读取qq邮箱，获得回调地址后通过api写入sub2api，并将状态设置为可用。账号的密码需要在第三步那里填写一下。

本人一直在使用sub2api管理我的gpt free账号池，大概几百个账号吧，但是最近开始大批量显示错误，需要重新授权了，但是一个一个点击太费劲了，使用qq邮箱接收验证码，是从icloud转发过来的，我的密码都是一样的，只在第三步那里填一下就好，如果有不一样的，可以让ai给改一下，亲测可用（有限测试，可能不稳）。

# 介绍：

`sub2api reoauth` 是一个与 `FlowPilot` 分离的 Manifest V3 Chrome 扩展。它保留了重新授权真正需要的路径，同时把页面操作拆成可以单独观察和学习的步骤。

它适合已经用 SUB2API 管理 OpenAI OAuth 账号、希望处理待重授权账号，同时想看懂浏览器扩展、内容脚本、回调捕获和邮箱取码是如何协作的人。

## 能做什么

- 查询指定 SUB2API 分组中状态为 `error` 或 `temp_unschedulable` 的 OpenAI OAuth 账号。
- 显示查询到的邮箱总数、账号 ID、状态、代理和错误信息。
- 为查询结果中的第一个账号生成重授权地址，并在新标签页打开 OpenAI 登录页。
- 按第 0 到第 10 步手动执行邮箱登录、密码提交、QQ 邮箱取码、OAuth 授权、localhost 回调捕获和 SUB2API 更新。
- 按设置的轮数顺序运行完整演示；验证码缺失时跳过当前账号，其他关键失败会停下等待处理。
- 在第 5 步只读取第 4 步快照之后的新邮件，并核对候选邮件身份，避免把手动打开的旧邮件验证码误填回页面。

## 使用前准备

1. 已能在浏览器中登录 QQ 邮箱，并能进入收件箱。
2. 已准备好 SUB2API 地址、管理员账号、管理员密码和目标分组名。
3. 已准备好要用于 OpenAI 登录的密码；账号邮箱由查询结果带入，也可以在第 1 步手动修改。
4. SUB2API 已为 OpenAI OAuth 配置 localhost 回调地址；完成授权后浏览器应跳转到类似 `http://localhost:1455/auth/callback?...` 的地址。
5. 首次使用时允许 Chrome 请求对应站点的访问权限。拒绝权限后，扩展无法读取当前 OpenAI 或 QQ 页面。

## 安装与更新

1. 打开 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本项目目录或已同步的扩展目录。
4. 点击扩展图标，侧边栏会打开 `sub2api reoauth`。
5. 代码更新后，在 `chrome://extensions/` 找到该扩展并点击刷新图标；Chrome 不会自动重新读取已加载扩展的后台脚本。

## 先查询，再选择流程

在侧边栏顶部填写连接信息后点击“查询账号”。

| 字段 | 填写内容 | 说明 |
| --- | --- | --- |
| SUB2API 地址 | 管理后台所在地址 | 可填写带或不带 `/admin/accounts` 的地址，扩展会规范化为服务根地址。 |
| 账号 / 密码 | SUB2API 管理员凭据 | 用于调用后台管理接口。 |
| 分组 | 目标 OpenAI 分组名 | 默认值是 `codex 错误`，需要与你的 SUB2API 分组名称一致。 |
| 演示轮数 | 1 到 50 | 完整演示会从查询结果顶部依次处理这么多账号。 |
| 邮箱等待时长 | 1 到 600 秒，默认 60 | 第 5 步等待本次新验证码的最长时间。 |

查询会先尝试 OpenAI 平台的分组列表，必要时再回退到完整分组列表；找不到分组时，错误信息会显示接口实际返回的部分分组名，方便核对。

## 两种使用方式

### 手动学习模式

适合第一次使用、需要观察每个页面变化或某一步失败后单独重试。先完成上方查询，再按顺序点击第 0 到第 10 步。

| 步骤 | 动作 | 结果 |
| --- | --- | --- |
| 0 | 打开首个账号的重授权页 | 在新标签页生成并打开该账号的 OAuth 登录地址。 |
| 1–2 | 填写邮箱并继续 | 进入 OpenAI 密码页。 |
| 3–4 | 填写密码并继续 | 先准备 QQ 收件箱快照，再提交密码并等待验证码页。 |
| 5 | 从 QQ 邮箱获取验证码 | 只等待新邮件；取得后自动切回 OpenAI 标签。 |
| 6–7 | 填写并提交验证码 | 进入 OAuth 授权确认页。 |
| 8 | 授权并继续 | 先启动回调监听，再确认 OAuth 授权。 |
| 9 | 取得 localhost 回调地址 | 侧边栏显示捕获到的完整回调地址。 |
| 10 | 推送到 SUB2API | 交换 `code`，更新第 0 步选中的原账号并恢复可调度状态。 |

第 0 步只创建授权会话并打开页面，不会更新账号。真正会写入 SUB2API 的动作只有第 10 步。

### 完整演示

“演示完整流程”会把同一套步骤顺序执行。开始前建议确认：QQ 邮箱已登录、OpenAI 密码已填写、SUB2API 查询成功、浏览器可以打开 localhost 回调。

- 每一轮都会使用第 4 步建立的邮件快照，只接受之后到达的 OpenAI/ChatGPT 验证码。
- 第 5 步没有等到本次验证码时，当前账号会被记为跳过并继续下一账号。
- QQ 未登录、页面元素变化、OAuth 授权未生效或 localhost 回调超时，会停止完整演示，避免在未知状态下继续写入账号。
- 每轮结束后，扩展会关闭它自己打开的授权和 QQ 邮箱标签，不会主动关闭你原先已打开的网页。

## 权限与数据

扩展按用户动作请求站点访问权限，而不是安装时一次性访问所有页面。

| 数据或权限 | 用途 | 保存位置 / 边界 |
| --- | --- | --- |
| SUB2API 地址、管理员账号密码、OpenAI 登录密码 | 恢复侧边栏表单，减少重复填写 | `chrome.storage.local`，仅保存在当前 Chrome 配置中。请勿在共享电脑上保存敏感密码。 |
| 验证码和 localhost 回调 | 完成本次登录和重授权 | `chrome.storage.session`，浏览器会话结束后清除。 |
| QQ 邮箱登录态 | 读取本次新验证码 | 只使用浏览器已存在的登录态；扩展不读取、不保存 QQ 密码。 |
| OpenAI、QQ、localhost、SUB2API 站点权限 | 注入内容脚本、捕获回调、调用管理接口 | 在对应按钮执行时由 Chrome 弹窗请求。 |

## SUB2API 操作边界

查询与准备阶段只会调用：

1. `POST /api/v1/auth/login`
2. `GET /api/v1/admin/groups/all`
3. `GET /api/v1/admin/accounts?...`
4. `POST /api/v1/admin/openai/generate-auth-url`

第 10 步才会交换回调授权码，并通过账号更新接口写入新的 OAuth 凭据、恢复账号状态和清理旧错误信息。不会新增账号，也不会删除账号。

## 常见问题

### 查询不到账号

- 先确认 SUB2API 地址、管理员账号和密码能够登录管理后台。
- 检查分组名是否完全一致，尤其是空格、中文字符和“错误/可用”等后缀。
- 查询结果只包含 OpenAI OAuth 账号以及默认的异常状态；其他平台、其他认证类型或正常账号不会出现在列表中。

### 第 4 步提示 QQ 收件箱未就绪

扩展会自动打开 QQ 邮箱，但不会替你登录。请在该标签页完成登录、进入收件箱后，回到侧边栏重新点击第 4 步；随后重新发送 OpenAI 验证码，再执行第 5 步。

### 第 5 步没有拿到验证码

- 确认验证码是第 4 步建立快照之后新收到的邮件。
- 检查 QQ 邮箱是否停在收件箱，以及邮件是否被投递到其他文件夹。
- 增加“邮箱等待时长”，或回到 OpenAI 页面重新发送验证码。
- 扩展会拒绝旧邮件和身份无法确认的邮件详情，这是为了避免填入过期验证码。

### 第 8 步点击后仍停在 OAuth 页面

先确认当前标签确实是授权确认页，再重试第 8 步。完整演示会尝试不同的点击策略；手动模式下可以直接观察页面是否出现新的跳转。

### 第 9 步没有回调地址

确认授权完成后浏览器是否跳转到 `http://localhost/...` 或 `https://localhost/...`。非 localhost 地址会被扩展忽略；如果本机端口被占用或回调服务未运行，需要先处理本机回调环境。

### 改了代码但 Chrome 里还是旧版本

确认你更新的是 Chrome 当前加载的目录，然后回到 `chrome://extensions/` 点击扩展的刷新图标。服务 worker 和内容脚本必须重新加载后才会使用新代码。

## 项目结构

```text
manifest.json                     MV3 入口、权限和后台脚本声明
sidepanel/                        查询界面、0–10 步按钮、完整演示与状态展示
background/background.js          消息路由、标签管理、QQ 验证码任务、回调监听
background/sub2api-client.js      SUB2API 查询、授权地址生成、回调交换和账号更新
background/openai-learning.js     与 Chrome API 无关的验证码和 localhost 边界函数
content/openai-login-learning.js  OpenAI 页面上的查找、填写、点击和 OAuth 确认
content/qq-mail-learning.js       QQ 收件箱快照、新邮件筛选和验证码正文校验
docs/                             FlowPilot 原函数与教学版函数的对应关系
test/                             可直接由 Node 运行的回归测试
```

## 建议的学习顺序

1. 从 `manifest.json` 看 `sidePanel`、`scripting`、`tabs`、`webNavigation` 和 `alarms` 分别解决什么问题。
2. 阅读 [sidepanel/sidepanel.js](sidepanel/sidepanel.js)，理解按钮如何先申请权限，再通过 `runtime.sendMessage` 交给后台。
3. 阅读 [background/background.js](background/background.js)，重点看验证码任务的创建、短检查、状态保存和回调监听。
4. 阅读 [content/openai-login-learning.js](content/openai-login-learning.js) 与 [content/qq-mail-learning.js](content/qq-mail-learning.js)，把页面 DOM 操作和后台消息对应起来。
5. 对照 [docs/flowpilot-openai-login-map.md](docs/flowpilot-openai-login-map.md)，理解教学版为什么只保留正常路径，而 FlowPilot 需要处理更多邮箱服务商和恢复分支。
6. 运行 `npm test`，从回归测试里看“旧任务不能覆盖新任务”“旧邮件不能当作新验证码”等边界如何被固定下来。

## 开发与验证

```bash
npm test
node --check background/background.js
node --check content/qq-mail-learning.js
```

完整的 FlowPilot 函数对照和每一步调用路径见 [docs/flowpilot-openai-login-map.md](docs/flowpilot-openai-login-map.md)。
