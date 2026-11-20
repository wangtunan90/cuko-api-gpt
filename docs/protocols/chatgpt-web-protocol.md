# ChatGPT Web 协议分析（SSE 流式）

> 来源：`cuckoo-code` 项目 `src/providers/hooks/chatgpt.ts`（745 行）+ `src/providers/chatgpt.ts`（226 行）
> 目的：作为 `cuko-api-gpt` 开发的唯一协议依据。cuko-api-gpt 用 CDP 拦截，不用注入 hook，但 SSE 解析逻辑可完全照搬。
> 日期：2026-11-20

---

## 一、要拦截的请求

### 1.1 主目标：会话流式接口

```
POST https://chatgpt.com/backend-api/conversation
POST https://chatgpt.com/backend-api/f/conversation      ← 部分账号/灰度路由带 f/ 前缀
```

匹配规则：

```js
var CONVERSATION_RE = /\/backend-api\/(?:f\/)?conversation\/?$/;
function isCompletion(url, method) {
  if (String(method || 'GET').toUpperCase() !== 'POST') return false;
  var u = new URL(url, document.baseURI);
  var host = u.hostname || '';
  if (host.indexOf('chatgpt.com') === -1 && host.indexOf('chat.openai.com') === -1) return false;
  return CONVERSATION_RE.test(u.pathname || '');
}
```

响应 `Content-Type: text/event-stream`。

### 1.2 辅助目标：停止请求（只用来标记「用户主动停止」）

```
PATCH  | DELETE  /backend-api/(f/)?conversation/<id>
或路径含 /stop | /interrupt | /cancel(_generation)?
```

```js
var STOP_RE = /\/backend-api\/(?:f\/)?conversation\/[^\/]+$/;
var STOP_PATH_RE = /\/(stop|interrupt|cancel)(_generation)?\/?$/i;
function isStopRequest(url, method) {
  var u = new URL(url, document.baseURI);
  if (!isOurHost(u)) return false;
  var path = u.pathname || '';
  if (path.indexOf('/backend-api/') === -1) return false;
  if (STOP_PATH_RE.test(path)) return true;
  var upper = String(method || 'GET').toUpperCase();
  if (STOP_RE.test(path) && (upper === 'PATCH' || upper === 'DELETE')) return true;
  return false;
}
```

**只认「方法 + 路径」这种结构性证据，不看 body 文本**——用户提问内容本身可能含 "stop" 等词，看 body 会误判。

### 1.3 限流识别

ChatGPT 除 HTTP 429 外，还会用「usage cap / Too many requests」等文案搭配其它状态码表达限速。响应体关键词（小写匹配）：

```
too many requests, rate limit, rate_limit, too fast, slow down,
you've hit your limit, reached the current usage cap, usage cap,
usage limit, 请稍后再试, 过于频繁
```

---

## 二、cuko-api-gpt 的拦截方式：CDP（不是注入 hook）

`cuckoo-code` 是 Electron 壳，注入 hook 包裹 `window.fetch` / `XMLHttpRequest`。**cuko-api-gpt 用 CDP，不能用 hook**，映射如下：

| cuckoo-code（hook） | cuko-api-gpt（CDP） |
|---|---|
| `window.fetch` 包裹 | `Network.requestWillBeSent` 匹配 URL + method |
| `response.clone().body.getReader()` | `Network.streamResourceContent({requestId})` 拿初始缓冲 + 打开增量 |
| `reader.read()` 循环 | `Network.dataReceived` 事件，`params.data` 是 base64 增量 |
| `r.done` | `Network.loadingFinished` |
| `catch(AbortError)` | `Network.loadingFailed` |
| 读 response headers | `Network.responseReceived` 的 `response.headers` / `response.status` |

**关键顺序**（one-chrome-ex 踩过的坑）：命中 `requestWillBeSent` 后要**先** `streamResourceContent` 打开增量，**再**处理后续 `dataReceived`。反过来会漏掉 await 期间到达的数据。

SSE 解析逻辑（下面第三~五节）与拦截手段无关，可 100% 照搬。

---

## 三、SSE 帧格式

### 3.1 帧切分

