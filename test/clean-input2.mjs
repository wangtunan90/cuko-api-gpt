import CDP from 'chrome-remote-interface';
const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到页面'); process.exit(1); }
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();
const r = await Runtime.evaluate({ expression: `(() => {
  const sels = ['div[contenteditable="true"].ProseMirror','div[role="textbox"]','div.ProseMirror','div[contenteditable="true"]'];
  let input = null;
  for (const s of sels) { const els = document.querySelectorAll(s); for (let i = 0; i < els.length; i++) { const e = els[i]; if (e.offsetWidth > 0 && e.offsetHeight > 0) { input = e; break; } } if (input) break; }
  if (!input) return { error: 'no-input' };
  input.focus();
  const sel = window.getSelection();
  if (sel) { const range = document.createRange(); range.selectNodeContents(input); sel.removeAllRanges(); sel.addRange(range); }
  document.execCommand('insertText', false, '');
  return { len: String(input.innerText || '').length };
})()`, returnByValue: true });
console.log(JSON.stringify(r.result.value));
await client.close();
