/**
 * Cuko 请求处理 + HTTP 服务
 * [261120] 核心链路：解析请求 → 拿 CDP 连接 → 拦截 conversation 请求 → 填文本 → 点击发送 → 解析 SSE → 推 Cuko。
 * 详见 docs/protocols/chatgpt-web-protocol.md
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, APP_ROOT, readUiIndexHtml, readAppAsset } from './app-paths.js';
import { resolveProfile, launchChrome, waitPort, activeModels, PORT, getAccounts, saveAccounts, getProfiles, saveProfiles } from './core.js';
import { randomInRange, DEFAULT_PROFILE_VALUES, FIELD_LABELS, validateProfile } from './default-config.js';
import { closeAllConnections, closeConnection } from './cdp-connection.js';
import { getConnection } from './cdp-connection.js';
import { createFrameDecoder, extractData } from './sse.js';
import { createExtractor, resolveStatus } from './extractor.js';
import { probeInput, waitInput, fillInput, findSendButton, inputLength, triggerSend, checkLogin } from './chatgpt-driver.js';
import { normalizeInputItems } from './input.js';
import { loadSessions, saveSessions } from './session-store.js';
import { initLogFile, teeConsoleToFile } from './logger.js';
import { resolveRuntimeConfig, ensureRuntimeConfigFile, portInUseHint, RUNTIME_CONFIG_FILE } from './runtime-config.js';

const TMP_DIR = path.join(DATA_DIR, 'tmp');

/** Provider 会话映射（providerSessionId -> ChatGPT 会话信息） */
const runtimeCfg = resolveRuntimeConfig();
if (ensureRuntimeConfigFile()) console.log('[config] 已生成默认配置文件:', RUNTIME_CONFIG_FILE);
const LOG_FILE = initLogFile();
teeConsoleToFile();
console.log('[bridge] 日志落盘:', LOG_FILE);
const providerSessions = loadSessions();
console.log('[bridge] 已恢复 Provider 会话:', providerSessions.size, '个');

/** 已处理的 requestId，用于幂等检查 */
const processedRequestIds = new Set();

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


/** 返回协议规定的 HTTP 错误 */
function sendHttpError(res, status, code, message) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, message }));
}