```
帧之间用空行分隔：\r?\n\r?\n
每帧内取 data: 开头的行，多行 data 用 \n 拼接
data === '[DONE]' → 终态，置 finished
```

```js
// 共享实现见 cuckoo-code src/providers/hooks/shared/sse.ts
function createFrameDecoder() { /* 缓冲 + 正则切分，注意跨 chunk 边界 */ }
function extractData(block) { /* 取 data: 行 */ }
```

### 3.2 帧重放（必须去重）

可续传流会**重放已发过的帧**（重复帧之间夹着 `message_marker` 等）。若不去重，同一 append 执行两次 → 文本翻倍 → 破坏 cuckoo 围栏 → 提取 0 块。

**全局去重**（不要求相邻）：同一 `observeBody` 内，见过的帧 data 直接跳过。frame data 本身含唯一 id（message_id 等），完全相同即重复。

```js
var seenFrames = {};
if (seenFrames[r.data]) { seenFrames[r.data]++; return; }
seenFrames[r.data] = 1;
```

---

## 四、data 解析后的 5 种形态（`applyOp` 状态机）

每个 data 字符串 `JSON.parse` 后，是以下之一：

### 4.1 批量操作

```js
{ v: [ ...操作... ] }   // v 是数组
```

⚠️ 实测登录态 SSE 的增量帧多为**裸 `{v:[...]}`（无 o 字段）**，仅首帧带 `o:'patch'`。**只判 v 是否数组**，不要只认 `o==='patch'`，否则后续正文帧全被丢弃。

处理：递归对每个元素 `applyOp`。

### 4.2 消息快照（现代形态）

```js
{ v: { message: { ... } } }
```

### 4.3 消息快照（老协议形态，无 v 包裹）

```js
{ message: { ... }, conversation_id: "...", error: null }
```

处理：`handleMessage(node.v.message)` 或 `handleMessage(node.message)`。

### 4.4 路径操作

```js
{ p: '/message/content/parts/0', o: 'append' | 'add' | 'truncate', v: '文本' }
```

| o | 行为 |
|---|---|
| `append` / `add` | `seg.text += v`（先做全局去重，key = `seg|path|value`） |
| `truncate` | `seg.text = seg.text.substring(0, Number(v))` |
| 其他/缺省 | `seg.text = v`（覆盖） |

只处理 `/message/content/parts/\d+$` 这种路径；`/message/status`、`/message/end_turn` 单独处理。

### 4.5 裸 v 字符串

```js
{ v: "文本" }   // 无有效 p
```

处理：追加到当前消息段（仅正文段）。

### 4.6 类型化结束事件

```js
{ type: 'message_stream_complete' | 'message_stream_completed' }
```

处理：置 `finished = true`。

### 4.7 错误信封（老协议）

```js
{ error: {...}, v: undefined, p: undefined }
```

处理：置 `failed = true`。

---

## 五、message 对象的关键字段

### 5.1 只认 assistant

```js
if (m.author && m.author.role !== 'assistant') return;
```

### 5.2 正文判定（决定是否累积）

```js
var isFinalAnswer =
  (m.channel == null || m.channel === 'final') &&
  (m.recipient == null || m.recipient === 'all') &&
  m.content && m.content.content_type === 'text';
```

**只有最终正文才累积**。`commentary`（过程说明）等消息不累积，否则与正文交错拼接、破坏 cuckoo 围栏结构。

### 5.3 content.parts 提取

```js
// content.parts 是数组，元素可能是：
//   - string             → 正文
//   - { text: string, content_type: 'reasoning' | 'thoughts' | 'thinking' }  → 思考
//   - { text: string }   → 正文
function partKind(p) {
  var ct = String(p.content_type || p.type || '').toLowerCase();
  if (ct === 'reasoning' || ct === 'thoughts' || ct === 'thinking') return 'think';
  return 'text';
}
function extractParts(content) {
  if (!content || !Array.isArray(content.parts)) return null;  // 非文本消息返回 null
  var tOut = '', kOut = '';
  for (var i = 0; i < content.parts.length; i++) {
    var p = content.parts[i];
    if (typeof p === 'string') { tOut += p; continue; }
    if (p && typeof p.text === 'string') {
      if (partKind(p) === 'think') kOut += p.text; else tOut += p.text;
    }
  }
  return { text: tOut, think: kOut };
}
```

