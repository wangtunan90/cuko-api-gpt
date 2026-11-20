/**
 * cuko-api-gpt 主程序
 * [261120] ChatGPT 网页版 Stateful Provider。通过 CDP 控制独立 Chrome 与 chatgpt.com 交互，
 * 对外暴露 Cuko API（GET /v1/models、POST /v1/responses）。
 * 协议依据：docs/protocols/chatgpt-web-protocol.md
 *
 * 与 one-chrome-ex（DeepSeek 版）的关键差异：
 *  - 拦截 URL：/backend-api/(f/)?conversation（不是 /api/v0/chat/completion）
 *  - 发送：ProseMirror 用 execCommand('insertText')，不用剪贴板 paste；发送靠鼠标点击按钮，不靠 Enter
 *  - SSE 解析：见 extractor.js（按 message.id 分段、end_turn 触发派发）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, APP_ROOT, readUiIndexHtml } from './app-paths.js';
import { DEFAULT_PROFILE_VALUES, validateProfile, randomInRange } from './default-config.js';
import { getConnection, closeAllConnections } from './cdp-connection.js';
import { createFrameDecoder, extractData } from './sse.js';
import { createExtractor, resolveStatus } from './extractor.js';

const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PROFILES_FILE = path.join(DATA_DIR, 'config-profiles.json');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const PORT = 3001; // 与 one-chrome-ex（3000）区分

/** 正在对话的账号（并发锁） */
const activeModels = new Set();

// ===== 账号管理 =====
function getAccounts() {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}
function saveAccounts(accounts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

// ===== 配置方案 =====
function getProfiles() {
  try {
    if (!fs.existsSync(PROFILES_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    return (data && Array.isArray(data.profiles)) ? data.profiles : [];
  } catch (_) { return []; }
}
/** 解析账号实际生效的方案（找不到就用默认） */
function resolveProfile(account) {
  const profiles = getProfiles();
  const id = account.profileId || 'default';
  if (id !== 'default') {
    const found = profiles.find(p => p.id === id);
    if (found) {
      try { return { id, name: found.name, values: validateProfile(found.values), isDefault: false }; }
      catch (_) { /* 回退默认 */ }
    }
  }
  return { id: 'default', name: '默认方案', values: { ...DEFAULT_PROFILE_VALUES }, isDefault: true };
}

// ===== Chrome 启动 =====
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];
function findChrome(cfg) {
  if (cfg && cfg.chromePath && fs.existsSync(cfg.chromePath)) return cfg.chromePath;
  for (const p of CHROME_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return 'chrome.exe'; // 交给 PATH
}

function launchChrome(account, targetUrl, cfg) {
  const chromePath = findChrome(cfg);
  const profileDir = account.profileDir || path.join(DATA_DIR, 'profiles', account.modelId);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    '--remote-debugging-port=' + account.debugPort,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (!cfg || cfg.disableBackgroundThrottling !== false) {
    args.push('--disable-background-timer-throttling');
    args.push('--disable-backgrounding-occluded-windows');
    args.push('--disable-renderer-backgrounding');
  }
  if (cfg && cfg.extraArgs) {
    for (const a of String(cfg.extraArgs).split(/\s+/)) { if (a) args.push(a); }
  }
  args.push(targetUrl || 'https://chatgpt.com/');

  console.log('[chrome] 启动:', account.modelId, 'port', account.debugPort, '->', targetUrl);
  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.warn('[chrome] spawn 失败:', e.message));
  child.unref();
  return child;
}

/** 轮询调试端口就绪 */
async function waitPort(account, maxSec) {
  const max = Math.max(1, Math.ceil(maxSec || 25));
  for (let i = 0; i < max; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + account.debugPort + '/json/version', { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

export { getAccounts, saveAccounts, getProfiles, resolveProfile, launchChrome, waitPort, activeModels, PORT };
