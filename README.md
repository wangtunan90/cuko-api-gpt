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

## 待验证

- 真机端到端（需 ChatGPT 账号登录）
- 多模态文件输入（ChatGPT 支持图片/文件，待实现）
- 账号组轮换 / 转移对话（从 one-chrome-ex 移植）
