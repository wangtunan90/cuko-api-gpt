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
// [261123] SEA 下 import.meta.dirname 不可靠，用 exe 所在目录（data/ 建在 exe 旁边）
export const APP_ROOT = isSea ? path.dirname(process.execPath) : path.join(import.meta.dirname, '..');

/** 读取内置资源：exe 里读 SEA asset，开发时读项目文件 */
export function readAppAsset(rel) {
  if (isSea) {
    try { return req('node:sea').getAsset(rel, 'utf8'); }
    catch (e) { console.warn('[asset] 读取内嵌资源失败，回退到磁盘:', rel, e.message); }
  }
  return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const UI_DIR = path.join(APP_ROOT, 'ui');

export function readUiIndexHtml() {
  if (isSea) {
    try { return req('node:sea').getAsset('ui/index.html', 'utf8'); }
    catch (e) { console.warn('[ui] 读取内嵌页面失败，回退到磁盘:', e.message); }
  }
  return fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
}
