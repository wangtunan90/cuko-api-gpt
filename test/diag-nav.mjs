import CDP from 'chrome-remote-interface';
const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到页面'); process.exit(1); }
console.log('当前 URL:', target.url);
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();
const r = await Runtime.evaluate({ expression: `(() => {
  const sels = ['div[contenteditable="true"].ProseMirror','div[role="textbox"]','div.ProseMirror','div[contenteditable="true"]'];
  let input = null;
  let info = [];
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      info.push({ sel: s, visible: e.offsetWidth > 0 && e.offsetHeight > 0, w: e.offsetWidth, h: e.offsetHeight, editable: e.contentEditable });
      if (!input && e.offsetWidth > 0 && e.offsetHeight > 0) input = e;
    }
  }
  if (!input) return { url: location.href, noInput: true, info, bodyLen: document.body.innerText.length };
  const norm = (s) => String(s || '').replace(/\\s+/g, '');
  input.focus();
  const focusOk = document.activeElement === input;
  // 尝试插入
  const ok = document.execCommand('insertText', false, 'DIAGTEST');
  const after = norm(input.innerText).length;
  return { url: location.href, focusOk, ok, after, info, inputInnerLen: norm(input.innerText).length };
})()`, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
await client.close();