/** 无法取得真实 Token 数时，按字符数估算 */
function estimateTokens(value) {
  const text = String(value || '');
  let count = 0;
  let latinRun = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) {
      count += Math.ceil(latinRun / 4);
      latinRun = 0;
      count += 1;
    } else {
      latinRun += 1;
    }
  }
  return count + Math.ceil(latinRun / 4);
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
  const modelId = typeof payload.model === 'string' ? payload.model.trim() : '';
  const cuckSessionId = typeof payload.cuckSessionId === 'string' ? payload.cuckSessionId.trim() : '';
  const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  const providerSessionId = typeof payload.providerSessionId === 'string' && payload.providerSessionId.trim()
    ? payload.providerSessionId.trim()
    : null;
  const requestType = payload.type || 'user';

  if (!cuckSessionId || !modelId || !requestId || !Array.isArray(payload.input)) {
    sendHttpError(res, 400, 'invalid_request', 'cuckSessionId、model、requestId 和 input（数组）均为必填项');
    return;
  }
  if (!['user', 'tool', 'compress'].includes(requestType)) {
    sendHttpError(res, 400, 'invalid_request', 'type 仅支持 user、tool、compress');
    return;
  }
  if (requestType === 'compress' && providerSessionId) {
    sendHttpError(res, 400, 'invalid_request', 'compress 请求不得携带 providerSessionId');
    return;
  }
  const norm = normalizeInputItems(payload.input);
  if (norm.items.some(i => i.kind === 'file')) {
    sendHttpError(res, 400, 'invalid_request', '当前 Provider 版本暂不支持文件输入');
    return;
  }
  if (norm.unknown.length) console.warn('[input] 未识别的输入项:', norm.unknown.join(', '));
  const texts = norm.items.map(i => i.text);
  const userText = texts.join(requestType === 'compress' ? '\n\n' : '\n').trim();
  if (requestType === 'compress') console.log('[cuko] 历史压缩请求：' + texts.length + ' 段，合并后 ' + userText.length + ' 字（强制新对话）');
  if (!userText) {
    sendHttpError(res, 400, 'invalid_request', 'input 中至少需要一条非空文本');
    return;
  }

  if (processedRequestIds.has(requestId)) {
    sendHttpError(res, 409, 'idempotency_conflict', 'requestId 已处理，不允许重复提交');
    return;
  }

  const existingSession = providerSessionId ? providerSessions.get(providerSessionId) : null;
  if (providerSessionId && !existingSession) {
    sendHttpError(res, 400, 'invalid_request', 'providerSessionId 不存在或已失效，请重新创建会话');
    return;
  }
  if (existingSession && existingSession.cuckSessionId !== cuckSessionId) {
    sendHttpError(res, 400, 'invalid_request', 'providerSessionId 与 cuckSessionId 不匹配');
    return;
  }
  if (existingSession && existingSession.modelId !== modelId) {
    sendHttpError(res, 400, 'invalid_request', '续接会话时 model 必须与原会话一致；切换模型请使用 compress');
    return;
  }

  const account = getAccounts().find(a => a.modelId === modelId);
  if (!account) {
    sendHttpError(res, 400, 'invalid_request', 'Model not found: ' + modelId);
    return;
  }
  if (activeModels.has(modelId)) {
    sendHttpError(res, 429, 'rate_limit_exceeded', '该账号正在处理另一请求');
    return;
  }

  processedRequestIds.add(requestId);
  if (processedRequestIds.size > 10000) {
    processedRequestIds.delete(processedRequestIds.values().next().value);
  }

  const responseProviderSessionId = providerSessionId || randomUUID();
  const inputTokens = estimateTokens(userText);
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
  const shouldAbort = () => aborted || dispatched;

    // 客户端断开 → 中止（提前注册，覆盖连接、导航和输入框等待阶段）
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

  try {
    // 1) 拿连接（端口不通则启动 Chrome）
    let conn;
    try {
      conn = await getConnection(account);
      if (shouldAbort()) return;
    } catch (e) {
      if (shouldAbort()) return;
      console.log('[cuko] 连接失败，启动 Chrome:', account.modelId);
      launchChrome(account, cfg.targetUrl, cfg);
      const ok = await waitPort(account, cfg.connectPollMaxSec);
      if (shouldAbort()) return;
      if (!ok) { const e = new Error('Chrome 启动超时'); e.code = 'provider_unavailable'; throw e; }
      conn = await getConnection(account);
      if (shouldAbort()) return;
    }

    // 2) 登录态检查
    const login = await checkLogin(conn);
    if (shouldAbort()) return;
    if (login.loggedOut) {
      const error = new Error('账号未登录（URL=' + login.url + '），请先手动登录');
      error.code = 'authentication_required';
      throw error;
    }

    // 3) [261120-fix] 导航判断（区分新对话 / 续接）：
    //  - 新对话（无 sessionMap 记录）→ 必须回到首页 https://chatgpt.com/
    //    否则会接着上一个旧对话继续，而不是开新对话
    //  - 续接（有 sessionMap 记录）→ 导航到 /c/<convId>（若当前不在该对话页）
    // 判断必须在 waitInput 之前，因为新对话页和旧对话页都需要先导航到位再等输入框。
    const wantConvId = existingSession ? existingSession.conversationId : null;
    const urlNow = (await conn.Runtime.evaluate({ expression: 'location.href', returnByValue: true })).result.value || '';
    if (shouldAbort()) return;
    let needNavigate = false;
    let targetUrl = cfg.targetUrl || 'https://chatgpt.com/';
    if (wantConvId) {
      // 续接：导航到指定对话页
      if (urlNow.indexOf('/c/' + wantConvId) < 0) {
        needNavigate = true;
        targetUrl = 'https://chatgpt.com/c/' + wantConvId;
      }
    } else {
      // 新对话：只要不在首页根路径就导航回首页
      const isRoot = /^https:\/\/chatgpt\.com\/?(\?.*)?$/.test(urlNow);
      if (!isRoot) {
        needNavigate = true;
        targetUrl = 'https://chatgpt.com/';
      }
    }
    if (needNavigate) {
      console.log('[cuko] 导航:', (wantConvId ? '续接 ' + wantConvId : '新对话'), '→', targetUrl, '（原 URL:', urlNow + '）');
      await conn.Page.navigate({ url: targetUrl });
      if (shouldAbort()) return;
      // [261120-fix] 导航后不能只固定等 2.5s —— ProseMirror 编辑器挂载有延迟，
      // DOM 出现但 execCommand 写入无效（实测 written=0）。改为轮询 document.readyState==='complete'，
      // 再多等 1.5s 让 React hydration 完成。
      const navStart = Date.now();
      let ready = false;
      while (Date.now() - navStart < 15000) {
        if (shouldAbort()) return;
        try {
          const st = await conn.Runtime.evaluate({ expression: "document.readyState", returnByValue: true });
          if (shouldAbort()) return;
          const rs = (st && st.result && st.result.value) || '';
          if (rs === 'complete') { ready = true; break; }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
      }
      console.log('[cuko] 导航后 readyState:', ready ? 'complete' : 'timeout', '耗时', Date.now() - navStart, 'ms');
      await new Promise(r => setTimeout(r, 1500));
      if (shouldAbort()) return;
    }

    // 4) 等输入框就绪（导航后可能还在加载，waitInput 内部已轮询）
    if (shouldAbort()) return;
    const inputReady = await waitInput(conn, cfg.pageReadyPollMaxSec);
    if (shouldAbort()) return;
    if (!inputReady) { const e = new Error('输入框未就绪（可能未登录或页面未加载）'); e.code = 'provider_unavailable'; throw e; }

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

    // [261123] 边生成边推送（参考 cuko-api-quick chat.js）
    let headSent = false;
    let sentText = '';
    let divergeWarned = false;
    const pushDelta = () => {
      if (res.writableEnded) return;
      const convId = (extractor.msgIds && extractor.msgIds.conversationId)
        || (existingSession && existingSession.conversationId);
      if (!convId) return; // 拿到 conversation_id 才开始推，保证 providerSessionId 可续接
      if (!headSent) {
        headSent = true;
        recordSession();
        writeSse(res, 'message', { cuckSessionId, providerSessionId: responseProviderSessionId, output: [] });
      }
      const cur = extractor.text;
      if (cur.length <= sentText.length) return;
      if (!cur.startsWith(sentText)) {
        if (!divergeWarned) { divergeWarned = true; console.warn('[cuko] 正文被改写（replace/truncate），暂停增量推送'); }
        return;
      }
      writeSse(res, 'message', { output: [cur.slice(sentText.length)] });
      sentText = cur;
    };

    const flushFrame = (frame) => {
      const r = extractData(frame);
      if (r == null) return;
      if (r === '[DONE]') { extractor.markDone(); return; }
      let parsed;
      try { parsed = JSON.parse(r); } catch (_) { return; }
      extractor.consume(parsed);
    };

    const feed = (chunkText) => {
      const frames = frameDecoder.push(chunkText);
      for (const f of frames) flushFrame(f);
      pushDelta();
      if (extractor.endTurn && !dispatched) {
        finishStream();
      }
    };

    const recordSession = () => {
      const convId = (extractor.msgIds && extractor.msgIds.conversationId)
        || (existingSession && existingSession.conversationId);
      if (convId) {
        providerSessions.set(responseProviderSessionId, {
          conversationId: convId,
          cuckSessionId,
          modelId,
          updatedAt: Date.now(),
        });
        saveSessions(providerSessions);
      }
    };

    const finishStream = (errorCode = null, errorMessage = null) => {
      if (dispatched) return;
      dispatched = true;
      clearAllTimers();
      try {
        const rest = frameDecoder.finish();
        for (const f of rest) flushFrame(f);
      } catch (_) {}
      recordSession();
      const sessionReady = providerSessions.has(responseProviderSessionId);

      const status = resolveStatus(extractor, aborted);
      const finalErrorCode = errorCode || (timedOut ? 'request_timeout' : null);
      const finalErrorMessage = errorMessage || (timedOut
        ? '响应超时，内容可能不完整'
        : null);

      if (finalErrorCode || status === 'error' || status === 'stopped' || !sessionReady) {
        writeSse(res, 'error', {
          code: finalErrorCode || 'provider_unavailable',
          message: finalErrorMessage || (!sessionReady
            ? '未能获取 ChatGPT conversation_id，无法建立可续接的 Provider 会话'
            : status === 'stopped'
              ? '生成已中断'
              : 'Provider 未能生成有效响应'),
        });
      } else {
        pushDelta();
        if (sentText.length !== extractor.textLen) {
          console.warn('[cuko] 增量与最终正文不一致：已推 ' + sentText.length + ' 字，最终 ' + extractor.textLen + ' 字');
        }

        const outputTokens = estimateTokens(extractor.text);
        writeSse(res, 'done', {
          finishReason: 'stop',
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
          providerSessionId: responseProviderSessionId,
        });
      }

      try { res.end(); } catch (_) {}
      try { if (scope) scope.close(); } catch (_) {}
      activeModels.delete(modelId);
    };

    const onTimeout = (reason) => {
      if (dispatched) return;
      timedOut = true;
      console.warn('[cuko] ' + reason + '，强制结束');
      finishStream('request_timeout', reason);
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
      finishStream('provider_unavailable', 'ChatGPT 请求失败: ' + (params.errorText || '未知错误'));
    });



    // 7) 心跳 + 总超时
    keepAliveTimer = setInterval(() => {
      try { if (!res.writableEnded) res.write(': keepalive\n\n'); } catch (_) {}
    }, KEEPALIVE_MS);
    totalTimer = setTimeout(() => onTimeout('请求总超时（' + Math.round(TOTAL_TIMEOUT_MS / 1000) + 's）'), TOTAL_TIMEOUT_MS);

    // 8) 填文本 + 点击发送
    console.log('[cuko] 填文本:', userText.length, '字');
    const fill = await fillInput(conn, userText, undefined, shouldAbort);
    if (shouldAbort()) return;
    if (!fill.ok) { const e = new Error('填入文本失败: ' + JSON.stringify(fill)); e.code = 'provider_unavailable'; throw e; }
    // 粘贴后短暂等待（让 ProseMirror 处理）
    await new Promise(r => setTimeout(r, randomInRange(cfg.preEnterWaitMinSec, cfg.preEnterWaitMaxSec)));
    if (shouldAbort()) return;

    console.log('[cuko] 触发发送');
    const send = await triggerSend(conn, 10000, shouldAbort);
    if (shouldAbort()) return;
    if (!send.ok) { const e = new Error('发送失败（输入框未被清空）'); e.code = 'provider_unavailable'; throw e; }
    console.log('[cuko] 已发送，method=' + send.method);

    // 等拦截到 conversation 请求（最多 30s）
    const waitStart = Date.now();
    while (!targetRequestId && Date.now() - waitStart < 30000) {
      if (shouldAbort()) return;
      await new Promise(r => setTimeout(r, 500));
      if (shouldAbort()) return;
    }
    if (!targetRequestId) { const e = new Error('30s 内未拦截到 conversation 请求'); e.code = 'provider_unavailable'; throw e; }

    // 到此进入流式等待（由 dataReceived / loadingFinished 驱动 finishStream）
  } catch (e) {
    clearAllTimers();
    try { if (scope) scope.close(); } catch (_) {}
    activeModels.delete(modelId);
    console.error('[cuko] 请求失败:', e.message);
    if (!dispatched) {
      dispatched = true;
      try {
        const errorCode = e.code || 'internal_error';
        const errorMessage = e.message || 'Provider 内部错误';
        if (!res.headersSent) {
          sendHttpError(res, errorCode === 'authentication_required' ? 401 : 500, errorCode, errorMessage);
        } else {
          writeSse(res, 'error', { code: errorCode, message: errorMessage });
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

    // [261120] 测试页：test-stream.html（项目根目录）
    if (req.method === 'GET' && pathname === '/test-stream.html') {
      try {
        const html = readAppAsset('test-stream.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('test-stream.html 读取失败: ' + e.message);
      }
      return;
    }

    // GET /v1/models
    if (req.method === 'GET' && pathname === '/v1/models') {
      const accounts = getAccounts();
      const data = accounts.map(a => ({
        id: a.modelId,
        name: a.displayName || a.modelId,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data }));
      return;
    }

    // POST /v1/responses
    if (req.method === 'POST' && pathname === '/v1/responses') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) {
        sendHttpError(res, 400, 'invalid_request', '请求体不是有效 JSON');
        return;
      }
      await handleCukoRequest(req, body, res);
      return;
    }

    // ===== 账号管理 API（简化） =====
    if (req.method === 'GET' && pathname === '/api/accounts') {
      const accounts = getAccounts();
      const probe = async (port) => {
        try { const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(800) }); return r.ok; }
        catch (_) { return false; }
      };
      const out = await Promise.all(accounts.map(async a => {
        const eff = resolveProfile(a);
        return { ...a, profileId: a.profileId || 'default', profileName: eff.name,
          status: (await probe(a.debugPort)) ? 'online' : 'offline', busy: activeModels.has(a.modelId) };
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }

    // ===== [261123] 管理 API（参考 cuko-api-quick） =====
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const readJson = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch (_) { return null; } };
    const profileExists = (pid) => !pid || pid === 'default' || getProfiles().some(p => p.id === pid);

    if (req.method === 'GET' && pathname === '/api/info') {
      let version = '0.1.0';
      try { version = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version; } catch (_) {}
      json(200, { port: runtimeCfg.port, host: runtimeCfg.host, baseUrl: 'http://127.0.0.1:' + runtimeCfg.port,
        portSource: runtimeCfg.portSource, configFile: RUNTIME_CONFIG_FILE, version });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/accounts') {
      const data = await readJson();
      if (!data) { json(400, { error: '请求体不是有效 JSON' }); return; }
      const modelId = String(data.modelId || '').trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(modelId)) { json(400, { error: '模型 ID 只能用英文、数字、下划线、中划线' }); return; }
      const accounts = getAccounts();
      if (accounts.some(a => a.modelId === modelId)) { json(409, { error: '该模型 ID 已存在' }); return; }
      if (!profileExists(data.profileId)) { json(400, { error: '指定的配置方案不存在' }); return; }
      const maxPort = accounts.reduce((m, a) => Math.max(m, Number(a.debugPort) || 0), 9332);
      const account = { modelId, displayName: String(data.displayName || modelId).trim(), debugPort: maxPort + 1,
        profileId: data.profileId || 'default', createdAt: Date.now() };
      accounts.push(account);
      saveAccounts(accounts);
      const cfg = resolveProfile(account).values;
      launchChrome(account, cfg.targetUrl, cfg);
      json(200, { success: true, account });
      return;
    }

    const am = pathname.match(/^\/api\/accounts\/([^/]+)(\/open)?$/);
    if (am && ((am[2] && req.method === 'POST') || (!am[2] && (req.method === 'PUT' || req.method === 'DELETE')))) {
      const id = decodeURIComponent(am[1]);
      const accounts = getAccounts();
      const acc = accounts.find(a => a.modelId === id);
      if (!acc) { json(404, { error: '账号不存在: ' + id }); return; }
      if (am[2]) {
        const cfg = resolveProfile(acc).values;
        launchChrome(acc, cfg.targetUrl, cfg);
        json(200, { success: true });
        return;
      }
      if (req.method === 'PUT') {
        const data = await readJson();
        if (!data) { json(400, { error: '请求体不是有效 JSON' }); return; }
        if (typeof data.displayName === 'string' && data.displayName.trim()) acc.displayName = data.displayName.trim();
        if (data.profileId !== undefined) {
          if (!profileExists(data.profileId)) { json(400, { error: '指定的配置方案不存在' }); return; }
          acc.profileId = data.profileId || 'default';
        }
        saveAccounts(accounts);
        json(200, { success: true, account: acc });
        return;
      }
      // DELETE
      if (activeModels.has(id)) { json(409, { error: '该账号正在处理请求，请稍后再删' }); return; }
      saveAccounts(accounts.filter(a => a.modelId !== id));
      try { await closeConnection(id); } catch (_) {}
      let purged = false;
      if (url.searchParams.get('purge') === '1') {
        try {
          const dir = acc.profileDir || path.join(DATA_DIR, 'profiles', id);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
          purged = true;
        } catch (e) { console.error('[accounts] 删除数据目录失败（Chrome 可能还开着）:', e.message); }
      }
      json(200, { success: true, purged });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/profiles') {
      json(200, { default: { id: 'default', name: '默认方案', isDefault: true, values: DEFAULT_PROFILE_VALUES },
        profiles: getProfiles(), labels: FIELD_LABELS });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/profiles') {
      const data = await readJson();
      if (!data) { json(400, { error: '请求体不是有效 JSON' }); return; }
      const name = String(data.name || '').trim();
      if (!name) { json(400, { error: '缺少方案名称' }); return; }
      let values;
      try { values = validateProfile(data.values || { ...DEFAULT_PROFILE_VALUES }); } catch (e) { json(400, { error: e.message }); return; }
      const profiles = getProfiles();
      const created = { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, values, createdAt: Date.now() };
      profiles.push(created);
      saveProfiles(profiles);
      json(200, created);
      return;
    }
    const pm = pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (pm && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = decodeURIComponent(pm[1]);
      if (id === 'default') { json(403, { error: '默认方案不可修改或删除' }); return; }
      const profiles = getProfiles();
      const p = profiles.find(x => x.id === id);
      if (!p) { json(404, { error: '方案不存在: ' + id }); return; }
      if (req.method === 'PUT') {
        const data = await readJson();
        if (!data) { json(400, { error: '请求体不是有效 JSON' }); return; }
        if (data.name !== undefined) {
          const name = String(data.name || '').trim();
          if (!name) { json(400, { error: '名称不能为空' }); return; }
          p.name = name;
        }
        if (data.values !== undefined) {
          try { p.values = validateProfile(data.values); } catch (e) { json(400, { error: e.message }); return; }
        }
        saveProfiles(profiles);
        json(200, p);
        return;
      }
      saveProfiles(profiles.filter(x => x.id !== id));
      const accounts = getAccounts();
      let affected = 0;
      for (const a of accounts) if (a.profileId === id) { a.profileId = 'default'; affected++; }
      if (affected) saveAccounts(accounts);
      json(200, { success: true, affectedAccounts: affected });
      return;
    }

    // [261123] 账号健康检查：GET /api/accounts/:id/health
    const hm = req.method === 'GET' && pathname.match(/^\/api\/accounts\/([^/]+)\/health$/);
    if (hm) {
      const id = decodeURIComponent(hm[1]);
      const account = getAccounts().find(a => a.modelId === id);
      const reply = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      if (!account) { reply(404, { state: 'error', message: '账号不存在: ' + id }); return; }
      let result;
      try {
        const conn = await getConnection(account);
        const login = await checkLogin(conn);
        if (login.loggedOut) {
          result = { state: 'login_required', message: login.guest ? '页面处于访客状态，请在该 Chrome 窗口登录' : '页面在登录页，请登录', url: login.url };
        } else {
          const p = await probeInput(conn);
          result = p.found
            ? { state: 'ok', message: '已登录，输入框可用', url: login.url }
            : { state: 'error', message: '未找到输入框（页面可能未加载完）', url: login.url };
        }
      } catch (e) {
        result = { state: 'error', message: 'CDP 连接失败（Chrome 未启动？）: ' + e.message };
      }
      result.checkedAt = Date.now();
      reply(200, result);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error('[http] 错误:', e.message);
    try {
      const message = e.message || 'HTTP 服务内部错误';
      if (!res.headersSent && !res.writableEnded) {
        sendHttpError(res, 500, 'internal_error', message);
      } else if (!res.writableEnded) {
        if (req.method === 'POST' && pathname === '/v1/responses') {
          writeSse(res, 'error', { code: 'internal_error', message });
        }
        res.end();
      }
    } catch (_) {}
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') console.error('[cuko-api-gpt] ' + portInUseHint(runtimeCfg.port));
  else console.error('[http] 启动失败:', e && e.message);
  process.exit(1);
});
server.listen(runtimeCfg.port, runtimeCfg.host, () => {
  console.log('[cuko-api-gpt] 运行在 http://' + runtimeCfg.host + ':' + runtimeCfg.port + '（端口来源：' + runtimeCfg.portSource + '）');
  console.log('[cuko-api-gpt] 管理台: http://127.0.0.1:' + runtimeCfg.port + '/');
  console.log('[cuko-api-gpt] 配置文件:', RUNTIME_CONFIG_FILE);
  console.log('[cuko-api-gpt] 项目根:', path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))));
});

process.on('SIGINT', async () => {
  console.log('\n[cuko-api-gpt] 正在关闭...');
  await closeAllConnections().catch(() => {});
  server.close(() => process.exit(0));
});

export { server };
