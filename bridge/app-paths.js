/**
 * 运行目录解析 + 内置页面读取
 * [261120] 从 one-chrome-ex 搬过来，逻辑一致。详见 docs/protocols/chatgpt-web-protocol.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);

/** 是否运行在 Node SEA 单文件 exe 里 */
let isSea = false;
try { isSea = !!req('node:sea').isSea(); } catch (_) { isSea = false; }

export const IS_SEA = isSea;
export const APP_ROOT = isSea ? import.meta.dirname : path.join(import.meta.dirname, '..');
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const UI_DIR = path.join(APP_ROOT, 'ui');

export function readUiIndexHtml() {
  if (isSea) {
    try { return req('node:sea').getAsset('ui/index.html', 'utf8'); }
    catch (e) { console.warn('[ui] 读取内嵌页面失败，回退到磁盘:', e.message); }
  }
  return fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
}
