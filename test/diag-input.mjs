import CDP from 'chrome-remote-interface';

const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到 ChatGPT 页面'); process.exit(1); }
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();

const expr = `(() => {
  const sels = [
    'div[contenteditable="true"].ProseMirror',
    'div[role="textbox"]',
    'div.ProseMirror',
    'div[contenteditable="true"]',
    'textarea',
  ];
  const out = { url: location.href, hasFocus: document.hasFocus(), selectors: [] };
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    const info = { sel: s, count: els.length, items: [] };
    for (let i = 0; i < els.length && i < 5; i++) {
      const e = els[i];
      info.items.push({
        tag: e.tagName,
        visible: e.offsetWidth > 0 && e.offsetHeight > 0,
        w: e.offsetWidth, h: e.offsetHeight,
        contentEditable: e.contentEditable,
        innerTextLen: String(e.innerText || '').length,
        disabled: e.disabled,
      });
    }
    out.selectors.push(info);
  }
  // 尝试 focus 第一个可见 contenteditable，看 activeElement
  let target = null;
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (e.offsetWidth > 0 && e.offsetHeight > 0) { target = e; break; }
    }
    if (target) break;
  }
  if (target) {
    target.focus();
    out.afterFocus = {
      activeTag: document.activeElement && document.activeElement.tagName,
      activeIsTarget: document.activeElement === target,
      isContentEditable: target.isContentEditable,
    };
    // 测试 execCommand
    const before = String(target.innerText || '').length;
    let execResult;
    try { execResult = document.execCommand('insertText', false, 'TEST123'); }
    catch (e) { execResult = 'THROW: ' + e.message; }
    const after = String(target.innerText || '').length;
    out.execTest = { before, after, execResult, text: String(target.innerText || '').slice(0, 50) };
    // 清理测试文本
    try {
      const sel = window.getSelection();
      if (sel) { const r = document.createRange(); r.selectNodeContents(target); sel.removeAllRanges(); sel.addRange(r); document.execCommand('delete'); }
    } catch (_) {}
  } else {
    out.afterFocus = 'no-visible-input';
  }
  return out;
})()`;

const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
await client.close();
