/**
 * 默认配置方案（不可修改）
 * [261120] 从 one-chrome-ex 搬来，改动：targetUrl 改为 chatgpt.com；
 * 字段结构保留（Chrome 路径 / 时序 / 等待区间 / 开关）。
 */

export const DEFAULT_PROFILE_VALUES = Object.freeze({
  // ===== Chrome 组 =====
  chromePath: '',
  extraArgs: '',
  targetUrl: 'https://chatgpt.com/',

  // ===== 时序组（秒，支持小数） =====
  connectPollMaxSec: 25,
  pageReadyPollMaxSec: 20,
  /** 单次请求流式接收的最长秒数，超时强制结束。
   *  实际卡死判定由 index.js 的空闲超时负责，这里的总超时只兜「永不结束」的极端情况。 */
  requestTimeoutSec: 600,
  /** 文件上传等待超时（秒） */
  fileUploadTimeoutSec: 30,

  // ===== 等待区间（秒，随机取值） =====
  textPasteWaitMinSec: 1.5,
  textPasteWaitMaxSec: 3.5,
  filePasteWaitMinSec: 5.0,
  filePasteWaitMaxSec: 10.0,
  preEnterWaitMinSec: 2.0,
  preEnterWaitMaxSec: 5.0,

  // ===== 账号组转移 =====
  transferChunkIntervalMinSec: 60,
  transferChunkIntervalMaxSec: 300,

  // ===== 开关组 =====
  disableBackgroundThrottling: true,
});

export const FIELD_LABELS = Object.freeze({
  chromePath: 'Chrome 路径（留空自动探测）',
  extraArgs: '额外启动参数',
  targetUrl: '目标页面 URL',
  connectPollMaxSec: 'CDP 端口就绪超时（秒）',
  pageReadyPollMaxSec: '页面就绪超时（秒）',
  requestTimeoutSec: '请求超时（秒）',
  fileUploadTimeoutSec: '文件上传超时（秒）',
  textPasteWaitMinSec: '文本粘贴等待下限（秒）',
  textPasteWaitMaxSec: '文本粘贴等待上限（秒）',
  filePasteWaitMinSec: '文件粘贴等待下限（秒）',
  filePasteWaitMaxSec: '文件粘贴等待上限（秒）',
  preEnterWaitMinSec: '回车前等待下限（秒）',
  preEnterWaitMaxSec: '回车前等待上限（秒）',
  transferChunkIntervalMinSec: '转移分片间隔下限（秒）',
  transferChunkIntervalMaxSec: '转移分片间隔上限（秒）',
  disableBackgroundThrottling: '防后台节流',
});

const NUMBER_FIELDS = [
  'connectPollMaxSec', 'pageReadyPollMaxSec', 'requestTimeoutSec', 'fileUploadTimeoutSec',
  'textPasteWaitMinSec', 'textPasteWaitMaxSec',
  'filePasteWaitMinSec', 'filePasteWaitMaxSec',
  'preEnterWaitMinSec', 'preEnterWaitMaxSec',
  'transferChunkIntervalMinSec', 'transferChunkIntervalMaxSec',
];

const RANGE_PAIRS = [
  ['textPasteWaitMinSec', 'textPasteWaitMaxSec', '文本粘贴等待'],
  ['filePasteWaitMinSec', 'filePasteWaitMaxSec', '文件粘贴等待'],
  ['preEnterWaitMinSec', 'preEnterWaitMaxSec', '回车前等待'],
  ['transferChunkIntervalMinSec', 'transferChunkIntervalMaxSec', '转移分片间隔'],
];

export function validateProfile(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('配置内容必须是对象');
  }
  const out = { ...DEFAULT_PROFILE_VALUES };
  for (const k of Object.keys(DEFAULT_PROFILE_VALUES)) {
    if (values[k] !== undefined) out[k] = values[k];
  }
  for (const k of ['chromePath', 'extraArgs', 'targetUrl']) {
    if (typeof out[k] !== 'string') throw new Error(`字段 ${k} 必须是字符串`);
  }
  if (!out.targetUrl.trim()) throw new Error('目标页面 URL 不能为空');
  for (const k of NUMBER_FIELDS) {
    const n = Number(out[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`字段 ${k} 必须是非负数字`);
    out[k] = n;
  }
  if (typeof out.disableBackgroundThrottling !== 'boolean') {
    throw new Error('字段 disableBackgroundThrottling 必须是布尔值');
  }
  for (const [minK, maxK, label] of RANGE_PAIRS) {
    if (out[minK] > out[maxK]) throw new Error(`${label}的下限不能大于上限`);
  }
  return out;
}

export function randomInRange(minSec, maxSec) {
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  const ms = lo * 1000 + Math.random() * (hi - lo) * 1000;
  return Math.round(ms);
}
