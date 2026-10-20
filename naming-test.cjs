/**
 * 域名提取与记录命名测试
 *
 * makeRecordName 的实现已抽到 src/core/naming.js（支持自定义模板），
 * 这里复制一份纯函数版本来测 —— 测试不 import被测代码，
 * 才能发现「实现和预期一起跑偏」。
 */
const t = [];
const eq = (n, a, b) => t.push([n, a === b, `期望 ${b}\n      实际 ${a}`]);

function siteNameFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw || raw === 'local' || !/^https?:\/\//i.test(raw)) return '';
  try {
    let host = new URL(raw).hostname.toLowerCase();
    host = host.replace(/^www\./, '');
    if (!host) return '';
    const parts = host.split('.');
    if (parts.length < 2 || /^\d/.test(parts[parts.length - 1])) return '';
    const tail2 = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'];
    const second = parts[parts.length - 2];
    const main = tail2.includes(second) && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
    if (!main || /^\d/.test(main)) return '';
    return main.charAt(0).toUpperCase() + main.slice(1);
  } catch { return ''; }
}

const ENGINE_LABELS = { nanobanana: '英文', seedance: '中文' };
const DEFAULT_NAME_FORMAT = '{date} {time}-{site}-{seq}';
const KNOWN = ['{date}', '{time}', '{datetime}', '{site}', '{seq}', '{engine}', '{preset}'];

function formatRecordName(record, siteName, format) {
  const tpl = String(format || '').trim() || DEFAULT_NAME_FORMAT;
  const d = new Date(record?.createdAt || Date.now());
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const values = {
    '{date}': date,
    '{time}': time,
    '{datetime}': `${date} ${time}`,
    '{site}': siteName || '本地',
    '{seq}': String(record?.nameSeq || 1).padStart(3, '0'),
    '{engine}': ENGINE_LABELS[record?.engine] || '英文',
    '{preset}': String(record?.presetName || '').trim() || '默认',
  };
  let out = tpl;
  for (const [token, val] of Object.entries(values)) out = out.split(token).join(val);
  return out.replace(/\s+/g, ' ').trim() || DEFAULT_NAME_FORMAT;
}

function validateNameFormat(format) {
  const tpl = String(format || '').trim();
  if (!tpl) return { ok: false, msg: '模板为空，将使用默认格式' };
  const found = [...tpl.matchAll(/\{[^}]*\}/g)].map((m) => m[0]);
  const unknown = found.filter((tk) => !KNOWN.includes(tk));
  if (unknown.length) return { ok: false, msg: `无法识别：${[...new Set(unknown)].join(' ')}` };
  if (!found.length) return { ok: false, msg: '至少要保留一个占位符，否则所有记录会重名' };
  return { ok: true };
}

const makeRecordName = (record, siteName) => formatRecordName(record, siteName, DEFAULT_NAME_FORMAT);

// 域名提取
eq('pinterest', siteNameFromUrl('https://www.pinterest.com/pin/123'), 'Pinterest');
eq('小红书', siteNameFromUrl('https://www.xiaohongshu.com/explore/abc'), 'Xiaohongshu');
eq('带子路径', siteNameFromUrl('https://www.google.com/search?q=a'), 'Google');
eq('无 www', siteNameFromUrl('https://pinterest.com/x'), 'Pinterest');
eq('二级后缀 uk', siteNameFromUrl('https://www.example.co.uk/a'), 'Example');
eq('二级后缀 cn', siteNameFromUrl('https://www.taobao.com.cn/x'), 'Taobao');
eq('localhost', siteNameFromUrl('http://localhost:3000/a'), '');
eq('IP 地址', siteNameFromUrl('http://127.0.0.1/img.png'), '');
eq('local 标记', siteNameFromUrl('local'), '');
eq('空值', siteNameFromUrl(''), '');
eq('非法 URL', siteNameFromUrl('not a url'), '');
eq('大写域名', siteNameFromUrl('https://WWW.Pinterest.com/x'), 'Pinterest');
eq('深层子域', siteNameFromUrl('https://cdn.img.pinterest.com/a.png'), 'Pinterest');

// 命名格式（默认模板 —— 必须与改动前逐字一致）
const ts = new Date(2026, 9, 13, 16, 23).getTime();
eq('标准格式', makeRecordName({ createdAt: ts, nameSeq: 1 }, 'Pinterest'),
   '2026.10.13 16:23-Pinterest-001');
