/**
 * 反推提示词方案：多套可切换、可编辑。
 *
 * 设计取舍：用户选了「真正完全自由」—— 可以重写整段提示词。
 * 代价是模型返回格式不再可控，所以由 extractJson 做自由文本兜底
 * （塞进 composition）。这里负责存储与切换，不管渲染。
 *
 * 默认方案不可删除：它是恢复出厂状态的锚点，也是新手用户
 * 唯一能看懂「这东西该怎么写」的样板。删掉之后如果用户把
 * 自定义提示词改坏了，就没有任何退路。
 */

const KEY = 'promptPresets';
const ACTIVE_KEY = 'promptActiveId';
const BUILTIN_ID = 'builtin';

/** 内置默认方案 —— 与改造前的提示词逐字一致，保证行为不变 */
export const BUILTIN_PRESET = {
  id: BUILTIN_ID,
  name: '默认',
  builtin: true,
  // 内置方案的正文由 buildFieldPrompt() 生成，不入库：
  // 存一份快照会与代码里的版本漂移，改代码后用户看到的还是旧的。
  // builtin:true 表示「正文实时取 buildFieldPrompt()」。
  body: '',
};

/** 读取全部方案（内置永远在第一位） */
export async function listPresets() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const custom = Array.from(got[KEY] || []).filter((p) => p && p.id && !p.builtin);
    return [{ ...BUILTIN_PRESET }, ...custom];
  } catch (e) {
    console.warn('[拾光] 读取提示词方案失败，回落到默认', e);
    return [{ ...BUILTIN_PRESET }];
  }
}

export async function savePreset(preset) {
  const all = await listPresets();
  const custom = all.filter((p) => !p.builtin);
  const idx = custom.findIndex((p) => p.id === preset.id);

  const clean = {
    id: preset.id,
    name: String(preset.name || '').trim() || '未命名',
    builtin: false,
    body: String(preset.body || ''),
  };

  if (idx >= 0) custom[idx] = clean;
  else custom.push(clean);

  await chrome.storage.local.set({ [KEY]: custom });
  return clean;
}

export async function deletePreset(id) {
  if (id === BUILTIN_ID) return false; // 内置不可删
  const all = await listPresets();
  const custom = all.filter((p) => !p.builtin && p.id !== id);
  await chrome.storage.local.set({ [KEY]: custom });

  // 删掉的正好是当前激活的，回落到内置
  const active = await getActiveId();
  if (active === id) await setActiveId(BUILTIN_ID);
  return true;
}

export async function getActiveId() {
  try {
    const got = await chrome.storage.local.get(ACTIVE_KEY);
    return got[ACTIVE_KEY] || BUILTIN_ID;
  } catch {
    return BUILTIN_ID;
  }
}

export async function setActiveId(id) {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
}

/**
 * 取当前激活方案的正文。
 *
 * 内置方案返回 null —— 调用方据此决定「用 buildFieldPrompt() 还是用这个」。
 * 返回空字符串也是 null 的含义：用户可能建了一个空方案，
 * 那等同于「还没写」，用默认比用空字符串合理。
 */
export async function getActiveBody() {
  const id = await getActiveId();
  if (id === BUILTIN_ID) return null;
  const all = await listPresets();
  const p = all.find((x) => x.id === id);
  if (!p || !String(p.body || '').trim()) return null;
  return p.body;
}

/**
 * 内置方案的正文快照，供设置页「以此为基础修改」用。
 *
 * 内置本体不存快照（会与代码漂移），但用户要编辑时总得看见当前内容，
 * 所以这里按需实时生成一份展示副本。
 */
export async function getBuiltinBody() {
  const { buildFieldPrompt } = await import('./vlm.js');
  return buildFieldPrompt();
}

/**
 * 给自定义提示词补上双语输出骨架。
 *
 * 问题：内置提示词靠 JSON 示例结构要求了 en + zh 双份，
 * 所以默认方案返回的中文是**真翻译过的**。自定义提示词通常只写
 * 「描述这张图」，既没说语言也没给结构 —— 模型于是按训练语料的
 * 默认倾向输出一段英文，中文栏就废了。
 *
 * 做法：不给「骨架」不给「骨架」—— 用**结构示例**而不是**追加请求**。
 * 之前只追加了一句「Return BOTH English and Chinese」，
 * 那仍是一句请求，模型可能无视（实测就会）。
 * 给出 JSON 骨架等于告诉它「输出长这样」，格式要求比措辞要求更硬。
 *
 * 三点设计：
 * 1. 骨架放**前面**：先定义输出格式，再讲自定义要求 ——
 *    反过来会让模型先按自由文本写，最后再补格式。
 * 2. 用户的自定义内容**原样保留**在骨架之后，不加任何修饰。
 *    真正的自由是「描述什么」，输出格式属于契约，不该被剥夺。
 * 3. 字段名沿用 FIELD_META 那套（subject/setting/…），
 *    这样渲染层读到的 key 与默认方案完全一致。
 */
export function withLanguageHint(prompt) {
  const body = String(prompt || '').trim();
  if (!body) return body;
  return [
    'Analyse the image and fill in this JSON structure.',
    'Every text field MUST contain BOTH an English and a Chinese version:',
    '"zh" must be a genuine Chinese translation, not a copy of "en".',
    '',
    '{',
    '  "subject":      { "en": "<主体>", "zh": "<主体>" },',
    '  "action":       { "en": "<动作>", "zh": "<动作>" },',
    '  "setting":      { "en": "<环境>", "zh": "<环境>" },',
    '  "lighting":     { "en": "<光线>", "zh": "<光线>" },',
    '  "composition":  { "en": "<构图>", "zh": "<构图>" },',
    '  "style":        { "en": "<风格>", "zh": "<风格>" },',
    '  "quality":      { "en": "<画质>", "zh": "<画质>" },',
    '  "constraints":  { "en": "<限制>", "zh": "<限制>" },',
    '  "text": { "items": [',
    '    { "kind": "text" | "graphic",',
    '      "content": { "en": "<verbatim>", "zh": "<逐字原文>" },',
    '      "layout":  { "en": "<位置/大小/颜色>", "zh": "<位置/大小/颜色>" } }',
    '  ] }',
    '}',
    '',
    'Return ONLY that JSON. No explanation, no code fence.',
    '',
    '=== Your instructions ===',
    body,
  ].join('\n');
}

export function newPresetId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
