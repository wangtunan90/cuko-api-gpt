# cuko-api-gpt

把 **ChatGPT 网页版**（[chatgpt.com](https://chatgpt.com)）的聊天能力，通过 CDP 驱动独立 Chrome，
暴露成符合 **Cuko API** 契约的 HTTP/SSE 服务。

> 姊妹项目：one-chrome-ex（DeepSeek 版）、cuko-api-quick（Amazon Quick 版）。三者架构一致，差异在「怎么把网页版的响应捞出来」。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [快速开始](#快速开始)
- [在客户端里配置](#在客户端里配置)
- [调用示例](#调用示例)
- [端口配置](#端口配置)
- [配置方案](#配置方案)
- [端点](#端点)
- [它是怎么工作的](#它是怎么工作的)
- [踩过的坑](#踩过的坑)
- [目录结构](#目录结构)
- [打包成 exe](#打包成-exe)
- [验证](#验证)
- [常见问题](#常见问题)
- [数据与备份](#数据与备份)
- [已知限制](#已知限制)
- [免责声明](#免责声明)

---

## 它解决什么问题

Cuko API 是给 **Stateful Provider** 设计的协议：客户端只发当前这一句，上下文由 Provider 自己维护。
ChatGPT 网页版需要登录、需要点按、用 SSE 推流，两者对不上。本项目就是中间那层桥：

```
Cuko 客户端 ──HTTP/SSE──▶ bridge ──CDP──▶ 独立 Chrome ──▶ chatgpt.com
```

- 替你填好输入框、点发送
- 经 CDP 旁听页面的 `/backend-api/conversation` 响应流，翻译成 Cuko 的 SSE 事件（边生成边推）
- 把 ChatGPT 的 `conversation_id` 映射成 `providerSessionId`，实现多轮续接（重启后仍有效）
- 多账号：每个账号独立 Chrome profile + 独立调试端口，登录态互不干扰

---

## 快速开始

### 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | **Windows**（其它平台未验证） |
| Node.js | >= 18（仅源码运行需要；exe 版不需要） |
| 浏览器 | 本机已安装 **Chrome** |
| 账号 | 一个能正常登录的 ChatGPT 账号 |

### 第一步：启动服务

**方式 A：源码运行**

```bash
npm install
npm start
```

**方式 B：单文件 exe**

从 Release 下载 `cuko-api-gpt-<版本>.exe`（或自行[打包](#打包成-exe)），双击运行，不需要装 Node。

看到这样的输出就说明起来了：

```
[bridge] 日志落盘: ...\data\logs\bridge-2026-11-23.log
[cuko-api-gpt] 运行在 http://127.0.0.1:3001（端口来源：data/config.json）
[cuko-api-gpt] 管理台: http://127.0.0.1:3001/
```

### 第二步：添加账号

浏览器打开 **<http://127.0.0.1:3001/>**，在「账号」卡片里填：

| 字段 | 说明 | 示例 |
|---|---|---|
| 模型 ID | 客户端里用的 `model`，只能英文、数字、下划线、中划线 | `gpt-main` |
| 显示名称 | 给人看的名字 | `GPT 主账号` |
| 配置方案 | 先用默认方案 | `默认方案` |

点 **「添加并启动 Chrome」**，会弹出一个独立 Chrome 窗口：

- 用户数据目录是 `data/profiles/<模型ID>/`，和你平时的 Chrome 完全隔离
- 调试端口从 9333 开始自动递增

### 第三步：在弹出的 Chrome 里登录 chatgpt.com

登录后确认能看到聊天输入框。登录态存在 `data/profiles/<模型ID>/`，下次启动还在。

> 注意：chatgpt.com **不登录也能聊天（访客模式）**。服务会识别页面上的「登录」按钮，访客状态下拒绝请求，请务必登录。

### 第四步：检查账号

回到管理台点账号行的 **「检查」**：

| 结果 | 含义 |
|---|---|
| `ok` | 已登录、输入框可用 |
| `login_required` | 在登录页或访客状态，回 Chrome 窗口登录 |
| `error` | Chrome 没开 / 页面没加载完，点「打开」 |

---

## 在客户端里配置

以 Cuckoo 客户端为例，「设置 → Cuko API → 自定义模型 API」：

| 配置项 | 填什么 |
|---|---|
| API 地址 | `http://127.0.0.1:3001`（与服务实际端口一致） |
| API 协议 | `Cuko API (SSE)` |
| API 密钥 | **留空** |
| 模型目录 | 点「获取可用模型」，选你的账号 |

---

## 调用示例

### 列模型

```bash
curl http://127.0.0.1:3001/v1/models
# {"data":[{"id":"gpt-main","name":"GPT 主账号"}]}
```

### 新建对话（流式）

```bash
curl -N http://127.0.0.1:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-main","requestId":"req-1","cuckSessionId":"cuck-1","input":[{"type":"text","text":"你好"}]}'
```

返回（拿到 conversation_id 后先推会话 ID，之后逐段推增量）：

```
event: message
data: {"cuckSessionId":"cuck-1","providerSessionId":"54a6f6c1-...","output":[]}

event: message
data: {"output":["你好！有什么"]}

event: message
data: {"output":["可以帮你的？"]}

event: done
data: {"finishReason":"stop","usage":{"input_tokens":2,"output_tokens":9,"total_tokens":11},"providerSessionId":"54a6f6c1-..."}
```

### 续接对话

带上上一轮的 `providerSessionId`（同一 `cuckSessionId`、同一 `model`）：

```bash
curl -N http://127.0.0.1:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-main","requestId":"req-2","cuckSessionId":"cuck-1","providerSessionId":"54a6f6c1-...","input":[{"type":"text","text":"我刚才说了什么？"}]}'
```

### 历史压缩（切换模型时）

`type: "compress"`，不能带 `providerSessionId`。各段以空行拼成一条消息，在新对话里发出。

### 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` | 缺字段、会话不存在/不匹配、文件输入 |
| 401 | `authentication_required` | 未登录或访客状态 |
| 409 | `idempotency_conflict` | `requestId` 重复 |
| 429 | `rate_limit_exceeded` | 该账号正在处理另一请求 |
| SSE error | `request_timeout` / `provider_unavailable` | 超时、页面异常 |

---

## 端口配置

默认 **3001**（与 one-chrome-ex 的 3000 区分）。优先级：

```
内置默认 3001  <  data/config.json  <  环境变量 CUKO_HTTP_PORT
```

- **改配置文件（推荐）**：首次启动自动生成 `data/config.json`，改 `port` 后重启
- **环境变量（临时）**：`set CUKO_HTTP_PORT=3002 && npm start`（exe 同理）
- 端口被占用时，程序会直接打印三种处理办法
- 配置文件写坏或端口非法会告警并回退默认值，不会起不来
- 改了端口，**客户端的 API 地址也要改**

---

## 配置方案

所有行为参数由配置方案驱动，在管理台「配置方案」卡片里管理（直接编辑 JSON）：

- **默认方案**：在 `bridge/default-config.js` 里，只读
- **自定义方案**：「从默认方案复制新建」后修改；删掉方案后，绑定它的账号自动回退默认
- 时间单位是**秒**，等待类字段在 `[min, max]` 内随机取值，模拟真人节奏

| 字段 | 默认 | 说明 |
|---|---|---|
| `chromePath` | 空 | Chrome 路径，留空自动探测 |
| `extraArgs` | 空 | 额外启动参数，如 `--proxy-server=http://127.0.0.1:7890` |
| `targetUrl` | `https://chatgpt.com/` | 启动时打开的页面 |
| `connectPollMaxSec` | 25 | 等 Chrome 调试端口就绪 |
| `pageReadyPollMaxSec` | 20 | 等输入框出现 |
| `requestTimeoutSec` | 600 | 单次请求硬超时（卡死由 90 秒空闲超时负责） |
| `preEnterWaitMinSec` / `MaxSec` | 2.0 / 5.0 | 填完文字到点发送的等待。嫌慢可调到 0.5 / 1.5 |
| `disableBackgroundThrottling` | true | 防后台节流，**必须开** |

---

## 端点

### Cuko API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 模型（账号）列表 |
| POST | `/v1/responses` | 发送消息（SSE） |

### 管理 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 管理台 |
| GET | `/test-stream.html` | 流式测试页 |
| GET | `/api/info` | 当前地址、端口来源、版本 |
| GET | `/api/accounts` | 账号列表（含 online/offline、是否处理中） |
| POST | `/api/accounts` | 新增账号（自动启动 Chrome） |
| PUT | `/api/accounts/:id` | 改显示名称 / 换配置方案 |
| DELETE | `/api/accounts/:id` | 删除账号；`?purge=1` 同时删 Chrome 登录数据（不可恢复） |
| POST | `/api/accounts/:id/open` | 打开 Chrome |
| GET | `/api/accounts/:id/health` | 健康检查 |
| GET / POST | `/api/profiles` | 配置方案列表 / 新建 |
| PUT / DELETE | `/api/profiles/:id` | 修改 / 删除方案 |

---

## 它是怎么工作的

### 一次请求的流程

1. 校验参数（幂等、并发锁、会话归属）
2. 取该账号的常驻 CDP 连接；端口不通就自动启动 Chrome
3. 登录检查（URL + 页面登录按钮/头像）
4. 新对话导航回首页；续接导航到 `/c/<conversationId>`（已在该页则不动）
5. 等输入框 → 挂网络监听 → 填文字 → 鼠标点击发送
6. 拦截 `POST /backend-api/(f/)?conversation` 的响应流，经 `Network.streamResourceContent` 实时拿数据
7. 解析出正文增量逐段推给客户端；收到 `end_turn: true` 后推 `done`

### 发送：驱动页面

输入框是 **ProseMirror**（contenteditable），不是 textarea：

- 用 `document.execCommand('insertText')` 整块写入，写完读回校验（不足 90% 重试）
- 发送靠**真实鼠标点击**发送按钮，Enter 只作兜底

### 接收：解析 SSE 增量

ChatGPT 的响应是带 JSON Patch 风格操作的 SSE：消息快照（`v.message`）+ 路径操作（`p` / `o` / `v`，含 append / replace / truncate）。
`bridge/extractor.js` 是这套状态机，详见 [docs/protocols/chatgpt-web-protocol.md](docs/protocols/chatgpt-web-protocol.md)。

保护机制：90 秒空闲超时、总超时、20 秒心跳、客户端断开立即中止。

---

## 踩过的坑

| 坑 | 结论 |
|---|---|
| **同一流里多条 assistant 消息** | 思考、工具调用、正文会交错，必须按 `message.id` 分段，只拼 `channel=final` + `recipient=all` + `content_type=text` 的段 |
| **只有 end_turn=true 才算结束** | 快照里初始是 `end_turn:false`，靠后续 patch 置 true |
| **不能按内容去重** | 增量帧不含任何 id，两次追加相同文本时帧完全相同，去重会缺字（见提交 e6cbf11） |
| **剪贴板粘贴会变成附件** | ProseMirror 会把合成 paste 识别成文件，必须用 insertText |
| **大段文字分块插入会卡死** | 实测分块和 `execCommand('delete')` 都会卡，改为全选 + 整块 insertText |
| **新对话必须回首页** | 否则会接在上一个旧对话后面 |
| **导航后要等 readyState** | DOM 出现但编辑器未挂载时写入无效 |
| **conversation_id 在帧顶层** | 不在 message 里，只从 message 取会导致续接失效 |
| **访客模式能聊天** | 只看 URL 判断登录会误判，要看页面元素 |
| **Chrome 被父进程回收** | 用 `spawn(detached:true)` + `unref()` |

---

## 目录结构

```
bridge/
  index.js            HTTP 服务、Cuko 路由、管理 API、拦截主流程
  core.js             账号 / 配置方案 / Chrome 启动
  cdp-connection.js   每账号常驻 CDP 连接 + 事件作用域
  chatgpt-driver.js   输入框、填文字、点发送、登录检查
  sse.js              SSE 帧解码
  extractor.js        ★ ChatGPT SSE 解析状态机
  input.js            输入项归一化
  session-store.js    会话映射持久化
  runtime-config.js   端口 / 监听地址
  logger.js           日志落盘
  default-config.js   默认配置方案与校验
  app-paths.js        运行目录解析（源码 / exe）
ui/index.html         管理台（单文件）
test-stream.html      流式测试页
test/
  sample-sse.txt      真实抓包样本
  run-extractor.mjs   离线解析测试（npm test）
scripts/build-exe.mjs 打包 exe
docs/protocols/       协议文档
.github/workflows/    自动打包发布
```

---

## 打包成 exe

需要 Node.js >= 25.5（内置 `--build-sea`），在 Windows 上：

```bash
npm install
npm run build:exe
```

产物：

```
dist/
  cuko-api-gpt.exe   约 100 MB，自带 Node 运行时
  使用说明.txt
```

- 先用 esbuild 打成单个 ESM，再用 Node SEA 注入 node 二进制
- `ui/index.html`、`test-stream.html` 作为资源内嵌进 exe
- `data/` 不打进去，首次运行在 **exe 同目录**自动创建
- 构建脚本会自动找支持 `--build-sea` 的 node，也可用环境变量 `NODE_SEA_BIN` 指定

### 自动发布（GitHub Actions）

推送 tag 即自动构建并发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```

也可以在 GitHub 网页 **Actions → Release EXE → Run workflow** 手动触发，或直接发布 Release。

| 步骤 | 内容 |
|---|---|
| 环境 | `windows-latest` + Node 26 |
| 测试 | `npm test` |
| 构建 | `npm run build:exe` |
| 校验 | exe 存在且 > 50 MB |
| 冒烟 | 启动 exe，请求 `/v1/models`、`/`、`/api/info` |
| 发布 | 上传 `cuko-api-gpt-<tag>.exe` + 说明到 Release |

---

## 验证

```bash
npm test
```

用真实抓包样本，在 6 种 chunk 切分（1 / 7 / 50 / 200 / 1024 / 全量）下验证解析结果完全一致。

已真机实测：新建对话、边生成边推送（480 字分 18 段）、会话续接、健康检查、管理台、exe 冒烟。

---

## 常见问题

**Q：Chrome 被关了怎么办？**
不用管，请求时检测到调试端口不通会自动拉起 Chrome。前提是这个 profile 之前登录过。

**Q：健康检查显示 `login_required`**
点「打开」，在弹出的 Chrome 窗口里登录。访客状态（页面有「登录」按钮）也算未登录。

**Q：报「输入框未就绪」**
页面没加载完、Chrome 没开，或窗口被导航到了别的网站。点「打开」后等一会儿再试。

**Q：返回 429**
同一账号同时只能跑一轮对话。要并发请加多个账号。

**Q：exe 双击一闪而过**
多半是端口被占用。在命令行里运行 `cuko-api-gpt.exe` 能看到原因。

**Q：SmartScreen 拦截了 exe**
exe 未签名，选「更多信息 → 仍要运行」。

**Q：第一个字要等十几秒**
含发送前随机等待（2～5 秒）和模型思考时间。新建一个配置方案，调小 `preEnterWait*`。

---

## 数据与备份

所有运行时数据在 **`data/`**（exe 版在 exe 同级目录）：

```
data/
  config.json            端口 / 监听地址
  accounts.json          账号列表
  config-profiles.json   自定义配置方案
  sessions.json          providerSessionId ↔ conversation_id 映射
  logs/                  运行日志，按天分文件
  profiles/<模型ID>/      Chrome 用户数据（★ 登录态）
```

- **迁移/备份**：整个 `data/` 拷走即可
- `data/profiles/` 含登录凭据，**不要提交到 Git、不要分享**（已在 `.gitignore`）

---

## 已知限制

- **单账号单并发**：并发请求返回 429，不排队
- **只支持文本输入**：文件/图片未实现，文件输入返回 400
- **断线续传未接入**：生成中断线、页面自动续传时，续传请求的数据收不到，回复可能缺尾
- **客户端断开不停止生成**：服务停止接收，但页面上的回答还会继续
- **依赖页面结构**：选择器基于当前 DOM，ChatGPT 改版可能失效（集中在 `bridge/chatgpt-driver.js`）
- **仅 Windows 验证**
- **无账号组 / 转移对话**：one-chrome-ex 的功能未移植

---

## 免责声明

本项目通过自动化驱动网页界面工作，**与 OpenAI 无任何关联**，非官方实现。
请仅在你拥有或获得明确授权的账号上使用，并遵守相关服务条款。
使用自动化手段访问服务可能违反其条款，账号可能被限制或封禁，请自行评估风险。
