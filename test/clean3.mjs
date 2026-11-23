import CDP from 'chrome-remote-interface';
const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (target) {
  const client = await CDP({ target: target.webSocketDebuggerUrl });
  const { Runtime } = client;
  await Runtime.enable();
  await Runtime.evaluate({ expression: `(() => {
    const sels = ['div[contenteditable="true"].ProseMirror','div[role="textbox"]','div.ProseMirror','div[contenteditable="true"]'];
    for (const s of sels) { const els = document.querySelectorAll(s); for (let i = 0; i < els.length; i++) { const e = els[i]; if (e.offsetWidth > 0 && e.offsetHeight > 0) { e.focus(); const sel = window.getSelection(); if (sel) { const r = document.createRange(); r.selectNodeContents(e); sel.removeAllRanges(); sel.addRange(r); } document.execCommand('insertText', false, ''); return { cleared: true }; } } }
    return { cleared: false };
  })()`, returnByValue: true });
  await client.close();
  console.log('已清理');
} else { console.log('无页面'); }
