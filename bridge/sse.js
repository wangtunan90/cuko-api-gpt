/**
 * SSE 帧解码 + data 提取
 * [261120] 照搬 cuckoo-code src/providers/hooks/shared/sse.ts 的逻辑。
 * 详见 docs/protocols/chatgpt-web-protocol.md 第 3 节
 */

/**
 * 创建帧解码器：缓冲 + 按空行切帧，正确处理跨 chunk 边界。
 * 返回 { push(chunk): string[], finish(): string[] }
 */
export function createFrameDecoder() {
  let buffer = '';
  let scanFrom = 0;
  return {
    push(text) {
      buffer += text;
      const frames = [];
      const re = /\r?\n\r?\n/g;
      let offset = 0;
      let m;
      re.lastIndex = scanFrom;
      while ((m = re.exec(buffer)) !== null) {
        frames.push(buffer.slice(offset, m.index));
        offset = m.index + m[0].length;
      }
      buffer = buffer.slice(offset);
      scanFrom = Math.max(0, buffer.length - 3); // 保留可能跨界的尾部
      return frames;
    },
    finish() {
      const frames = [];
      if (buffer) frames.push(buffer);
      buffer = '';
      scanFrom = 0;
      return frames;
    },
  };
}

/**
 * 从一帧（可能多行 data:）中提取 data 字符串。
 * 多行 data 用 \n 拼接；无 data 行返回 null。
 */
export function extractData(block) {
  if (!block || !block.trim()) return null;
  let data = null;
  const lines = block.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('data:') === 0) {
      const d = line.slice(5).trim();
      data = data == null ? d : data + '\n' + d;
    }
  }
  return data;
}
