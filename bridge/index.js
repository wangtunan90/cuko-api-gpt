/**
 * Cuko 请求处理 + HTTP 服务
 * [261120] 核心链路：解析请求 → 拿 CDP 连接 → 拦截 conversation 请求 → 填文本 → 点击发送 → 解析 SSE → 推 Cuko。
 * 详见 docs/protocols/chatgpt-web-protocol.md
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readUiIndexHtml } from './app-paths.js';
import { resolveProfile, launchChrome, waitPort, activeModels, PORT, getAccounts, saveAccounts } from './core.js';
import { randomInRange } from './default-config.js';
import { closeAllConnections } from './cdp-connection.js';
import { getConnection } from './cdp-connection.js';
import { createFrameDecoder, extractData } from './sse.js';
import { createExtractor, resolveStatus } from './extractor.js';
import { probeInput, waitInput, fillInput, findSendButton, inputLength, triggerSend, checkLogin } from './chatgpt-driver.js';

const TMP_DIR = path.join(DATA_DIR, 'tmp');

/** 会话 id 映射（cuckSessionId -> chatgpt conversation_id），用于续接 */
const sessionMap = new Map();

/** URL 匹配：POST /backend-api/(f/)?conversation */
const CONVERSATION_RE = /\/backend-api\/(?:f\/)?conversation\/?$/;
function isConversationRequest(url, method) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  try {
    const u = new URL(url);
    if (u.hostname.indexOf('chatgpt.com') === -1 && u.hostname.indexOf('chat.openai.com') === -1) return false;
    return CONVERSATION_RE.test(u.pathname);
  } catch (_) { return false; }
}

/** 规范化 input items：取文本拼接 */
function normalizeInputItems(input) {
  const out = [];
  if (!Array.isArray(input)) return out;
  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    if ((it.type === 'text' || it.type === 'input_text' || it.type === 'user') && typeof it.text === 'string') {
      out.push(it.text);
    }
  }
  return out;
}

