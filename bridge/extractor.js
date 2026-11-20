/**
 * ChatGPT SSE 解析器（extractor）
 * [261120] 照搬 cuckoo-code src/providers/hooks/chatgpt.ts 的 createExtractor（约 280 行）。
 * 详见 docs/protocols/chatgpt-web-protocol.md 第 4/5/6 节
 *
 * 核心难点（都已在下面处理）：
 *  1) 同一流多条 assistant 消息 → 按 message.id 分段，只拼接 isFinal 段
 *  2) 只有 end_turn=true 才允许派发（快照初始 end_turn:false，靠 patch replace true 触发）
 *  3) 帧会重放 → 帧级全局去重（调用方做）+ 正文 append 全局去重（这里做）
 *  4) 只认 channel/recipient/content_type 都符合的正文消息
 *  5) o 操作：append/add/truncate/replace/remove
 */

/** 从 content.parts 提取 { text, think }；非数组返回 null */
function partKind(p) {
  if (!p || typeof p !== 'object') return 'text';
  const ct = String(p.content_type || p.type || '').toLowerCase();
  if (ct === 'reasoning' || ct === 'thoughts' || ct === 'thinking') return 'think';
  return 'text';
}

function extractParts(content) {
  if (!content || !Array.isArray(content.parts)) return null;
  let tOut = '';
  let kOut = '';
  for (let i = 0; i < content.parts.length; i++) {
    const p = content.parts[i];
    if (typeof p === 'string') { tOut += p; continue; }
    if (p && typeof p === 'object' && typeof p.text === 'string') {
      if (partKind(p) === 'think') kOut += p.text;
      else tOut += p.text;
    }
  }
  return { text: tOut, think: kOut };
}

/**
 * 创建 extractor 实例。
 * @param {object} reqMeta 可选 { parentMessageId, conversationId }
 */
