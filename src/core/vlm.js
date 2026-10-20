import { FIELD_META } from './schema.js';
import { callVision } from './providers.js';

/**
 * 字段层：把一张图变成结构化字段。
 *
 * 关键设计：让模型同时输出 en + zh 两份，避免渲染层再做翻译——
 * 翻译过程会丢失摄影术语（shallow depth of field 翻成「景深很浅」再翻回去就废了）。
 */

export function buildFieldPrompt() {
  const fieldList = FIELD_META.map((f) => `- ${f.key} (${f.label}): ${f.hint}`).join('\n');

  return [
    'You are a prompt extraction engine. Look at the image and report two INDEPENDENT kinds of',
    'information: (1) visual elements — composition, light, material, palette;',
    '(2) written content — every piece of text visible in the image.',
    '',
    'Return ONLY a single valid JSON object. No markdown fence, no explanation, no trailing text.',
    'Use exactly this shape:',
    '{',
    ...FIELD_META.map((f) => `  "${f.key}": { "en": "<English>", "zh": "<中文>" }`),
    '  "constraints": { "en": "<English>", "zh": "<中文>" }',
    '  "text": { "items": [',
    '    { "kind": "text" | "graphic",',
    '      "content": { "en": "<verbatim text>", "zh": "<逐字原文>" },',
    '      "layout":  { "en": "<position / size / colour / weight / alignment>", "zh": "<位置 / 大小 / 颜色 / 字重 / 对齐>" } }',
    '  ] }',
    '}',
    '',
    'WRITTEN CONTENT — report this FIRST and report it ALWAYS:',
    '- Text is CONTENT, never texture. Anything that spells something is content, even when it',
    '  sits inside a decorative frame, label, plaque, sticker or logo.',
    '- Scan the ENTIRE image edge to edge: all four corners, the very top, the very bottom,',
    '  every edge and border. Small marginal text is the most commonly missed — check twice.',
    '- Also read text printed ON objects: book covers, product labels, screens, clothing, signs.',
    '- Give each separate element its OWN entry in "items", ordered top-to-bottom.',
    '  A poster with a headline, a subline, a price and a corner watermark has FOUR entries.',
    '- "kind" decides how to report it:',
    '    "text"     — real words you can read. Transcribe them EXACTLY.',
    '    "graphic"  — a decorative mark, emblem or symbol whose characters cannot be read.',
    '                 Describe its SHAPE, SIZE and POSITION only. Leave "content" empty.',
    '- For "text": "content" MUST be the characters EXACTLY as they appear, in their ORIGINAL',
    '  language. Never translate, never romanize, never correct or complete a word.',
    '  A Chinese headline stays Chinese. An English brand name stays English.',
    '- For "text": no surrounding quotes; keep only the characters.',
    '- For "text": preserve internal line breaks with \\n when the original spans multiple lines.',
    '- If a word is readable but uncertain, transcribe your best reading AND append "(unclear)".',
    '  Never silently drop an element just because it is small or hard to read.',
    '- If the image genuinely contains NO text and NO graphic marks, return "items": [].',
    '- Never describe written content inside "constraints" — that field is only for what is ABSENT.',
    '',
    'VISUAL FIELDS:',
    fieldList,
    '- constraints: what is visibly ABSENT or should be avoided (empty string if nothing notable)',
    '',
    'Rules for the visual fields:',
    '- "en": natural English prose with real photography vocabulary (e.g. shallow depth of field, rim light, 85mm lens).',
    '- "zh": natural Chinese sentences using native photography terms (e.g. 浅景深, 侧逆光, 85mm 镜头). Write full sentences, do NOT stack comma-separated tags.',
    '- Describe ONLY what is visible. Do not invent story, brand names, or off-frame elements.',
    '- If a field is genuinely not determinable, return empty strings for both languages.',
    '- Keep each field under 40 words.',
  ].join('\n');
}

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ...Object.fromEntries(
      FIELD_META.map((f) => [
        f.key,
        {
          type: 'object',
          properties: { en: { type: 'string' }, zh: { type: 'string' } },
          required: ['en', 'zh'],
        },
      ])
    ),
    constraints: {
      type: 'object',
      properties: { en: { type: 'string' }, zh: { type: 'string' } },
      required: ['en', 'zh'],
    },
    // text 不是必填：多数摄影图无文字，强制要求会拖累模型输出
    text: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['text', 'graphic'] },
              content: {
                type: 'object',
                properties: { en: { type: 'string' }, zh: { type: 'string' } },
                // 不 required：kind='graphic' 时 content 必须为空
                required: ['en', 'zh'],
              },
              layout: {
                type: 'object',
                properties: { en: { type: 'string' }, zh: { type: 'string' } },
                required: ['en', 'zh'],
              },
            },
            required: ['kind', 'content', 'layout'],
          },
        },
      },
      required: ['items'],
    },
  },
  required: [...FIELD_META.map((f) => f.key), 'constraints'],
};

/**
 * @param {object} cfg 透传给 callVision，另需 imageBase64 / mimeType
 * @param {string} [customPrompt] 用户自定义提示词。给了就用它，
 *   且**不下发 schema** —— 否则 Gemini 的结构化输出约束会压制
 *   用户的自由指令，让他写的东西不起作用。
 * @returns {Promise<object>} 原始字段对象（未 normalize）
 */
/**
 * 判断模型是不是什么都没说。
 *
 * 背景：自定义提示词时我们关掉了 JSON 强制，但模型仍可能返回
 * `{}` / `{"en":"","zh":""}` 这类空壳 —— 此时所有字段为空，
 * 界面只显示「未命名图片」，看起来像插件坏了。
 */
function isEmptyResult(fields) {
  if (!fields || typeof fields !== 'object') return true;
  const keys = Object.keys(fields);
  if (!keys.length) return true;
  // 全部字段都为空串 / 空数组，也算没内容
  return keys.every((k) => {
    const v = fields[k];
    if (v == null) return true;
    if (typeof v === 'string') return !v.trim();
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') {
      // {en,zh} 形态
      const vals = Object.values(v);
      if (!vals.length) return true;
      return vals.every((x) => (typeof x === 'string' ? !x.trim() : x == null));
    }
    return false;
  });
}

export async function reverseToFields(cfg, customPrompt) {
  const custom = String(customPrompt || '').trim();
  const fields = await callVision({
    ...cfg,
    prompt: custom || buildFieldPrompt(),
    // 自定义提示词时不给 schema：约束格式正是「完全自由」要放开的东西。
    // schema 为 null 时 providers.js 也不会强制 JSON 输出。
    schema: custom ? null : RESPONSE_SCHEMA,
  });

  if (custom && isEmptyResult(fields)) {
    // 不抛错 —— 用户只是还没把提示词写好，界面给出提示比报错更有用
    console.warn('[拾光] 自定义提示词未产出任何内容');
    return { ...fields, __empty: true };
  }
  return fields;
}