/** SSE 帧写出 */
function writeSse(res, event, data) {
  try {
    if (res.writableEnded) return;
    if (event) res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch (_) {}
}

/** 处理一次 Cuko 请求 */
async function handleCukoRequest(req, body, res) {
  const payload = body || {};
  const modelId = payload.model;
  const cuckSessionId = payload.cuckSessionId || payload.requestId || String(Date.now());
  const requestId = payload.requestId || cuckSessionId;
  const texts = normalizeInputItems(payload.input);
  const userText = texts.join('\n').trim();

  const account = getAccounts().find(a => a.modelId === modelId);
  if (!account) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Model not found' }));
    return;
  }
  if (activeModels.has(modelId)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 'rate_limit_exceeded', message: '该账号正在处理另一请求' }));
    return;
  }
  if (!userText) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'empty input' }));
    return;
  }

  activeModels.add(modelId);
  const cfg = resolveProfile(account).values;

  let scope = null;
  let keepAliveTimer = null;
  let idleTimer = null;
  let totalTimer = null;
  let aborted = false;
  let timedOut = false;
  let dispatched = false;
  const IDLE_TIMEOUT_MS = 90000;
  const TOTAL_TIMEOUT_MS = Math.round((cfg.requestTimeoutSec || 600) * 1000);
  const KEEPALIVE_MS = 20000;

  const clearAllTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  };

  try {
    // 1) 拿连接（端口不通则启动 Chrome）
    let conn;
    try {
      conn = await getConnection(account);
    } catch (e) {
      console.log('[cuko] 连接失败，启动 Chrome:', account.modelId);
      launchChrome(account, cfg.targetUrl, cfg);
      const ok = await waitPort(account, cfg.connectPollMaxSec);
      if (!ok) throw new Error('Chrome 启动超时');
      conn = await getConnection(account);
    }

    // 2) 登录态检查
    const login = await checkLogin(conn);
    if (login.loggedOut) {
      throw new Error('账号未登录（URL=' + login.url + '），请先手动登录');
    }

    // 3) 等输入框就绪
    const inputReady = await waitInput(conn, cfg.pageReadyPollMaxSec);
    if (!inputReady) throw new Error('输入框未就绪（可能未登录或页面未加载）');

    // 4) 若当前不在新会话页且无法续接，导航到首页（简化：只在 URL 不是 chatgpt.com 根时导航）
    const urlNow = (await conn.Runtime.evaluate({ expression: 'location.href', returnByValue: true })).result.value || '';
    const onChatPage = urlNow.indexOf('chatgpt.com') >= 0 && urlNow.indexOf('/auth/') < 0;
    if (!onChatPage) {
      await conn.Page.navigate({ url: cfg.targetUrl });
      await new Promise(r => setTimeout(r, 2000));
      const ok2 = await waitInput(conn, cfg.pageReadyPollMaxSec);
      if (!ok2) throw new Error('导航后输入框未就绪');
    }

    // 5) 建立 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 6) 建作用域 + 拦截
    scope = conn.createScope();
    let targetRequestId = null;
    let bufferedFed = false;
    const decoder = new TextDecoder('utf-8');
    const frameDecoder = createFrameDecoder();
    const extractor = createExtractor(null);
    const seenFrames = {};

    const flushFrame = (frame) => {
      const r = extractData(frame);
      if (r == null) return;
      if (r === '[DONE]') { extractor.markDone(); return; }
      if (seenFrames[r]) return; // 帧级全局去重（防重放）
      seenFrames[r] = 1;
      let parsed;
      try { parsed = JSON.parse(r); } catch (_) { return; }
      extractor.consume(parsed);
    };

    const feed = (chunkText) => {
      const frames = frameDecoder.push(chunkText);
      for (const f of frames) flushFrame(f);
      if (extractor.endTurn && !dispatched) {
        finishStream();
      }
    };

    const recordSession = () => {
      const convId = extractor.msgIds && extractor.msgIds.conversationId;
      if (convId) sessionMap.set(cuckSessionId, convId);
    };

    const finishStream = () => {
      if (dispatched) return;
      dispatched = true;
      clearAllTimers();
      try {
        const rest = frameDecoder.finish();
        for (const f of rest) flushFrame(f);
      } catch (_) {}
      recordSession();
      // 推正文
      if (extractor.textLen > 0) {
        writeSse(res, 'message', {
          id: 'msg_' + requestId,
          object: 'response.output_text.delta',
          delta: extractor.text,
        });
      }
      // 超时推 error
      if (timedOut) {
        writeSse(res, 'error', { code: 'request_timeout', message: '响应超时，内容可能不完整' });
      }
      writeSse(res, 'done', {
        finishReason: timedOut ? 'timeout' : (resolveStatus(extractor, aborted) === 'error' ? 'error' : 'stop'),
        usage: { total_tokens: 0 },
        sessionId: sessionMap.get(cuckSessionId) || null,
      });
      try { res.end(); } catch (_) {}
      try { if (scope) scope.close(); } catch (_) {}
      activeModels.delete(modelId);
    };

    const onTimeout = (reason) => {
      if (dispatched) return;
      timedOut = true;
      console.warn('[cuko] ' + reason + '，强制结束');
      finishStream();
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => onTimeout('空闲超时（90s 无数据）'), IDLE_TIMEOUT_MS);
    };

    // 拦截 requestWillBeSent：命中则打开增量
    scope.Network.requestWillBeSent(async (params) => {
      try {
        const u = params.request && params.request.url;
        const m = params.request && params.request.method;
        if (!isConversationRequest(u, m)) return;
        if (targetRequestId) return; // 只认第一个（本次请求）
        targetRequestId = params.requestId;
        console.log('[cuko] 命中 conversation 请求:', account.modelId, targetRequestId);
        resetIdle();
        // 先打开增量，再消费（顺序重要）
        try {
          const sr = await conn.Network.streamResourceContent({ requestId: targetRequestId });
          if (sr && sr.bufferedData) {
            const init = Buffer.from(sr.bufferedData, 'base64').toString('utf8');
            if (init) { feed(init); bufferedFed = true; }
          }
        } catch (e) {
          console.warn('[cuko] streamResourceContent 失败:', e.message);
        }
      } catch (_) {}
    });

    scope.Network.dataReceived((params) => {
      if (!targetRequestId || params.requestId !== targetRequestId) return;
      if (!params.data) return;
      resetIdle();
      try {
        const chunk = Buffer.from(params.data, 'base64').toString('utf8');
        feed(chunk);
      } catch (e) {
        console.warn('[cuko] dataReceived 解析失败:', e.message);
      }
    });

    scope.Network.loadingFinished(async (params) => {
      if (!targetRequestId || params.requestId !== targetRequestId) return;
      console.log('[cuko] conversation 流结束:', targetRequestId);
      // 若从未收到过 data，尝试 getResponseBody 兜底
      if (!bufferedFed && extractor.textLen === 0) {
        try {
          const body = await conn.Network.getResponseBody({ requestId: targetRequestId });
          let txt = body && body.body || '';
          if (body && body.base64Encoded) txt = Buffer.from(txt, 'base64').toString('utf8');
          if (txt) feed(txt);
        } catch (_) {}
      }
      finishStream();
    });

    scope.Network.loadingFailed((params) => {
      if (!targetRequestId || params.requestId !== targetRequestId) return;
      console.warn('[cuko] conversation 加载失败:', params.errorText);
      finishStream();
    });

    // 客户端断开 → 中止
    res.on('close', () => {
      if (!dispatched) {
        console.log('[cuko] 客户端断开');
        aborted = true;
        clearAllTimers();
        try { if (scope) scope.close(); } catch (_) {}
        activeModels.delete(modelId);
        dispatched = true;
      }
    });

    // 7) 心跳 + 总超时
    keepAliveTimer = setInterval(() => {
      try { if (!res.writableEnded) res.write(': keepalive\n\n'); } catch (_) {}
    }, KEEPALIVE_MS);
    totalTimer = setTimeout(() => onTimeout('请求总超时（' + Math.round(TOTAL_TIMEOUT_MS / 1000) + 's）'), TOTAL_TIMEOUT_MS);

    // 8) 填文本 + 点击发送
    console.log('[cuko] 填文本:', userText.length, '字');
    const fill = await fillInput(conn, userText);
    if (!fill.ok) throw new Error('填入文本失败: ' + JSON.stringify(fill));
    // 粘贴后短暂等待（让 ProseMirror 处理）
    await new Promise(r => setTimeout(r, randomInRange(cfg.preEnterWaitMinSec, cfg.preEnterWaitMaxSec)));

    console.log('[cuko] 触发发送');
    const send = await triggerSend(conn, 10000);
    if (!send.ok) throw new Error('发送失败（输入框未被清空）');
    console.log('[cuko] 已发送，method=' + send.method);

    // 等拦截到 conversation 请求（最多 30s）
    const waitStart = Date.now();
    while (!targetRequestId && Date.now() - waitStart < 30000) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (!targetRequestId) throw new Error('30s 内未拦截到 conversation 请求');

    // 到此进入流式等待（由 dataReceived / loadingFinished 驱动 finishStream）
  } catch (e) {
    clearAllTimers();
    try { if (scope) scope.close(); } catch (_) {}
    activeModels.delete(modelId);
    console.error('[cuko] 请求失败:', e.message);
    if (!dispatched) {
      dispatched = true;
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 'provider_error', message: e.message }));
        } else {
          writeSse(res, 'error', { code: 'provider_error', message: e.message });
          writeSse(res, 'done', { finishReason: 'error' });
          res.end();
        }
      } catch (_) {}
    }
  }
}

