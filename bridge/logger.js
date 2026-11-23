/**
 * 日志落盘：console.* 同时写 data/logs/bridge-YYYY-MM-DD.log
 * [261123] 参考 cuko-api-quick store.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './app-paths.js';

export const LOG_DIR = path.join(DATA_DIR, 'logs');
let LOG_FD = null;

export function initLogFile() {
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const file = path.join(LOG_DIR, 'bridge-' + stamp + '.log');
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    LOG_FD = fs.openSync(file, 'a');
  } catch (_) { LOG_FD = null; }
  return file;
}

const logStamp = () => new Date().toLocaleString('sv-SE', { hour12: false });

function logArg(a) {
  try {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    return JSON.stringify(a);
  } catch (_) { return String(a); }
}

export function teeConsoleToFile() {
  const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  const out = (fn, args) => {
    if (LOG_FD != null) {
      try { fs.writeSync(LOG_FD, logStamp() + ' ' + args.map(logArg).join(' ') + '\n'); } catch (_) {}
    }
    fn.apply(console, args);
  };
  console.log = (...a) => out(orig.log, a);
  console.warn = (...a) => out(orig.warn, a);
  console.error = (...a) => out(orig.error, a);
}