export function createExtractor(reqMeta) {
  let text = '';
  const segments = []; // 按 message.id 分段
  let currentSeg = null;
  const appendedSet = {}; // 正文 append 全局去重：key = seg|path|value
  let thinkText = '';
  let finished = false;
  let endTurn = false;
  let serverStopped = false;
  let failed = false;
  let tokenUsage = null;
  let msgIds = null;
  let sawAssistant = false;

  function segmentFor(id) {
    const key = (typeof id === 'string' && id) ? id : (currentSeg ? currentSeg.id : '(default)');
    for (let si = 0; si < segments.length; si++) {
      if (segments[si].id === key) { currentSeg = segments[si]; return currentSeg; }
    }
    currentSeg = { id: key, text: '' };
    segments.push(currentSeg);
    return currentSeg;
  }

  function syncText() {
    let out = '';
    for (let sj = 0; sj < segments.length; sj++) {
      if (segments[sj].isFinal) out += segments[sj].text;
    }
    text = out;
  }

  function captureMsgIds(src) {
    if (!src || typeof src !== 'object') return;
    if (!msgIds) msgIds = {};
    if (typeof src.id === 'string') msgIds.responseMessageId = src.id;
    if (typeof src.parent_message_id === 'string') msgIds.requestMessageId = src.parent_message_id;
  }

  if (reqMeta) {
    if (reqMeta.parentMessageId) {
      msgIds = msgIds || {};
      msgIds.requestMessageId = reqMeta.parentMessageId;
    }
    if (reqMeta.conversationId) {
      msgIds = msgIds || {};
      msgIds.conversationId = reqMeta.conversationId;
    }
  }

  function captureMeta(m) {
    let slug = null;
    if (m && m.metadata && typeof m.metadata.model_slug === 'string') slug = m.metadata.model_slug;
    else if (m && typeof m.model_slug === 'string') slug = m.model_slug;
    else if (m && m.content && m.content.metadata && typeof m.content.metadata.model_slug === 'string') {
      slug = m.content.metadata.model_slug;
    }
    if (!slug) return;
    tokenUsage = tokenUsage || {};
    tokenUsage.modelType = slug;
  }

  function applyStatus(s) {
    if (typeof s !== 'string') return;
    if (s === 'finished_successfully') { finished = true; return; }
    if (s === 'interrupted' || s === 'user_cancelled') { serverStopped = true; return; }
    if (s === 'failed' || s === 'errored') { failed = true; return; }
  }

  function applyStopReason(r) {
    if (typeof r !== 'string') return;
    const low = r.toLowerCase();
    if (low === 'stop' || low === 'max_tokens' || low === 'length' || low === 'content_filter') return;
    if (low.indexOf('cancel') !== -1 || low.indexOf('interrupt') !== -1) serverStopped = true;
  }

  function handleMessage(m) {
    if (!m || typeof m !== 'object') return;
    const role = m.author && m.author.role;
    if (role !== 'assistant') return;
    sawAssistant = true;
    captureMsgIds(m);
    captureMeta(m);
    const snap = extractParts(m.content);
    // 只有真正的文本消息（有 content.parts）才采信 status
    if (snap === null) return;
    const newText = String(snap.text || '');
    const isFinalAnswer = (m.channel == null || m.channel === 'final')
      && (m.recipient == null || m.recipient === 'all')
      && m.content && m.content.content_type === 'text';
    const seg = segmentFor(typeof m.id === 'string' ? m.id : null);
    seg.isFinal = isFinalAnswer;
    if (isFinalAnswer) seg.text = newText;
    syncText();
    if (snap.think) thinkText = snap.think;
    applyStatus(m.status);
    if (m.metadata) applyStopReason(m.metadata.stop_reason);
    if (m.end_turn === true) { finished = true; endTurn = true; }
  }

  function applyOp(node) {
    if (!node || typeof node !== 'object') return;

    // [261120-fix] conversation_id 挂在帧的顶层（不在 message 内部），任何帧都可能带。
    // 之前只在 handleMessage 里从 message 取，拿不到 → sessionId 恒 null，续接失效。
    // 实测：{"v":{"message":{...}},"conversation_id":"6affe1f4-...","error":null}
    if (typeof node.conversation_id === 'string' && node.conversation_id) {
      if (!msgIds) msgIds = {};
      msgIds.conversationId = node.conversation_id;
    }

    // 0) 错误信封（老协议 {error:{...}}，无 v/p）
    if (node.error !== null && node.error !== undefined &&
        node.v === undefined && node.p === undefined) { failed = true; }

    // 1) 批量操作：v 是数组（裸 {v:[...]} 也要处理）
    if (Array.isArray(node.v)) {
      for (let i = 0; i < node.v.length; i++) applyOp(node.v[i]);
      return;
    }

    // 2) 消息快照：v.message（现代形态，仅 assistant 生效）
    if (node.v && typeof node.v === 'object' && node.v.message) {
      handleMessage(node.v.message);
      return;
    }

    // 2b) 顶层 message 快照（老协议形态）
    if (node.message && typeof node.message === 'object') {
      handleMessage(node.message);
      return;
    }

    // 3) 路径操作
    if (typeof node.p === 'string' && node.p !== '') {
      if (node.p === '/message/status') { applyStatus(node.v); return; }
      if (node.p === '/message/end_turn' && node.v === true) { finished = true; endTurn = true; return; }
      // [261120] 实测 model_slug 主要出现在 patch 的 metadata append 里（assistant 快照本身可能没有）
      if (node.p === '/message/metadata' && node.v && typeof node.v === 'object' && typeof node.v.model_slug === 'string') {
        tokenUsage = tokenUsage || {};
        tokenUsage.modelType = node.v.model_slug;
      }
      if (/\/message\/content\/parts\/\d+$/.test(node.p)) {
        const pseg = currentSeg || segmentFor(null);
        if (pseg.isFinal === false) return; // 非正文消息段：忽略
        if (typeof node.v === 'string') {
          if (node.o === 'append' || node.o === 'add') {
            const dupKey = String(pseg.id) + '|' + node.p + '|' + node.v;
            if (appendedSet[dupKey]) return;
            appendedSet[dupKey] = 1;
          }
          if (node.o === 'append' || node.o === 'add') {
            pseg.text += node.v;
          } else if (node.o === 'truncate') {
            pseg.text = pseg.text.substring(0, Number(node.v));
          } else {
            pseg.text = node.v; // replace / 缺省 = 覆盖
          }
        } else if (node.v && typeof node.v === 'object' && typeof node.v.text === 'string') {
          if (partKind(node.v) === 'think') thinkText += node.v.text;
          else pseg.text += node.v.text;
        }
        syncText();
      }
      return;
    }

    // 4) 裸 v 字符串（无有效 p）：追加到当前消息段（仅正文段）
    if (typeof node.v === 'string') {
      const bseg = currentSeg || segmentFor(null);
      if (bseg.isFinal !== false) { bseg.text += node.v; syncText(); }
      return;
    }

    // 5) 类型化结束事件
    if (node.type === 'message_stream_complete' || node.type === 'message_stream_completed') {
      finished = true;
    }
  }

  return {
    consume(parsed) { applyOp(parsed); },
    markDone() { finished = true; endTurn = true; },
    get text() { return text; },
    get think() { return thinkText; },
    get finished() { return finished; },
    get endTurn() { return endTurn; },
    get failed() { return failed; },
    get serverStopped() { return serverStopped; },
    get tokenUsage() { return tokenUsage; },
    get msgIds() { return msgIds; },
    get textLen() { return text.length; },
    snapshot() {
      return {
        finished, endTurn, failed, serverStopped, sawAssistant,
        textLen: text.length, thinkLen: thinkText.length, textTail: text.slice(-200),
      };
    },
  };
}

/** 终态判定（见文档第 7 节） */
export function resolveStatus(extractor, aborted) {
  if (extractor.serverStopped) return 'stopped';
  if (extractor.failed) return 'error';
  if (aborted) return 'stopped';
  if (extractor.finished) return extractor.textLen === 0 ? 'error' : 'finished';
  if (extractor.textLen > 0) return 'finished';
  return 'error';
}
