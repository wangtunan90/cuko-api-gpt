/**
 * ChatGPT 页面驱动（CDP 侧）
 * [261120] 与 one-chrome-ex 的差异：
 *  - 输入框是 ProseMirror（contenteditable），不是 textarea
 *  - 不能用剪贴板 paste（会被识别为"粘贴文件"），要用 execCommand('insertText')
 *  - 发送靠鼠标点击发送按钮（Enter 依赖页面焦点，后台会丢）
 * 详见 docs/protocols/chatgpt-web-protocol.md 第 6 节坑 5
 */

/** 输入框选择器（按优先级，必须可见） */
const INPUT_SELECTORS = [
  'div[contenteditable="true"].ProseMirror',
  'div[role="textbox"]',
  'div.ProseMirror',
  'div[contenteditable="true"]',
  'textarea',
];

/** 发送按钮选择器 */
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="发送提示词"]',
  'button[aria-label*="发送"]',
  'button[aria-label*="Send"]',
];

/**
 * 在页面里找可见输入框，返回 { found, tag, length }。
 * 用 Runtime.evaluate 执行。
 */
export async function probeInput(conn) {
  const expr = `(() => {
    const sels = ${JSON.stringify(INPUT_SELECTORS)};
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      for (let i = 0; i < els.length; i++) {
        const e = els[i];
        if (e.offsetWidth > 0 && e.offsetHeight > 0) {
          const len = String(e.innerText || e.value || e.textContent || '').length;
          return { found: true, tag: e.tagName, length: len };
        }
      }
    }
    return { found: false, length: 0 };
  })()`;
  const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
  return (r && r.result && r.result.value) || { found: false, length: 0 };
}

/**
 * 等输入框出现（轮询），返回 true/false。
 */
export async function waitInput(conn, maxSec) {
  const max = Math.max(1, Math.ceil(maxSec || 20));
  for (let i = 0; i < max; i++) {
    try {
      const p = await probeInput(conn);
      if (p.found) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * 填入文本（execCommand insertText 分段）。返回 { ok, written, expected }。
 * 注意：ProseMirror 合成 paste 会被识别为附件，必须用 insertText。
 */
export async function fillInput(conn, text, maxRetries) {
  const retries = Math.max(1, maxRetries || 3);
  let last = { ok: false, reason: 'no-attempt' };
  for (let attempt = 1; attempt <= retries; attempt++) {
    last = await fillInputOnce(conn, text);
    // [261120-fix] 导航后 ProseMirror 可能还没挂载完，DOM 在但 execCommand 无效。
    // written < 90% 视为失败，等 1.5s 重试（页面初始化通常 2-5s 完成）。
    if (last && last.ok) return last;
    if (attempt < retries) {
      console.log('[driver] fillInput 第 ' + attempt + ' 次失败（written=' + (last.written || 0) + '/' + (last.expected || '?') + '），1.5s 后重试');
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return last;
}

async function fillInputOnce(conn, text) {
  const expr = `(() => {
    const text = ${JSON.stringify(text)};
    const sels = ${JSON.stringify(INPUT_SELECTORS)};
    let input = null;
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      for (let i = 0; i < els.length; i++) {
        const e = els[i];
        if (e.offsetWidth > 0 && e.offsetHeight > 0) { input = e; break; }
      }
      if (input) break;
    }
    if (!input) return { ok: false, reason: 'no-input' };
    try {
      input.focus();
      // [261120-fix] 实测：
      //  - execCommand('delete') 在 ProseMirror 有大内容时会卡死（clean-input 诊断 20s 超时）
      //  - CHUNK=5000 分块插入会卡住（diag v4 30s 超时）
      //  - 整块 insertText 8967 字仅 12ms（diag v5 成功）
      // 故改为：全选（覆盖选中范围）+ 整块 insertText，不单独 delete、不分块。
      try {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(input);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch (_) {}
      document.execCommand('insertText', false, text);
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      // 读回校验（去空白长度）
      const norm = (s) => String(s || '').replace(/\\s+/g, '');
      const probe = norm(text);
      const written = norm(input.innerText || input.textContent || '');
      const ok = written.length > 0 && written.length >= probe.length * 0.9;
      return { ok, written: written.length, expected: probe.length };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  })()`;
  const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
  return (r && r.result && r.result.value) || { ok: false, reason: 'no-result' };
}

/**
 * 找发送按钮并返回其屏幕坐标（CSS 像素）。
 * 返回 { found, x, y }。
 */
export async function findSendButton(conn) {
  const expr = `(() => {
    const sels = ${JSON.stringify(SEND_SELECTORS)};
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      for (let i = 0; i < els.length; i++) {
        const b = els[i];
        if (b.offsetWidth > 0 && b.offsetHeight > 0 && !b.disabled) {
          const rect = b.getBoundingClientRect();
          return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        }
      }
    }
    return { found: false };
  })()`;
  const r = await conn.Runtime.evaluate({ expression: expr, returnByValue: true });
  return (r && r.result && r.result.value) || { found: false };
}

/**
 * 读输入框当前文本长度（判发送成功：清空）。
 */
export async function inputLength(conn) {
  const p = await probeInput(conn);
  return p.length || 0;
}

/**
 * 触发发送：优先真实鼠标点击按钮；失败回退 Enter（CDP dispatchKeyEvent）。
 * 返回 { ok, method }。
 */
export async function triggerSend(conn, waitMs) {
  const deadline = Date.now() + (waitMs || 8000);
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const btn = await findSendButton(conn);
    if (btn.found) {
      try {
        await conn.Input.dispatchMouseEvent({ type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await conn.Input.dispatchMouseEvent({ type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 500));
        const remain = await inputLength(conn);
        if (remain <= 2) return { ok: true, method: 'click', attempt };
      } catch (e) {
        console.warn('[driver] 鼠标点击失败:', e.message);
      }
    } else {
      // 无按钮：Enter（CDP）
      try {
        await conn.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await conn.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await new Promise(r => setTimeout(r, 400));
        const remain = await inputLength(conn);
        if (remain <= 2) return { ok: true, method: 'enter', attempt };
      } catch (e) {
        console.warn('[driver] Enter 失败:', e.message);
      }
    }
    await new Promise(r => setTimeout(r, 600));
  }
  return { ok: false, method: 'none', attempt };
}

/**
 * 判定页面登录态：读 location.href，含 /auth/login 或 /sign_in 视为未登录。
 * 注意 ChatGPT 未登录会跳 https://chatgpt.com/auth/login。
 */
export async function checkLogin(conn) {
  const r = await conn.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
  const url = (r && r.result && r.result.value) || '';
  const loggedOut = url.indexOf('/auth/login') >= 0 || url.indexOf('/sign_in') >= 0;
  return { url, loggedOut };
}