ChatGPT 目前不向 `/conversation` 流下发推理原文（部分推理模型除外），think 通常为空。

### 5.4 status

```
'finished_successfully'          → finished = true
'interrupted' / 'user_cancelled' → serverStopped = true（服务端判定停止）
'failed' / 'errored'             → failed = true
```

⚠️ **只有真正的文本消息（有 content.parts）才采信 status**。登录态流里 `model_editable_context` 等内部帧 role 也是 assistant、且带 `status='finished_successfully'`，若采信会在正文到达前就 finished=true → 空文本 → error。

### 5.5 stop_reason

```js
function applyStopReason(r) {
  var low = r.toLowerCase();
  // 正常结束原因不能误判成用户停止
  if (low === 'stop' || low === 'max_tokens' || low === 'length' || low === 'content_filter') return;
  if (low.indexOf('cancel') !== -1 || low.indexOf('interrupt') !== -1) serverStopped = true;
}
```

### 5.6 end_turn（整轮结束的唯一信号）

```js
if (m.end_turn === true) { finished = true; endTurn = true; }
```

### 5.7 模型名

```js
// 三处取，优先级如上
m.metadata.model_slug
m.model_slug
m.content.metadata.model_slug
```

ChatGPT **不下发 token 计数**，`tokenUsage.accumulatedTokens` 恒为 null，只能回填 `modelType`（model_slug）。

### 5.8 消息 ID（msgIds）

```js
msgIds.responseMessageId = m.id               // AI 回复消息
msgIds.requestMessageId = m.parent_message_id // 用户提问消息
msgIds.conversationId   = m.conversation_id
```

请求体里也能提前拿（`parseRequestBody`）：
```js
j.parent_message_id  → requestMessageId
j.conversation_id    → conversationId
```

---

## 六、⚠️ 五个必须照做的坑

### 坑 1：同一流里有多条 assistant 消息，必须按 message.id 分段

实测 3 条：**含 cuckoo 块 → 纯文字说明 → 含 cuckoo 块**。若都追加进同一个 text，后一条会接在前一条后面 → 文本交错/重复（实测 `'log(results'+'glob(*)'` 拼在一起、整句重复），破坏 cuckoo 围栏 → 提取 0 块。

**解法**：每条消息一个「段」（`segments[]`，按 `message.id` 索引），快照覆盖本段，最后**只拼接 isFinal 的段**。

```js
var segments = [];
var currentSeg = null;
function segmentFor(id) {
  var key = (typeof id === 'string' && id) ? id : (currentSeg ? currentSeg.id : '(default)');
  for (var si = 0; si < segments.length; si++) {
    if (segments[si].id === key) { currentSeg = segments[si]; return currentSeg; }
  }
  currentSeg = { id: key, text: '' };
  segments.push(currentSeg);
  return currentSeg;
}
function syncText() {
  var out = '';
  for (var sj = 0; sj < segments.length; sj++) {
    if (segments[sj].isFinal) out += segments[sj].text;   // 只拼接正文段
  }
  text = out;
}
```

### 坑 2：只有 end_turn === true 才能派发

某条消息 `finished_successfully` 不代表整轮结束。实测同一轮里 GPT 先发一条**纯文字说明**（finished_successfully 但 end_turn=false），真正的含 cuckoo 块消息在其后 4+ 秒才到达。

**若在「某条消息 finished」就锁死派发，后续含 cuckoo 块的消息会被永久丢弃** → 表现为「输出了块却判为正常文本」。

**解法**：只在 `end_turn === true` 时立即派发。未 end_turn 时交给流关闭（`loadingFinished`）兜底派发。

### 坑 3：帧会重放，必须全局去重

见 3.2。

### 坑 4：正文消息过滤（channel + recipient + content_type）

见 5.2。否则 commentary / model_editable_context 混进来，与正文交错。

### 坑 5：输入框是 ProseMirror，不是 textarea

**这是发送端最关键的坑，跟解析无关但必须知道：**

