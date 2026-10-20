/**
 * 统一字段层（canonical schema）
 *
 * 所有引擎共用同一批字段。字段本身不含任何引擎特定语法，
 * 因此新增引擎时只需写渲染器，不需要动这一层。
 *
 * 字段分三类：
 *   en  英文描述 → 供 Nano Banana 等英文引擎使用
 *   zh  中文描述 → 供Seedance / 即梦等中文引擎使用
 *   meta 引擎无关的结构信息（比例、画质档位等）
 */

export const FIELD_META = [
  { key: 'subject',label: '主体', hint: '画面中的人物/物体/动物，含外观特征' },
  { key: 'action',     label: '动作', hint: '主体的姿态、行为、表情' },
  { key: 'setting',    label: '场景', hint: '环境、地点、背景元素' },
  { key: 'lighting',   label: '光影', hint: '光源方向、软硬、色温、明暗对比' },
  { key: 'composition',label: '构图', hint: '景别、机位角度、主体位置、留白' },
  { key: 'style',      label: '风格', hint: '艺术媒介、视觉风格、质感' },
  { key: 'quality',    label: '画质', hint: '清晰度、渲染特征、镜头语言' },
];

/** 引擎原生支持的比例（Nano Banana 与 Seedance 交集） */
export const SUPPORTED_RATIOS = [
  '1:1', '3:2', '2:3', '3:4', '4:3',
  '4:5', '5:4', '9:16', '16:9', '21:9',
];

/**
 * 每个候选比例的自适应容差 = 它到**左右最近分界点**的距离。
 *
 * 「分界点」是相邻两个候选误差相等处的几何中点：
 *   |a-x|/x = |a-y|/y   的正根是 a = x·√(y/x)
 * 落在这个点上的图，两种判定同样合理，取几何中点是为了让
 * 两侧的容差对称，不会系统性地偏向某一边。
 *
 * 为什么不能用一个全局阈值：
 * 相邻候选的间距差别很大 —— 3:4↔4:5 只隔 3.3%，
 * 而 16:9↔21:9 隔 14.6%，差四倍多。原来那个写死的 0.12
 * 恰好等于 1:1↔5:4 的间距，照着这一对算出来就套给全部候选，
 * 于是：窄的地方被放宽（该判给隔壁的图被抢走），
 * 宽的地方被收紧（2.65:1 的网页banner 正好卡在这个缺口里，
 * 比21:9 近13.7%，超阈值后被硬塞成 1:1）。
 */
const RATIO_TOLERANCE = (() => {
  const rows = SUPPORTED_RATIOS
    .map((r) => {
      const [w, h] = r.split(':').map(Number);
      return { ratio: r, value: w / h };
    })
    .sort((a, b) => a.value - b.value);

  return rows.map((row, i) => {
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const toPrev = prev
      ? Math.abs(row.value * Math.sqrt(prev.value / row.value) - row.value) / row.value
      : Infinity;
    const toNext = next
      ? Math.abs(row.value * Math.sqrt(next.value / row.value) - row.value) / row.value
      : Infinity;
    // 两侧取较小者：容差越过最近的那个分界点，
    // 就说明这图可能属于隔壁，此时宁可判不出来也不猜。
    return { ...row, tolerance: Math.min(toPrev, toNext) };
  });
})();

/**
 * 从图片真实宽高推算最接近的原生比例。
 *
 * **认不出来时返回 null，不要兜底成 1:1。**
 * 网页上大量非标准比例的图（轮播 banner 2.65:1、2:1 分栏图、
 * 超宽拼接图），硬塞成方形会让生成结果的比例完全跑偏 ——
 * 「不知道」比「答错」有用得多。
 * 渲染层据此整句省略比例，而不是写出 "Aspect ratio undefined"。
 *
 * @returns {string|null} 命中的标准比例，或 null 表示无法判定
 */
export function resolveRatio(width, height) {
  if (!width || !height) return null;
  const actual = width / height;

  let best = null;
  let bestDiff = Infinity;
  for (const row of RATIO_TOLERANCE) {
    const diff = Math.abs(actual - row.value) / row.value;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = row;
    }
  }
  return best && bestDiff <= best.tolerance ? best.ratio : null;
}

/**
 * 归一化 VLM 返回结果，缺字段补空串，保证渲染层无需判空
 *
 * text 的归一化规则和别处不同，故单独处理：
 *   - items 是数组，逐条兜底（模型可能只给一条，或给空数组）
 *   - content 里的引号必须去掉：定界符由渲染层统一添加，
 *     混进两套引号会让提示词出现 "「"xxx"」" 这种脏输出
 *   - **不做 stripTail**：标点是文字的一部分，
 *     "夏日特惠。" 剥成 "夏日特惠" 就改写了原图
 *   - kind 区分两种性质完全不同的东西：
 *       'text'     要逐字转写的真文字（标题、价格、正文…）
 *       'graphic'  装饰性标记（logo 图形、花纹字、印章形状…）
 *         它们长得很像，但前者要内容、后者只要形状尺寸位置。
 *         混为一谈会导致模型去「读」一个读不出的图形，
 *         然后要么瞎编内容，要么整条略过。
 */
export function normalizeFields(raw = {}) {
  const out = {};
  for (const { key } of FIELD_META) {
    const v = raw[key] || {};
    out[key] = {
      en: (v.en || '').trim(),
      zh: (v.zh || '').trim(),
    };
  }
  out.constraints = {
    en: (raw.constraints?.en || '').trim(),
    zh: (raw.constraints?.zh || '').trim(),
  };

  const items = Array.isArray(raw.text?.items) ? raw.text.items : [];
  out.text = {
    items: items
      .filter((it) => it && (it.content?.en || it.content?.zh || it.layout?.en || it.layout?.zh))
      .map((it) => ({
        kind: it.kind === 'graphic' ? 'graphic' : 'text',
        content: {
          // 去掉成对引号，交给渲染层统一加
          en: stripQuotes(it.content?.en),
          zh: stripQuotes(it.content?.zh),
        },
        layout: {
          en: (it.layout?.en || '').trim(),
          zh: (it.layout?.zh || '').trim(),
        },
      })),
  };

  return out;
}

/** 去掉包裹文字的成对引号，模型常自行加引号，定界符应由渲染层统一处理 */
function stripQuotes(s) {
  const str = String(s || '').trim();
  const m = str.match(/^["'「『“](.*)["'」』”]$/s);
  return (m ? m[1] : str).trim();
}