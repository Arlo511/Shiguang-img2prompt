/**
 * 记录命名：可自定义模板。
 *
 * 原来是硬编码的 `日期时间-网站名-序号` 三段拼接，写死在
 * background.js 和 panel.js 各一份。两份各写一遍的后果是
 * 改格式要改两个地方，漏一处就出现「文件名和界面标题不一致」。
 *
 * 现在抽到这里，模板由用户在设置页配置，用占位符表达：
 *   {date}     2026.10.13
 *   {time}     16:23
 *   {datetime} 2026.10.13 16:23
 *   {site}     Pinterest
 *   {seq}      001
 *   {engine}   中文 / 英文
 *   {preset}   提示词方案名
 *
 * 设计取舍：**未知占位符原样保留**，不静默替换成空串。
 * 用户打错成 {siet} 时会看到 {siet} 出现在文件名里，
 * 一眼知道是占位符写错了；静默吞掉的话他只会以为插件有 bug。
 */

export const DEFAULT_NAME_FORMAT = '{date} {time}-{site}-{seq}';

/** 引擎 id → 中文标签。与面板的引擎切换按钮保持同一套叫法 */
const ENGINE_LABELS = {
  nanobanana: '英文',
  seedance: '中文',
};

/** 供设置页展示：占位符 → 说明。用户不用猜每个符号是什么 */
export const NAME_TOKENS = [
  { token: '{date}', desc: '日期 2026.10.13' },
  { token: '{time}', desc: '时间 16:23' },
  { token: '{datetime}', desc: '日期+时间' },
  { token: '{site}', desc: '网站名 Pinterest' },
  { token: '{seq}', desc: '序号 001' },
  { token: '{engine}', desc: '输出语言 中文/英文' },
  { token: '{preset}', desc: '提示词方案名' },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 按模板生成记录名。
 *
 * @param {object}  record   记录对象（用 createdAt / engine / presetName / nameSeq）
 * @param {string}  siteName 已提取好的网站名；空则用「本地」
 * @param {string}  format   模板；空或缺省时用 DEFAULT_NAME_FORMAT
 * @returns {string}
 */
export function formatRecordName(record, siteName, format) {
  const tpl = String(format || '').trim() || DEFAULT_NAME_FORMAT;
  const d = new Date(record?.createdAt || Date.now());

  const date = `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const seq = String(record?.nameSeq || 1).padStart(3, '0');
  const engine = ENGINE_LABELS[record?.engine] || '英文';

  const values = {
    '{date}': date,
    '{time}': time,
    '{datetime}': `${date} ${time}`,
    '{site}': siteName || '本地',
    '{seq}': seq,
    '{engine}': engine,
    '{preset}': String(record?.presetName || '').trim() || '默认',
  };

  let out = tpl;
  for (const [token, val] of Object.entries(values)) {
    // split/join 而非 replace：replace 只替换第一个，
    // 模板里写两次 {site} 时第二个会原样留着。
    out = out.split(token).join(val);
  }

  // 模板全是未知占位符 → 回落到默认，否则文件名会变成一个空壳
  if (!/[^\s{}]/.test(out.replace(/\{[^}]*\}/g, '')) && !out.replace(/\{[^}]*\}/g, '').trim()) {
    return formatRecordName(record, siteName, DEFAULT_NAME_FORMAT);
  }

  return out.replace(/\s+/g, ' ').trim() || DEFAULT_NAME_FORMAT;
}

/**
 * 校验模板是否至少替换得出一段正常文本。
 * @returns {{ok: boolean, msg?: string}}
 */
export function validateNameFormat(format) {
  const tpl = String(format || '').trim();
  if (!tpl) return { ok: false, msg: '模板为空，将使用默认格式' };
  const known = NAME_TOKENS.map((t) => t.token);
  const found = [...tpl.matchAll(/\{[^}]*\}/g)].map((m) => m[0]);
  const unknown = found.filter((tk) => !known.includes(tk));
  if (unknown.length) {
    return { ok: false, msg: `无法识别：${[...new Set(unknown)].join(' ')}` };
  }
  // 一个占位符都没有 ⇒ 所有记录会得到同一个名字，历史里根本分不清
  //（「我的图片」这种纯文字、或「-_-」这种纯分隔符都不行）。
  if (!found.length) {
    return { ok: false, msg: '至少要保留一个占位符，否则所有记录会重名' };
  }
  return { ok: true };
}
