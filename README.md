# sub2api reoauth

一个与 `FlowPilot` 分离的最小 Manifest V3 Chrome 扩展。它在侧边栏中查询指定 SUB2API 分组内、需要重新授权的 OpenAI OAuth 账号。

## 安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本项目目录。
4. 点击扩展图标打开侧边栏。
5. 首次查询某个 SUB2API 地址时，Chrome 会请求该站点的访问权限。

## 只读边界

扩展只会执行以下请求：

1. 登录：`POST /api/v1/auth/login`
2. 读取分组：`GET /api/v1/admin/groups/all`
3. 读取账号列表：`GET /api/v1/admin/accounts?...`

它不会生成授权链接、交换授权码、创建账号、更新账号、删除账号或清除错误状态。扩展只保存地址、管理员账号和分组；管理员密码仅保留在当前侧边栏页面内，不写入 Chrome 存储。

分组匹配会先尝试 `platform=openai` 的列表，再回退到完整分组列表，并兼容数组、`items`、`groups` 等返回结构。找不到时，错误信息会显示接口实际返回的前 20 个分组名。

## 项目结构

```text
manifest.json                 MV3 入口和最小权限
sidepanel/                    查询界面、权限请求、消息发送
background/background.js      service worker 消息入口
background/sub2api-client.js  SUB2API 只读客户端和候选账号筛选
test/                         纯 Node 单元测试
```

## 学习顺序

1. 从 `manifest.json` 了解 side panel、service worker 和可选站点权限。
2. 看 `sidepanel/sidepanel.js`：表单 -> 当前站点权限 -> runtime message。
3. 看 `background/background.js`：消息 -> 只读客户端。
4. 看 `background/sub2api-client.js`：登录、查分组、分页查账号、按 `openai/oauth` 与异常状态筛选。
5. 运行 `npm test`，查看模拟 API 响应下的分组回退和只读断言。
