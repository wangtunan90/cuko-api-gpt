/**
 * extractor 离线验证
 * 用真实抓包样本（test/sample-sse.txt）跑一遍解析，验证：
 *  - 帧解码能正确处理任意 chunk 切分（模拟 dataReceived 的碎片到达）
 *  - extractor 提取出的文本、finished、endTurn、modelType 正确
 *  - 非 delta 帧（delta_encoding / input_message / ads / message_marker / server_ste_metadata）被正确忽略
 *  - system 角色消息不污染正文
 *  - o=replace v=null 的 end_turn 不误置 finished
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrameDecoder, extractData } from '../bridge/sse.js';
import { createExtractor, resolveStatus } from '../bridge/extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sample = fs.readFileSync(path.join(__dirname, 'sample-sse.txt'), 'utf8');

const EXPECTED_TEXT = '我是 **GPT-6**，由 OpenAI 训练的推理模型。';

function runWithChunkSize(text, chunkSize) {
  const decoder = createFrameDecoder();
  const extractor = createExtractor(null);
  const seen = {};
  const handleFrame = (frame) => {
    const r = extractData(frame);
    if (r == null) return;
    if (r === '[DONE]') { extractor.markDone(); return; }
    if (seen[r]) return;
    seen[r] = 1;
    let parsed;
    try { parsed = JSON.parse(r); } catch (_) { return; }
    extractor.consume(parsed);
  };
  for (let i = 0; i < text.length; i += chunkSize) {
    const frames = decoder.push(text.slice(i, i + chunkSize));
    for (const f of frames) handleFrame(f);
  }
  const rest = decoder.finish();
  for (const f of rest) handleFrame(f);
  return extractor;
}

const results = [];
for (const size of [1, 7, 50, 200, 1024, sample.length]) {
  const ex = runWithChunkSize(sample, size);
  const status = resolveStatus(ex, false);
  const pass = ex.text === EXPECTED_TEXT && ex.finished && ex.endTurn && status === 'finished';
  results.push({
    chunkSize: size,
    pass,
    text: ex.text,
    finished: ex.finished,
    endTurn: ex.endTurn,
    failed: ex.failed,
    serverStopped: ex.serverStopped,
    modelType: ex.tokenUsage && ex.tokenUsage.modelType,
    status,
  });
}

console.log('=== 结果 ===');
for (const r of results) {
  console.log(
    'chunk=' + String(r.chunkSize).padStart(5) +
    ' ' + (r.pass ? 'PASS' : 'FAIL') +
    ' | text=' + JSON.stringify(r.text) +
    ' | finished=' + r.finished + ' endTurn=' + r.endTurn +
    ' failed=' + r.failed + ' model=' + r.modelType + ' status=' + r.status
  );
}

const allPass = results.every(r => r.pass);
const sameText = results.every(r => r.text === EXPECTED_TEXT);
console.log('');
console.log('全部 chunk 大小通过: ' + (allPass ? 'YES' : 'NO'));
console.log('文本完全一致: ' + (sameText ? 'YES' : 'NO'));
console.log('期望文本: ' + JSON.stringify(EXPECTED_TEXT));
console.log('实际文本: ' + JSON.stringify(results[0].text));
console.log('');
console.log('--- 逐帧细节（chunk=全量）---');
const ex = runWithChunkSize(sample, sample.length);
console.log('snapshot:', JSON.stringify(ex.snapshot(), null, 2));
console.log('msgIds:', JSON.stringify(ex.msgIds));
process.exit(allPass ? 0 : 1);
