#!/usr/bin/env node
/**
 * 打包 Windows 单文件 exe（参考 cuko-api-quick）
 * 用法：npm run build:exe
 *   1. esbuild 把 bridge/index.js 及依赖打成单个 ESM（build/sea-main.mjs）
 *   2. node --build-sea 注入 node 二进制，产出 dist/cuko-api-gpt.exe（自带 Node 运行时）
 *   3. data/ 不打进 exe：首次运行时在 exe 同目录自动创建
 * 需要 Node >= 25.5；可用环境变量 NODE_SEA_BIN 指定 node 路径。
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(ROOT, 'dist');
const BUNDLE = path.join(BUILD_DIR, 'sea-main.mjs');
const SEA_CONFIG = path.join(BUILD_DIR, 'sea-config.json');
const EXE_NAME = 'cuko-api-gpt.exe';

function log(...a) { console.log('[build:exe]', ...a); }
function die(msg) { console.error('\n[build:exe] 失败：' + msg + '\n'); process.exit(1); }

function nodeSupportsSea(exe) {
  try {
    const v = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
    const [maj, min] = v.split('.').map(Number);
    return { ok: maj > 25 || (maj === 25 && min >= 5), version: v };
  } catch (_) { return { ok: false, version: null }; }
}
function findSeaNode() {
  const c = [process.execPath, ...(process.env.NODE_SEA_BIN ? [process.env.NODE_SEA_BIN] : []), 'C:\\Program Files\\nodejs\\node.exe'];
  try { c.push(...execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)); } catch (_) {}
  const tried = [];
  for (const p of c) {
    if (!p || !fs.existsSync(p)) continue;
    const r = nodeSupportsSea(p);
    tried.push(p + ' (v' + r.version + ')');
    if (r.ok) return p;
  }
  die('找不到支持 --build-sea 的 Node.js（需要 >= 25.5）。试过：\n    ' + tried.join('\n    '));
}

if (process.platform !== 'win32') die('该脚本只用于生成 Windows exe');
const NODE_EXE = findSeaNode();
log('使用 Node', execFileSync(NODE_EXE, ['--version'], { encoding: 'utf8' }).trim(), '→', EXE_NAME);

for (const d of [BUILD_DIR, DIST_DIR]) {
  try { fs.rmSync(d, { recursive: true, force: true }); }
  catch (e) { die('无法清理 ' + d + '（exe 是否正在运行？）：' + e.message); }
}
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

log('打包 bridge/index.js ...');
await build({
  entryPoints: [path.join(ROOT, 'bridge', 'index.js')],
  bundle: true, platform: 'node', format: 'esm', target: 'esnext', outfile: BUNDLE,
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __seaCreateRequire } from 'node:module';\nconst require = __seaCreateRequire(import.meta.url);" },
  legalComments: 'none', logLevel: 'warning',
});
log('bundle 完成：' + (fs.statSync(BUNDLE).size / 1024).toFixed(0) + ' KB');

fs.writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE, mainFormat: 'module', output: path.join(DIST_DIR, EXE_NAME),
  disableExperimentalSEAWarning: true,
  assets: {
    'ui/index.html': path.join(ROOT, 'ui', 'index.html'),
    'test-stream.html': path.join(ROOT, 'test-stream.html'),
  },
}, null, 2), 'utf8');

log('生成 exe（Node SEA，约 1-3 分钟）...');
try { execFileSync(NODE_EXE, ['--build-sea=' + SEA_CONFIG], { cwd: ROOT, stdio: 'inherit' }); }
catch (e) { die('--build-sea 执行失败：' + e.message); }

const exePath = path.join(DIST_DIR, EXE_NAME);
if (!fs.existsSync(exePath)) die('未生成 exe：' + exePath);
log('exe 生成：' + exePath + '（' + (fs.statSync(exePath).size / 1024 / 1024).toFixed(1) + ' MB）');

fs.writeFileSync(path.join(DIST_DIR, '使用说明.txt'), [
  'cuko-api-gpt 单文件版',
  '',
  '【这是什么】',
  '  把 ChatGPT 网页版（chatgpt.com）的聊天能力，暴露成 Cuko API。',
  '',
  '【怎么用】',
  '  1. 双击 cuko-api-gpt.exe 启动（会弹出命令行窗口，别关它）',
  '  2. 浏览器打开 http://127.0.0.1:3001/ 进入管理台',
  '  3. 填模型 ID（如 gpt-main）+ 显示名称，点「添加并启动 Chrome」',
  '  4. 在弹出的 Chrome 窗口里登录 chatgpt.com',
  '  5. 回管理台点「检查」，看到 ok 就可以用了',
  '  6. 在 Cuko 客户端里填 API 地址 http://127.0.0.1:3001，协议选 Cuko API (SSE)，密钥留空',
  '',
  '【数据在哪】',
  '  账号、配置方案、会话、Chrome 登录态、日志都在 exe 同级的 data/ 目录，整个文件夹拷贝即可迁移。',
  '  请放在有写权限的目录，不要放 Program Files。',
  '',
  '【端口】',
  '  默认 3001。改 data/config.json 后重启，或用环境变量 CUKO_HTTP_PORT。',
  '',
  '【常见问题】',
  '  - exe 未签名，SmartScreen 提示时选择「更多信息 → 仍要运行」',
  '  - 双击一闪而过：多半是端口被占用，用命令行运行能看到原因',
  '  - 同一账号同时只能跑一轮对话，并发会返回 429',
  '',
  '【免责声明】',
  '  本项目通过自动化驱动网页界面工作，与 OpenAI 无任何关联，非官方实现。',
  '  请仅在你拥有或获得授权的账号上使用，并遵守相关服务条款。',
].join('\r\n'), 'utf8');
log('完成。产物：' + DIST_DIR);