// ===== HTTP 服务 =====
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  try {
    // 管理页
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      try {
        const html = readUiIndexHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>cuko-api-gpt</h1><p>UI 未就绪。API: GET /v1/models, POST /v1/responses</p>');
      }
      return;
    }

    // GET /v1/models
    if (req.method === 'GET' && pathname === '/v1/models') {
      const accounts = getAccounts();
      const data = accounts.map(a => ({
        id: a.modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'cuko-api-gpt',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }

    // POST /v1/responses
    if (req.method === 'POST' && pathname === '/v1/responses') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      await handleCukoRequest(req, body, res);
      return;
    }

    // ===== 账号管理 API（简化） =====
    if (req.method === 'GET' && pathname === '/api/accounts') {
      const accounts = getAccounts();
      const out = accounts.map(a => {
        const eff = resolveProfile(a);
        return { ...a, profileId: a.profileId || 'default', profileName: eff.name };
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error('[http] 错误:', e.message);
    try { if (!res.headersSent) { res.writeHead(500); res.end('internal error'); } } catch (_) {}
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[cuko-api-gpt] 运行在 http://127.0.0.1:' + PORT);
  console.log('[cuko-api-gpt] 管理台: http://127.0.0.1:' + PORT + '/');
  console.log('[cuko-api-gpt] 项目根:', path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))));
});

process.on('SIGINT', async () => {
  console.log('\n[cuko-api-gpt] 正在关闭...');
  await closeAllConnections().catch(() => {});
  server.close(() => process.exit(0));
});

export { server };
