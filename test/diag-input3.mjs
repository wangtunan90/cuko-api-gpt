import CDP from 'chrome-remote-interface';

const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到 ChatGPT 页面'); process.exit(1); }
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();

// 模拟真实 8967 字（含换行）的文本
const longText = ('这是测试内容' + String.fromCharCode(10)).repeat(600).slice(0, 8967);

// 完全复现 fillInput 的原实现（CHUNK=5000, delete undefined），但打点
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
  if (!input) return { step: 'no-input' };
  const trace = [];
  const normLen = (s) => String(s || '').replace(/\\s+/g, '').length;

  trace.push({ step: 'found', tag: input.tagName, beforeLen: normLen(input.innerText) });

  input.focus();
  trace.push({ step: 'after-focus', activeIsInput: document.activeElement === input, len: normLen(input.innerText) });

  // delete（原代码用 undefined）
  try {
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      const delOk = document.execCommand('delete', false, undefined);
      trace.push({ step: 'after-delete', delOk, len: normLen(input.innerText) });
    }
  } catch (e) { trace.push({ step: 'delete-throw', error: String(e && e.message) }); }

  // 5000 分块插入（原代码）
  for (let i = 0; i < text.length; i += CHUNK) {
    let ok;
    try { ok = document.execCommand('insertText', false, text.slice(i, i + CHUNK)); }
    catch (e) { ok = 'THROW: ' + e.message; }
    trace.push({ step: 'chunk', i, chunkLen: Math.min(CHUNK, text.length - i), ok, lenAfter: normLen(input.innerText) });
  }

  // input event
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}

  const written = normLen(input.innerText || input.textContent || '');
  trace.push({ step: 'final', written, textTail: String(input.innerText || '').slice(-40) });
  return { trace };
})()`;

const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
await client.close();