- ChatGPT 的 ProseMirror 会把 `ClipboardEvent('paste')` 识别为「粘贴的文件」附件（出现 .txt 卡片），文本区却为空 → 发送空内容。**不能用剪贴板 paste**（one-chrome-ex 那套在这里失效）。
- 改用 `document.execCommand('insertText', false, text)` 直接写文本节点，与真实打字等价。长文本分段（每段 5000 字）：
  ```js
  const CHUNK = 5000;
  for (let i = 0; i < text.length; i += CHUNK) {
    document.execCommand('insertText', false, text.slice(i, i + CHUNK));
  }
  ```
- 写完**读回校验**（去空白长度 ≥ 期望的 90%），编辑器可能拒收。
- 发送优先**真实鼠标点击发送按钮**（Enter 依赖页面焦点，后台窗口焦点不在时 Enter 送不到页面）。点击后校验输入框是否被清空（发送成功的标志）。
- 发送按钮选择器（按优先级）：
  ```
  button[data-testid="send-button"]
  button[aria-label="发送提示词"]
  button[aria-label*="发送"]
  button[aria-label*="Send"]
  ```
- 输入框选择器（按优先级，且**必须可见**——页面可能有多个隐藏 ProseMirror）：
  ```
  div[contenteditable="true"].ProseMirror
  div[role="textbox"]
  div.ProseMirror
  div[contenteditable="true"]
  textarea
  ```

---

## 七、终态判定（三态）

```js
function resolveStatus(extractor, aborted) {
  if (userStopped || extractor.serverStopped) return 'stopped';
  if (extractor.failed) return 'error';
  if (aborted) return 'stopped';
  if (extractor.finished) return extractor.textLen === 0 ? 'error' : 'finished';
  if (extractor.textLen > 0) return 'finished';   // 兜底：流关但没等完成标记，有正文视为完成
  return 'error';
}
```

优先级：
1. 用户主动停止（停止类请求 / serverStopped）→ `stopped`
2. 服务端失败（failed）→ `error`
3. 流被 abort → `stopped`（ChatGPT 点停止是 abort 请求，判 stopped 才不触发重试）
4. `finished_successfully` 且正文非空 → `finished`
5. `finished_successfully` 但正文空 → `error`（空回复触发重试）
6. 未收完成标记，但流已结束且有正文 → `finished`（实测 ChatGPT 有时不下发完成标记）
7. 兜底 → `error`

---

## 八、看门狗（空闲超时）

```js
var idleTimeout = parseInt(localStorage.getItem('cuckoo-xhr-idle-timeout') || '') || 300000; // 默认 5 分钟
// 任何数据（含心跳）到达都刷新 lastActiveAt
// 超过 idleTimeout 无数据 → 派发 cuckoo-stream-idle 事件
```

对应 cuko-api-gpt 里就是 one-chrome-ex 那套「空闲超时」机制（收到数据重置计时器，连续 N 秒无数据判卡死）。

---

## 九、会话 ID

从 URL 提取：`/c/{完整 UUID}`

```js
var uuid = href.match(/\/c\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
```

⚠️ 创建会话过程中 URL 有中间态 `/c/WEB:xxx`、`/c/local-chatgpt` 等，**这些不是真实会话 ID**，只认完整 UUID，中间态一律返回 null。

---

## 十、可复用代码清单（从 cuckoo-code 抄）

| 内容 | 位置 | 复用方式 |
|---|---|---|
| SSE 帧解码 `createFrameDecoder` / `extractData` | `hooks/shared/sse.ts` | 直接抄 |
| extractor（分段/去重/applyOp/handleMessage） | `hooks/chatgpt.ts:163-448` | 直接抄（约 280 行核心资产） |
| 帧解析 `parseFrame` | `hooks/chatgpt.ts:453-458` | 直接抄 |
| 请求体元信息 `parseRequestBody` | `hooks/chatgpt.ts:573-583` | 直接抄 |
| 限流文案 `isRateLimitText` | `hooks/chatgpt.ts:72-84` | 直接抄 |
| 输入框/按钮选择器 + fillInput | `chatgpt.ts:25-98` | 抄选择器 + 思路（execCommand insertText） |
| 发送触发 triggerSend | `chatgpt.ts:105-158` | 抄思路（鼠标点击按钮 + 读回校验） |
| 会话 ID 提取 | `chatgpt.ts:206-210` | 直接抄 |

