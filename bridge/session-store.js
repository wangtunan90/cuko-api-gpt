/**
 * Provider 会话映射持久化（providerSessionId -> { conversationId, cuckSessionId, modelId, updatedAt }）
 * [261123] 之前只在内存里，重启后续接全部失效。写入采用 临时文件 + rename，避免写一半损坏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './app-paths.js';

export const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MAX_SESSIONS = 5000;

export function loadSessions() {
  const map = new Map();
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v && typeof v.conversationId === 'string') map.set(k, v);
        }
      }
    }
  } catch (e) {
    console.warn('[session] sessions.json 读取失败，按空处理:', e.message);
  }
  return map;
}

export function saveSessions(map) {
  try {
    while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) {
    console.warn('[session] 保存失败:', e.message);
  }
}
