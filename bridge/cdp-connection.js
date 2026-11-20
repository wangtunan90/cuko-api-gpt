/**
 * 常驻 CDP 连接管理
 * [261120] 从 one-chrome-ex 搬来，唯一改动：target 匹配从 chat.deepseek.com 改为 chatgpt.com。
 * 详见 docs/protocols/chatgpt-web-protocol.md
 *
 * 为什么常驻：消除「连接建立晚于数据到达」的窗口期（dataReceived 收不到 data）。
 * 事件作用域：底层 wire 一次，业务层 createScope() 注册回调，请求结束 scope.close() 摘除。
 */
import CDP from 'chrome-remote-interface';

const connections = new Map(); // modelId -> CdpConnection

/** ChatGPT 页面 URL 匹配（chatgpt.com / chat.openai.com） */
function isChatGptPage(url) {
  if (!url) return false;
  return url.indexOf('chatgpt.com') !== -1 || url.indexOf('chat.openai.com') !== -1;
}

class CdpConnection {
  constructor(account) {
    this.account = account;
    this.client = null;
    this.Runtime = null;
    this.Input = null;
    this.Network = null;
    this.Page = null;
    this.alive = false;
    this.activeRequest = null;
    this.connecting = null;
    this.scopes = new Set();
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const targets = await CDP.List({ port: this.account.debugPort });
      const target = targets.find(t => isChatGptPage(t.url) && t.type === 'page');
      if (!target || !target.webSocketDebuggerUrl) {
        throw new Error('找不到 ChatGPT 页面 target（端口 ' + this.account.debugPort + '）');
      }
      this.client = await CDP({ target: target.webSocketDebuggerUrl });
      this.Runtime = this.client.Runtime;
      this.Input = this.client.Input;
      this.Network = this.client.Network;
      this.Page = this.client.Page;

      await this.Page.enable();
      await this.Runtime.enable();
      await this.Network.enable({
        maxTotalBufferSize: 104857600,
        maxResourceBufferSize: 52428800,
        maxPostDataSize: 104857600,
      });

      this.client.on('disconnect', () => {
        this.alive = false;
        console.log('[CDP-conn] disconnect:', this.account.modelId);
      });

      this.Network.requestWillBeSent((params) => this._dispatch('requestWillBeSent', params));
      this.Network.dataReceived((params) => this._dispatch('dataReceived', params));
      this.Network.loadingFinished((params) => this._dispatch('loadingFinished', params));
      this.Network.loadingFailed((params) => this._dispatch('loadingFailed', params));

      this.alive = true;
      console.log('[CDP-conn] connected:', this.account.modelId, 'port', this.account.debugPort);
    })();
    try {
      await this.connecting;
    } catch (e) {
      this.connecting = null;
      throw e;
    } finally {
      this.connecting = null;
    }
  }

  async ensureAlive() {
    if (!this.alive || !this.client) {
      await this.connect();
      return;
    }
    try {
      await this.Runtime.evaluate({ expression: '1', returnByValue: true });
    } catch (e) {
      console.warn('[CDP-conn] 探活失败，重建连接:', this.account.modelId, e.message);
      this.alive = false;
      try { if (this.client) this.client.close(); } catch (_) {}
      this.client = null;
      await this.connect();
    }
  }

  createScope() {
    const handlers = { requestWillBeSent: [], dataReceived: [], loadingFinished: [], loadingFailed: [] };
    const off = (list, cb) => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
    const scope = {
      handlers,
      Network: {
        requestWillBeSent: (cb) => { handlers.requestWillBeSent.push(cb); return () => off(handlers.requestWillBeSent, cb); },
        dataReceived: (cb) => { handlers.dataReceived.push(cb); return () => off(handlers.dataReceived, cb); },
        loadingFinished: (cb) => { handlers.loadingFinished.push(cb); return () => off(handlers.loadingFinished, cb); },
        loadingFailed: (cb) => { handlers.loadingFailed.push(cb); return () => off(handlers.loadingFailed, cb); },
        enable: (...a) => this.Network.enable(...a),
        streamResourceContent: (...a) => this.Network.streamResourceContent(...a),
        getRequestPostData: (...a) => this.Network.getRequestPostData(...a),
        getResponseBody: (...a) => this.Network.getResponseBody(...a),
      },
      close: () => { this.scopes.delete(scope); },
    };
    this.scopes.add(scope);
    return scope;
  }

  _dispatch(eventName, params) {
    for (const scope of this.scopes) {
      const list = scope.handlers[eventName];
      if (!list || !list.length) continue;
      for (const cb of list) {
        try { cb(params); } catch (e) { console.warn('[CDP-conn] handler error:', e.message); }
      }
    }
  }

  async close() {
    this.alive = false;
    this.activeRequest = null;
    if (this.client) {
      try { await this.client.close(); } catch (_) {}
      this.client = null;
    }
    connections.delete(this.account.modelId);
  }
}

export async function getConnection(account) {
  let conn = connections.get(account.modelId);
  if (!conn) {
    conn = new CdpConnection(account);
    connections.set(account.modelId, conn);
  }
  await conn.ensureAlive();
  return conn;
}

export async function closeConnection(accountId) {
  const conn = connections.get(accountId);
  if (conn) await conn.close();
}

export async function closeAllConnections() {
  for (const conn of connections.values()) {
    try { await conn.close(); } catch (_) {}
  }
  connections.clear();
}