**不能抄的**：`window.fetch` 包裹、`XMLHttpRequest` 包裹、`electronAPI.simulateMouse`（那是 cuckoo-code 特有 API，cuko-api-gpt 用 CDP `Input.dispatchMouseEvent` 替代）。

---

## 十一、cuko-api-gpt 实现映射（待开发）

| 环节 | 实现 |
|---|---|
| 发送文本 | CDP `Runtime.evaluate` 执行 `execCommand('insertText')` + 读回校验 |
| 发送 | CDP `Input.dispatchMouseEvent` 点击发送按钮（坐标从按钮 rect 算） |
| 拦截 | CDP `Network.requestWillBeSent` 匹配 URL → `streamResourceContent` → `dataReceived` → extractor |
| 解析 | 照搬 extractor |
| 超时 | 空闲 90s + 总 600s（沿用 one-chrome-ex 修复后的机制） |
| 停止 | CDP 检测 PATCH/DELETE conversation → 标记 userStopped；或客户端断开时发停止请求 |
| Cuko 错误 | 429 → rate_limit_exceeded；failed → provider_error；空回复 → error |
---

## 附录：实测抓包验证（2026-11-20）

> 来源：用户在浏览器 DevTools 抓到的真实 `POST https://chatgpt.com/backend-api/f/conversation` 请求 + 响应。
> 这节是对上文的关键补充和修正，以实测为准。

### A.1 请求体完整格式（新会话首轮）

```json
{
  "turn_attribution": { "turn_trigger": "composer" },
  "conversation_id": "6affe1f4-6628-83e8-ac4a-cb5671bf457f",
  "action": "next",
  "model": "auto",
  "parent_message_id": "cfbb7480-18ce-4a6a-bbf7-120686ddc1ff",
  "timezone": "Asia/Shanghai",
  "timezone_offset_min": -480,
  "is_do_not_remember": false,
  "system_hints": ["reason"],
  "client_contextual_info": {
    "app_name": "chatgpt.com",
    "app_surface": "codex_browser",
    "supported_beacon_actions": ["open_plan_pricing"],
    "has_web_push_capabilities": true,
    "web_push_notification_permission": "granted"
  },
  "local_function_names": ["local.continue_in_work"],
  "messages": [
    {
      "author": { "metadata": {}, "name": null, "role": "user" },
      "channel": null,
      "content": { "content_type": "text", "parts": ["你是什么模型"] },
      "create_time": 1795154432.575,
      "end_turn": null,
      "id": "b1438e72-e595-48de-9de0-f89061208f4e",
      "metadata": {
        "automation_creation_attribution": { "origin": "conversation", "flow_id": "b1438e72-..." },
        "system_hints": ["reason"]
      },
      "recipient": "all",
      "status": "finished_successfully",
      "update_time": null,
      "weight": 1
    }
  ],
  "supported_encodings": ["v1"],
  "genui_state_snapshots": [],
  "client_prepare_state": "success"
}
```

**关键字段**：
- `conversation_id`：续接时传上次的；新会话首轮可能没有（或传空）
- `parent_message_id`：续接时传上一条 assistant 消息 id；新会话首轮是 `client-created-root` 或随机 UUID
- `messages[]`：只带**当前这一条**用户消息（增量，不带历史）
- `system_hints: ["reason"]`：触发推理（"思考"）
- `model: "auto"`：免费号实测落 `gpt-6-t-mini`
- 其余字段（turn_attribution / client_contextual_info / supported_encodings 等）照抄，精简有风控风险

### A.2 SSE 帧类型全表（实测）

