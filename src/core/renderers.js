/**
 * 渲染层：把统一字段组装成各引擎可直接粘贴的成品提示词。
 *
 * 两个引擎的差异只在四点上，全部集中在这两个函数里：
 *   1. 字段顺序（英文：主体→动作→场景；中文：主体→场景→动作）
 *   2. 语言（英文散文 / 中文长句）
 *   3. 比例处理（原生参数不进正文 / 写进正文）
 *   4. 约束处理（丢弃 / 独立成句）
 *
 * 拼接前必须剥掉字段自带的结尾标点——视觉模型几乎总会给每个字段加句号，
 * 直接 join 会产出「。,」「.,」「。。」这类脏输出。
 */

/** 剥离字段尾部的中英文标点与空白 */
function stripTail(s) {
  return String(s || '')
    .replace(/[\s.,;:!?。，、；：！？]+$/u, '')
    .trim();
}

const join = (parts, sep) => parts.filter(Boolean).join(sep);

/** Nano Banana：英文散文，公式 Subject + Action + Setting + Composition + Style */
export function renderNanoBanana(fields, ratio) {
  const f = (k) => stripTail(fields[k]?.en);
  const body = join(
    [
      f('subject'),
      f('action'),
      f('setting'),
      f('composition'),
      f('lighting'),
      f('style'),
      f('quality'),
    ],
    ', '
  );

  // 官方要求正向表述，负面约束转成 "free of X"
  const neg = stripNegation(fields.constraints?.en);
  const positive = neg ? ` Keep the frame free of ${neg}.` : '';

  // 所有描述字段都为空时，不要产出残缺提示词
  if (!body) {
    return {
      text: '',
      ratio,
      empty: true,
      note: '未能从这张图提取到可用描述，换个清晰度更高的图或换个视觉模型再试。',
    };
  }

  // 画面里的文字：逐条描述内容与排版，并显式要求逐字复现。
  // 只写"画面有文字"是不够的 —— 那样模型会自己编内容。
  const items = fields.text?.items || [];
  let textPart = '';
  if (items.length) {
    const clauses = textClauses(items, 'en');
    if (clauses.length) {
      textPart =
        ` The image contains text, rendered exactly as written and spelled: ` +
        clauses.join('; ') + '.';
    }
  }

  // 比例认不出来时（resolveRatio 返回 null，比如 2.65:1 的网页 banner）
  // 整句省略。写出 "Aspect ratio undefined." 或留一个孤零零的句号
  // 都是脏输出 —— 不如不提，让模型按内容自行决定。
  const ratioPart = ratio ? ` Aspect ratio ${ratio}.` : '';

  return {
    text: `Generate an image of ${lowerFirst(body)}.${positive}${textPart}${ratioPart}`,
    ratio,
    note: ratio
      ? '比例作为 API 原生参数传入，不要写进 prompt 正文。'
      : '未识别到标准比例，已省略比例描述；调用方不要传该参数。',
  };
}

/**
 * 把 "no text, no watermark" 转成 "text, watermark"。
 * 无否定词时原样当正向名词使用。
 */
