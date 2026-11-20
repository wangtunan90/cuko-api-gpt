import CDP from 'chrome-remote-interface';

const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到 ChatGPT 页面'); process.exit(1); }
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();

// 构造真正 8967 字符的文本（汉字 + 换行）
let longText = '';
while (longText.length < 8967) longText += '这是测试内容\n';
longText = longText.slice(0, 8967);
const normLen = (s) => String(s || '').replace(/\s+/g, '').length;
console.log('文本字符数:', longText.length, '去空白后:', normLen(longText));

const expr = `(() => {
  const text = ${JSON.stringify(longText)};
  const CHUNK = 5000;
  const sels = ['div[contenteditable="true"].ProseMirror','div[role="textbox"]','div.ProseMirror','div[contenteditable="true"]','textarea'];
  let input = null;
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (e.offsetWidth > 0 && e.offsetHeight > 0) { input = e; break; }
    }
    if (input) break;
  }
  if (!input) return { error: 'no-input' };
  const trace = [];
  const norm = (s) => String(s || '').replace(/\\s+/g, '');
  input.focus();
  // delete
  try {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, undefined);
    }
  } catch (e) {}
  trace.push({ step: 'after-delete', len: norm(input.innerText).length });
  // CHUNK=5000 分段
  for (let i = 0; i < text.length; i += CHUNK) {
    let ok;
    try { ok = document.execCommand('insertText', false, text.slice(i, i + CHUNK)); }
    catch (e) { ok = 'THROW: ' + e.message; }
    trace.push({ step: 'chunk', i, chunkLen: Math.min(CHUNK, text.length - i), ok, lenAfter: norm(input.innerText).length });
  }
  const written = norm(input.innerText).length;
  trace.push({ step: 'final', written, expected: norm(text).length });
  return { trace };
})()`;

const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
await client.close();
