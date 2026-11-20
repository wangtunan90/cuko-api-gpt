import CDP from 'chrome-remote-interface';

const port = 9333;
const targets = await CDP.List({ port });
const target = targets.find(t => t.url.includes('chatgpt.com') && t.type === 'page');
if (!target) { console.log('找不到 ChatGPT 页面'); process.exit(1); }
const client = await CDP({ target: target.webSocketDebuggerUrl });
const { Runtime } = client;
await Runtime.enable();

// 构造 7745 字中文文本
const longText = '这是测试文本内容。'.repeat(1000).slice(0, 7745);

const expr = `(async () => {
  const TEXT = ${JSON.stringify(longText)};
  const sels = ['div[contenteditable="true"].ProseMirror','div[role="textbox"]','div.ProseMirror','div[contenteditable="true"]'];
  function findInput() {
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      for (let i = 0; i < els.length; i++) {
        const e = els[i];
        if (e.offsetWidth > 0 && e.offsetHeight > 0) return e;
      }
    }
    return null;
  }
  function clearInput(input) {
    try {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
      }
    } catch (e) {}
  }
  function normLen(s) { return String(s || '').replace(/\\s+/g, '').length; }
  const results = {};

  // 测试 1：不 delete，直接整块 insertText
  let input = findInput();
  input.focus();
  let before = normLen(input.innerText);
  let ok1 = document.execCommand('insertText', false, TEXT);
  let after1 = normLen(input.innerText);
  results.test1_noDelete_whole = { ok: ok1, before, after: after1 };
  clearInput(input);

  // 测试 2：delete 后整块 insertText
  input = findInput();
  input.focus();
  clearInput(input);
  let beforeDel = normLen(input.innerText);
  let ok2 = document.execCommand('insertText', false, TEXT);
  let after2 = normLen(input.innerText);
  results.test2_delete_whole = { ok: ok2, beforeDel, after: after2 };
  clearInput(input);

  // 测试 3：delete 后分块（每块 500 字）
  input = findInput();
  input.focus();
  clearInput(input);
  let chunks = [];
  for (let i = 0; i < TEXT.length; i += 500) {
    let okc = document.execCommand('insertText', false, TEXT.slice(i, i + 500));
    chunks.push({ i, ok: okc, len: normLen(input.innerText) });
  }
  let after3 = normLen(input.innerText);
  results.test3_delete_chunks500 = { chunks: chunks.slice(0, 5), total: chunks.length, after: after3 };
  clearInput(input);

  // 测试 4：不 delete，分块 500
  input = findInput();
  input.focus();
  let chunks4 = [];
  for (let i = 0; i < TEXT.length; i += 500) {
    let okc = document.execCommand('insertText', false, TEXT.slice(i, i + 500));
    chunks4.push({ i, ok: okc, len: normLen(input.innerText) });
  }
  let after4 = normLen(input.innerText);
  results.test4_noDelete_chunks500 = { chunks: chunks4.slice(0, 5), total: chunks4.length, after: after4 };
  clearInput(input);

  results.textLen = TEXT.length;
  return results;
})()`;

const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result.value, null, 2));
await client.close();