function stripNegation(s) {
  return stripTail(s)
    .replace(/\b(no|without|avoid|free of|empty of|absent)\b/gi, '')
    .replace(/[,，]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 主体被裁切后常以大写开头，整句拼接时降为小写更自然 */
function lowerFirst(s) {
  if (!s) return s;
  const first = s.split(' ')[0];
  // 摄影术语缩写与全大写缩写保持原样
  if (/^(ISO|LED|UV|AI|CCD|35mm|50mm|85mm|135mm|f\/?\d)/i.test(first)) return s;
  if (first.length > 1 && first === first.toUpperCase()) return s;
  return s[0].toLowerCase() + s.slice(1);
}

/**
 * 把逐字内容还原成可安全嵌入句子的形式。
 *
 * 内容必须逐字保留 —— 要复刻的正是原图那些字，翻译或改动等于改题。
 * 但内容里的引号会和外层定界符打架，所以按语言换成不同定界符：
 * 中文用「」，英文用双引号。两者对生图模型的提示作用一致。
 *
 * 换行的原文字（多行标语）保持 \\n，让下游知道这是分行排布。
 */
function verbatim(content, lang) {
  const raw = String(content || '').trim();
  if (!raw) return '';
  return lang === 'zh' ? `「${raw}」` : `"${raw}"`;
}

/**
 * 逐条拼出「位置 + 内容 + 样式」的描述。
 *
 * 每条独立成句是刻意的：一张海报有主标题、副标题、价格三处时，
 * 必须写成三句带位置的话。合成一句模型会把它们糊成一行。
 *
 * kind='graphic' 的条目只说形状/尺寸/位置，不加定界符也不转写内容 ——
 * 那类装饰标记的字本来就读不出来，硬要转写只会得到编造的内容。
 * 有layout 就能描述，没有 layout 时也要把位置说清楚，否则等于漏报。
 */
function textClauses(items, lang) {
  // lang 是展示用的语种标记，不是数据键。请求中文却只拿到英文时，
  // 回落到 en —— 图中文字宁可显示原文语言的描述，
  // 也不能因为「zh 缺失」就整条丢掉这段信息。
  const pick = (obj) => (obj?.[lang] || obj?.en || obj?.zh || '');
  return (items || [])
    .map((it) => {
      const layout = stripTail(pick(it.layout));
      const content = pick(it.content).trim();

      if (it.kind === 'graphic') {
        if (!layout) return '';
        return lang === 'zh' ? `${layout}（装饰性标记）` : `${layout} (decorative mark)`;
      }

      if (!content) return '';
      const quoted = verbatim(content, lang);
      if (!layout) return quoted;
      return lang === 'zh' ? `${layout}：${quoted}` : `${layout}, reading ${quoted}`;
    })
    .filter(Boolean);
}

/** Seedance / 即梦文生图：中文长句，公式 主体 + 场景 + 动作 + 光影 + 风格 + 画质 */
export function renderSeedance(fields, ratio) {
  /**
   * 取中文字段，但**容忍三种形态**：
   *   1. {zh:'…'}          —— 正常情况
   *   2. {en:'…'}          —— 模型偶尔不填 zh，内容全在 en。
   *      这时直接回落 en：输出成英文虽然不完美，
   *      但远好过整个中文提示词空白 —— 用户能拿到内容再自行调整。
   *   3. '…'（纯字符串）    —— 自定义提示词下模型常直接返回字符串，
   *      不套对象外壳。
   */
  const f = (k) => {
    const v = fields[k];
    if (typeof v === 'string') return stripTail(v);
    return stripTail(v?.zh) || stripTail(v?.en);
  };

  const seg = [
    f('subject'),
    f('setting'),
    f('action'),
    f('lighting'),
    f('style'),
    f('quality'),
  ].filter(Boolean);

  // 自定义提示词的兜底：六个固定字段可能全空
  //
  // 用户用自定义提示词时，模型不会按内置 schema 填subject/setting 这类
  // 字段名，返回的往往是一整段自由描述，或填进了 composition。
  // 英文那条路径（renderNanoBanana）本来就有 composition 兜底，
  // 中文这条之前没有 —— 于是英文能出内容、中文全空。
  // 两侧兜底逻辑必须一致，否则用户会以为只有中文坏了。
  if (!seg.length) {
    for (const k of ['composition', 'description', 'prompt', 'text']) {
      const v = fields[k];
      const s = typeof v === 'string' ? stripTail(v) : stripTail(v?.zh) || stripTail(v?.en);
      if (s) { seg.push(s); break; }
    }
  }

  // 同理：比例认不出来就不要往tail 里塞一条
  const tail = ratio ? [`画面比例 ${ratio}`] : [];
  // 同样容忍 zh 缺失 —— 否则中文约束会整条丢掉
  const czh = stripTail(fields.constraints?.zh) || stripTail(fields.constraints?.en);
  if (czh) tail.push(czh);

  const items = fields.text?.items || [];
  const clauses = textClauses(items, 'zh');

  // 「不出现文字水印」必须是有条件的。
  //
  // 原先它无条件追加：模型看到了海报上的字，但那些字填不进任何描述字段，
  // 于是 czh 里查不到「文字水印」，规则触发 —— 提示词一边描述这张图，
  // 一边明确要求「画面不出现文字水印」，指令自相矛盾。
  //
  // 现在只在**确实没有文字**时才补兜底。
  if (!clauses.length && !/文字|水印|文案|字幕/.test(czh)) {
    tail.push('画面不出现文字水印');
  }

  if (!seg.length) {
    return {
      text: '',
      ratio,
      empty: true,
      note: '未能从这张图提取到可用描述，换个清晰度更高的图或换个视觉模型再试。',
    };
  }

  // 有字时明确要求逐字复现；只描述内容而不下"照抄"的指令，
  // 模型会自己编文案
  const textPart = clauses.length
    ? `，画面文字需逐字准确复现：${clauses.join('；')}`
    : '';

  // tail 可能为空（比例未识别 + 没有中文约束 + 没有文字兜底项）。
  // 直接拼 `${...}，${join(tail, '，')}。` 会产出「……，。」这种残句 ——
  // 那个逗号是写死的模板字符，join 空数组救不了它。
  const tailPart = tail.length ? `，${join(tail, '，')}` : '';

  return {
    text: `${join(seg, '，')}${textPart}${tailPart}。`,
    ratio,
    note: ratio
      ? '比例已写入正文；若在 UI 里也有比例参数，二者保持一致即可。'
      : '未识别到标准比例，已省略比例描述。',
  };
}

export const RENDERERS = {
  nanobanana: {
    id: 'nanobanana',
    label: '英文',
    lang: 'en',
    render: renderNanoBanana,
  },
  seedance: {
    id: 'seedance',
    label: '中文',
    lang: 'zh',
    render: renderSeedance,
  },
};