eq('三位序号', makeRecordName({ createdAt: ts, nameSeq: 12 }, 'Pinterest'),
   '2026.10.13 16:23-Pinterest-012');
eq('本地兜底', makeRecordName({ createdAt: ts, nameSeq: 1 }, ''),
   '2026.10.13 16:23-本地-001');
eq('补零月日', makeRecordName({ createdAt: new Date(2026, 0, 5, 8, 5).getTime(), nameSeq: 1 }, 'X'),
   '2026.01.05 08:05-X-001');
eq('格式缺省时用默认', formatRecordName({ createdAt: ts, nameSeq: 1 }, 'X', ''),
   '2026.10.13 16:23-X-001');

// 自定义模板
eq('只用网站名', formatRecordName({ createdAt: ts, nameSeq: 1 }, 'Pinterest', '{site}'), 'Pinterest');
eq('引擎占位符', formatRecordName({ createdAt: ts, engine: 'seedance' }, 'X', '{engine}-{seq}'), '中文-001');
eq('方案占位符', formatRecordName({ createdAt: ts, presetName: '人像' }, 'X', '{preset}'), '人像');
eq('方案缺省', formatRecordName({ createdAt: ts }, 'X', '{preset}'), '默认');
eq('datetime合并', formatRecordName({ createdAt: ts }, 'X', '{datetime}'), '2026.10.13 16:23');
eq('同一占位符出现两次',
   formatRecordName({ createdAt: ts }, 'X', '{site}/{site}'), 'X/X');
eq('未知占位符原样保留',
   formatRecordName({ createdAt: ts }, 'X', '{siet}'), '{siet}');

// 模板校验
eq('校验：正常', validateNameFormat('{date}-{seq}').ok, true);
eq('校验：空', validateNameFormat('').ok, false);
eq('校验：纯空白', validateNameFormat('   ').ok, false);
eq('校验：拼错', validateNameFormat('{siet}').ok, false);
eq('校验：无占位符', validateNameFormat('我的图片').ok, false);
eq('校验：只有分隔符', validateNameFormat('-_-').ok, false);
eq('校验：多个未知', validateNameFormat('{a}{b}').ok, false);

// 序号递增（模拟同一分钟）
let m = new Map();
const nextSeq = (ts2, site) => {
  const d = new Date(ts2);
  const p2 = (n) => String(n).padStart(2, '0');
  const key = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}-${site || '本地'}`;
  const n = (m.get(key) || 0) + 1; m.set(key, n); return n;
};
eq('同站递增 1', nextSeq(ts, 'Pinterest'), 1);
eq('同站递增 2', nextSeq(ts, 'Pinterest'), 2);
eq('同站递增 3', nextSeq(ts, 'Pinterest'), 3);
eq('异站独立计数', nextSeq(ts, 'Xiaohongshu'), 1);
eq('跨分钟重置', nextSeq(ts + 60000, 'Pinterest'), 1);

// CDN 识别 —— 这些域名前缀看着像站点，其实是图片存放处
const CDN_HOST_HINTS=['pinimg','xhscdn','imgix','cdninstagram','fbcdn','licdn','cloudfront','akamaized','alicdn','qiniucdn','byteimg','gtimg','sinaimg','douyinpic','douyincdn','pstatp','yimg'];
function looksLikeCdn(host){const h=String(host||'').toLowerCase();return CDN_HOST_HINTS.some(k=>h.includes(k));}

eq('pinimg 是 CDN', looksLikeCdn('i.pinimg.com'), true);
eq('xhscdn 是 CDN', looksLikeCdn('sns-webpic-qc.xhscdn.com'), true);
eq('alicdn 是 CDN', looksLikeCdn('img.alicdn.com'), true);
eq('pinterest.com 不是 CDN', looksLikeCdn('www.pinterest.com'), false);
eq('xiaohongshu.com 不是 CDN', looksLikeCdn('www.xiaohongshu.com'), false);

// 组合场景：图片在 CDN 上，页面是真实站点
const pageUrl='https://www.pinterest.com/pin/123/';
eq('CDN 图+真实页面 → 用页面域名', siteNameFromUrl(pageUrl)|| (looksLikeCdn('i.pinimg.com')?'本地':'?'), 'Pinterest');

const bad = t.filter((x) => !x[1]);
bad.forEach((x) => console.log('✗', x[0], x[2]));
console.log(bad.length ? `${bad.length} / ${t.length} 失败` : `全部 ${t.length} 项通过`);
