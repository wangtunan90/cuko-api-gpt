import CDP from 'chrome-remote-interface';
const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到页面'); process.exit(1); }
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();
// 清空输入框 + 报告当前状态
const r = await Runtime.evaluate({ expression: `(() => {
  const sels = ['div[contenteditable="true"].ProseMirror','div[role="textbox"]','div.ProseMirror','div[contenteditable="true"]'];
  let input = null;
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (e.offsetWidth > 0 && e.offsetHeight > 0) { input = e; break; }
    }
    if (input) break;
  }
  if (!input) return { error: 'no-input', url: location.href };
  const beforeLen = String(input.innerText || '').length;
  try {
    input.focus();
    const sel = window.getSelection();
    if (sel) { const range = document.createRange(); range.selectNodeContents(input); sel.removeAllRanges(); sel.addRange(range); document.execCommand('delete'); }
  } catch (e) {}
  const afterLen = String(input.innerText || '').length;
  return { url: location.href, beforeLen, afterLen, ok: afterLen === 0 };
})()`, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
await client.close();