| event 前缀 | data 形态 | 处理 |
|---|---|---|
| `event: delta_encoding` | `"v1"`（字符串，非对象） | **忽略**（JSON.parse 得字符串，applyOp 首行非对象直接 return） |
| 无 | `{"type":"resume_conversation_token",...}` | 忽略 |
| 无 | `{"type":"input_message",...}` | 忽略（回显用户消息） |
| 无 | `{"type":"ads",...}` | 忽略（广告占位） |
| `event: delta` | `{"p":"","o":"add","v":{"message":{...}}}` | **消息快照**（p 可能是空字符串，靠 v.message 识别） |
| `event: delta` | `{"v":{"message":{...}},"c":N}` | 消息快照（`c` 是帧序号，忽略） |
| `event: delta` | `{"o":"patch","v":[...]}` | 批量路径操作 |
| `event: delta` | `{"v":[...]}` | 批量路径操作（裸数组，无 o） |
| 无 | `{"type":"message_marker",...}` | 忽略 |
| 无 | `{"type":"server_ste_metadata",...}` | 忽略（服务端统计） |
| 无 | `{"type":"message_stream_complete",...}` | **置 finished** |
| 无 | `[DONE]` | **置 finished + endTurn** |

**结论**：解析不依赖 event 前缀，靠 data JSON 内容自描述。CDP 只取 `data:` 行即可。

### A.3 o 操作全表（实测，文档 4.4 的补充）

| o | 语义 | 处理 |
|---|---|---|
| `append` | 追加 | `seg.text += v` |
| `add` | 追加（同 append） | 同上 |
| `truncate` | 截断到长度 | `seg.text = seg.text.substring(0, Number(v))` |
| `replace` | 替换/覆盖 | `seg.text = v`（作用于 content/parts 时） |
| `remove` | 删除 | 对正文无意义，忽略 |

### A.4 实测时序（assistant 消息完整生命周期）

```
1. [快照] 空 assistant 消息
   {"p":"","o":"add","v":{"message":{
     "id":"82d611cf-...","author":{"role":"assistant"},
     "content":{"content_type":"text","parts":[""]},
     "status":"in_progress","end_turn":false,
     "channel":"final","recipient":"all",...}},"c":2}

2. [patch] 正文首块 + 把 end_turn 置 null
   {"o":"patch","v":[
     {"p":"/message/content/parts/0","o":"append","v":"我是 **GPT-"},
     {"p":"/message/end_turn","o":"replace","v":null},
     {"p":"/message/metadata/is_visually_hidden_from_conversation","o":"remove"},
     ...]}

3. [patch] 正文续块（裸数组，无 o:"patch"）
   {"v":[{"p":"/message/content/parts/0","o":"append","v":"6**，由 OpenAI 训练的推理模型。"}, ...]}

4. [patch] 终态
   {"v":[
     {"p":"/message/status","o":"replace","v":"finished_successfully"},
     {"p":"/message/end_turn","o":"replace","v":true},
     {"p":"/message/metadata","o":"append","v":{"can_save":true,
       "finish_details":{"type":"stop","stop_tokens":[200002]},"is_complete":true}}]}
```

**核心结论（修正文档 5.6）**：整轮结束靠 **patch 形式的 `/message/end_turn` replace true** 触发，**不是**快照里的 `end_turn` 字段（快照初始是 false）。文档 4.4 里「`/message/end_turn` 单独处理」的写法正确，但需强调这是**主要触发路径**。

### A.5 完成标记

```json
"metadata": {
  "can_save": true,
  "finish_details": { "type": "stop", "stop_tokens": [200002] },
  "is_complete": true
}
```

- `finish_details.type === "stop"` 是正常停止
- 若 type 为 `content_filter` / `max_tokens` 等，需另行处理（本次样本只有 stop）
- `is_complete: true` 可作为 finished 的辅助判据

### A.6 续接请求（第二轮）

- `conversation_id` 传上次响应里的 `conversation_id`
- `parent_message_id` 传上一条 assistant 消息的 `id`
- `messages[]` 只带本次用户新消息
- URL 仍为 `/backend-api/f/conversation`（与首轮相同）

### A.7 对 CDP 拦截的确认

- 所有 delta 帧都带 `event: delta` 前缀，但**解析不依赖它**——CDP 的 `dataReceived` 拿到原始字节流，帧解码器只取 `data:` 行，JSON 内容自描述
- `data: "v1"` 会被 `JSON.parse` 成字符串，applyOp 首行 `typeof node !== 'object'` 直接 return，安全
- `data: [DONE]` 是纯文本，不走 JSON.parse，单独判断
- 正文追加路径固定为 `/message/content/parts/0`，匹配正则 `/\/message\/content\/parts\/\d+$/`

