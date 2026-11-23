# cuko-api-gpt

Cuko Provider for ChatGPT web (Stateful Provider).

> 通过 CDP 控制独立 Chrome 窗口，与 chatgpt.com 交互，对外暴露 Cuko API 契约。
> 姊妹项目：one-chrome-ex（DeepSeek 版）。

## 状态

骨架完成（B 阶段）。已实现：
- 账号管理 / 配置方案 / Chrome 启动（端口隔离）
- 常驻 CDP 连接（target 匹配 chatgpt.com）
- ChatGPT 页面驱动（ProseMirror 填文本 + 鼠标点击发送）
- SSE 拦截解析（`/backend-api/(f/)?conversation`，按 message.id 分段、end_turn 派发、帧重放去重）
- Cuko API：`GET /v1/models`、`POST /v1/responses`
- 空闲超时 90s + 总超时 600s + 20s 心跳 + 客户端断开中止
- 管理台：`http://127.0.0.1:3001/`

离线验证通过：真实抓包样本在 6 种 chunk 切分下解析结果完全一致。

## 快速开始

```bash
npm install
# 把 accounts.example.json 复制为 data/accounts.json 并按需修改
npm start
```

服务跑在 `http://127.0.0.1:3001`。

## 协议文档

`docs/protocols/chatgpt-web-protocol.md` — ChatGPT 网页 SSE 协议的完整分析（含实测抓包附录）。

## 目录

```
bridge/
  index.js              HTTP 服务 + Cuko 路由 + 拦截链路
  core.js               账号/方案/Chrome 启动
  cdp-connection.js     常驻 CDP 连接
  chatgpt-driver.js     ProseMirror 填文本 + 鼠标点击发送
  sse.js                SSE 帧解码
  extractor.js          ChatGPT SSE 解析状态机
  app-paths.js          运行目录解析
  default-config.js     默认配置方案
ui/index.html           管理台
test/
  sample-sse.txt        真实抓包样本
  run-extractor.mjs     离线验证脚本
docs/protocols/         协议文档
```

## [261123] 新增功能（参考 cuko-api-quick）

- **端口配置**：`data/config.json`（首次启动自动生成）或环境变量 `CUKO_HTTP_PORT`，默认 3001；端口占用会给出处理建议
- **日志落盘**：`data/logs/bridge-YYYY-MM-DD.log`
- **会话持久化**：`data/sessions.json`，重启后 providerSessionId 仍可续接
- **流式推送**：拿到 conversation_id 后先推 providerSessionId，之后逐段推增量
- **输入兼容**：`text` / `content` 字符串 / `content` 数组；文件输入仍明确报 400
- **登录判断**：URL + 页面登录按钮/头像，避免访客模式误用
- **历史压缩**：`type=compress` 多段以空行拼接，强制新对话

### 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/info` | 当前地址、端口来源、版本 |
| GET | `/api/accounts` | 账号列表（含 online/offline、是否处理中） |
| POST | `/api/accounts` | 新增账号（调试端口从 9333 递增，自动启动 Chrome） |
| PUT | `/api/accounts/:id` | 改显示名称 / 换配置方案 |
| DELETE | `/api/accounts/:id` | 删除账号；加 `?purge=1` 同时删 Chrome 登录数据 |
| POST | `/api/accounts/:id/open` | 打开 Chrome |
| GET | `/api/accounts/:id/health` | 健康检查：ok / login_required / error |
| GET/POST | `/api/profiles` | 配置方案列表 / 新建 |
| PUT/DELETE | `/api/profiles/:id` | 修改 / 删除方案（默认方案只读） |

## 待验证

- 真机端到端（需 ChatGPT 账号登录）
- 多模态文件输入（ChatGPT 支持图片/文件，待实现）
- 账号组轮换 / 转移对话（从 one-chrome-ex 移植）
