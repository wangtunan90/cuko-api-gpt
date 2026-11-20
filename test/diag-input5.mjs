import CDP from 'chrome-remote-interface';
const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到页面'); process.exit(1); }
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();

// 纯中文 8967 字（无换行）
let longText = '';
while (longText.length < 8967) longText += '这是测试内容';
longText = longText.slice(0, 8967);

const expr = `(() => {
  const text = ${JSON.stringify(longText)};
  const sels = ['div[contenteditable="true"].ProseMirror','div[role="textbox"]','div.ProseMirror','div[contenteditable="true"]'];
  let input = null;
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    for (let i = 0; i < els.length; i++) { const e = els[i]; if (e.offsetWidth > 0 && e.offsetHeight > 0) { input = e; break; } }
    if (input) break;
  }
  if (!input) return { error: 'no-input' };
  const trace = [];
  input.focus();
  const t0 = Date.now();
  // 整块 insertText（不切分）
  let ok, err;
  try { ok = document.execCommand('insertText', false, text); } catch (e) { err = e.message; }
  const t1 = Date.now();
  const len = String(input.innerText || '').length;
  trace.push({ step: 'whole', ok, err, len, costMs: t1 - t0, textLen: text.length });
  return { trace };
})()`;

const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
await client.close();
