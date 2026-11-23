/**
 * 运行时配置（端口/监听地址）
 * [261123] 参考 cuko-api-quick。优先级：内置默认 < data/config.json < 环境变量 CUKO_HTTP_PORT
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './app-paths.js';

export const RUNTIME_CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  port: 3001, // 与 one-chrome-ex（3000）区分
  host: '127.0.0.1',
});

export function readRuntimeConfig() {
  if (!fs.existsSync(RUNTIME_CONFIG_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch (e) {
    console.warn('[config] data/config.json 解析失败，忽略该文件:', e.message);
    return {};
  }
}

export function ensureRuntimeConfigFile() {
  if (fs.existsSync(RUNTIME_CONFIG_FILE)) return false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const body = {
      _说明: [
        '改完这个文件后重启程序才生效。',
        'port：HTTP 监听端口，默认 3001。客户端里的「API 地址」要填成一样的端口。',
        'host：监听地址，默认 127.0.0.1（只有本机能访问）。本项目没有鉴权，不建议改成 0.0.0.0。',
        '环境变量 CUKO_HTTP_PORT 优先级高于本文件。',
      ],
      port: DEFAULT_RUNTIME_CONFIG.port,
      host: DEFAULT_RUNTIME_CONFIG.host,
    };
    fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(body, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[config] 写入默认配置失败:', e.message);
    return false;
  }
}

export function resolveRuntimeConfig() {
  const file = readRuntimeConfig();
  let port = DEFAULT_RUNTIME_CONFIG.port;
  let host = DEFAULT_RUNTIME_CONFIG.host;
  let portSource = '默认值';
  if (file.port !== undefined) {
    const n = Number(file.port);
    if (Number.isInteger(n) && n > 0 && n < 65536) { port = n; portSource = 'data/config.json'; }
    else console.warn('[config] data/config.json 里的 port 不合法（' + JSON.stringify(file.port) + '），已忽略');
  }
  if (typeof file.host === 'string' && file.host.trim()) host = file.host.trim();
  const envPort = process.env.CUKO_HTTP_PORT;
  if (envPort !== undefined && envPort !== '') {
    const n = Number(envPort);
    if (Number.isInteger(n) && n > 0 && n < 65536) { port = n; portSource = '环境变量 CUKO_HTTP_PORT'; }
    else console.warn('[config] 环境变量 CUKO_HTTP_PORT 不合法（' + JSON.stringify(envPort) + '），已忽略');
  }
  return { port, host, portSource };
}

export function portInUseHint(port) {
  return [
    '端口 ' + port + ' 已被占用。可以：',
    '  1) 关掉占用该端口的程序（Windows 下用 netstat -ano | findstr :' + port + ' 查 PID）',
    '  2) 换个端口：编辑 ' + RUNTIME_CONFIG_FILE + '，把 port 改成别的值，然后重启',
    '  3) 或临时用环境变量：set CUKO_HTTP_PORT=3002 && npm start',
  ].join('\n');
}
