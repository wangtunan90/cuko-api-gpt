/**
 * 输入归一化（参考 cuko-api-quick）
 * 兼容 {type:'text',text}、{content:'...'}、{content:[...]} 等形态；未识别项记进 unknown，不静默丢弃。
 */
export function normalizeInputItems(input) {
  const items = [];
  const unknown = [];
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') { unknown.push('非对象:' + typeof raw); continue; }
    let text = '';
    if (typeof raw.text === 'string') text = raw.text;
    else if (typeof raw.content === 'string') text = raw.content;
    else if (Array.isArray(raw.content)) {
      text = raw.content
        .map(c => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : '')))
        .filter(Boolean)
        .join('');
      const nonText = raw.content.filter(c => !(typeof c === 'string' || (c && typeof c.text === 'string')));
      if (nonText.length) unknown.push('content-part:' + nonText.map(c => (c && c.type) || typeof c).join('|'));
    }
    if (text) { items.push({ kind: 'text', text, rawType: raw.type }); continue; }
    if (raw.data) {
      items.push({ kind: 'file', data: raw.data, filename: raw.filename || 'file', mimeType: raw.mimeType || '', rawType: raw.type });
      continue;
    }
    unknown.push((raw.type || 'no-type') + '[' + Object.keys(raw).join('|') + ']');
  }
  return { items, unknown };
}
