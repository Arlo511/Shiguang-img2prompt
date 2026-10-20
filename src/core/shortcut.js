/*
 * 快捷键的解析、规范化与匹配。
 *
 * 为什么不预设几个选项让用户下拉选：
 *   1. 封闭枚举表必然漏。用户想按 Ctrl+Alt+V 时表里没有，
 *      content.js 里 `SHORTCUT_MATCHERS[自定义值]` 得到 undefined，
 *      整段监听直接不安装 —— 表现为「设了但完全没反应」，且无任何报错。
 *   2. 预设里的 Ctrl+Shift+V 本身是坏的。Chrome 把它绑定为
 *      「粘贴为纯文本」，paste 事件的 clipboardData 里不含图片，
 *      按它永远取不到图。所以它不该是默认值。
 *   3. 快捷键是个人习惯。用户按什么顺手就用什么，不该被下拉框限制。
 *
 * 存储格式：规范化的字符串，如 'Ctrl+Shift+V' / 'Alt+V' / 'Ctrl+K'。
 * 不用对象是因为 storage 面板里直接可读，也便于跨版本比对。
 */

/** 修饰键的固定书写顺序，保证同一组合只有一种字符串表示 */
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

/**
 * 把 KeyboardEvent 里的键名归一。
 *
 * e.key 对字母键返回小写（按住 Shift 时是大写），对功能键返回 'F2'。
 * 两种形态都归到「字母统一大写、非字母原样」，这样 Ctrl+V 和
 * Ctrl+Shift+V 在键这一维上能区分开（Shift 进了 mods，键仍是 V）。
 */
function normalizeKey(key) {
  const k = String(key || '');
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/**
 * 从 KeyboardEvent 生成规范化字符串，例如 'Ctrl+Shift+V'。
 *
 * @param {KeyboardEvent} e
 * @returns {string} 规范化后的快捷键；无有效键时返回空串
 */
export function fromEvent(e) {
  const key = normalizeKey(e.key);
  if (!key || ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return '';

  const flags = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey };
  const mods = MOD_ORDER.filter((m) => flags[m]);

  return [...mods, key].join('+');
}

/**
 * 解析规范化字符串为匹配器可用的结构。
 *
 * @param {string} s
 * @returns {{ctrl:boolean,alt:boolean,shift:boolean,meta:boolean,key:string}|null}
 */
export function parse(s) {
  const str = String(s || '').trim();
  if (!str || str.toLowerCase() === 'none') return null;

  const parts = str.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const key = parts.pop();
  const set = new Set(parts.map((p) => p.toLowerCase()));

  return {
    ctrl: set.has('ctrl') || set.has('control'),
    alt: set.has('alt') || set.has('option'),
    shift: set.has('shift'),
    meta: set.has('meta') || set.has('cmd') || set.has('command'),
    key: normalizeKey(key),
  };
}

/**
 * 判断事件是否命中该快捷键。
 *
 * 用严格相等比较四个修饰位，而不是「包含」——否则 Ctrl+V 会被
 * Ctrl+Shift+V 误命中，两种设置就分不出彼此了。
 *
 * @param {KeyboardEvent} e
 * @param {string} s 规范化字符串
 */
export function matches(e, s) {
  const sc = parse(s);
  if (!sc) return false;
  return (
    e.ctrlKey === sc.ctrl &&
    e.altKey === sc.alt &&
    e.shiftKey === sc.shift &&
    e.metaKey === sc.meta &&
    normalizeKey(e.key) === sc.key
  );
}

/**
 * 一个组合键是否值得接受。
 *
 * 排除两类：
 *   - 没有任何修饰键的单个字符（用户会误触，而且会劫持网页的字母快捷键）
 *   - 纯功能键以外、只有 Shift 的组合（Shift+字母是网页常用的选区操作）
 * 保留 F1~F12 这类无修饰功能键，它们不会和网页冲突。
 */
export function isAcceptable(s) {
  const sc = parse(s);
  if (!sc) return false;
  const isFunc = /^F\d{1,2}$/.test(sc.key);

  // 功能键单独放行：F1~F12 基本不和网页冲突，用户按 F2 就是想用 F2
  if (isFunc && !sc.ctrl && !sc.alt && !sc.meta && !sc.shift) return true;

  // 其余情况必须至少带一个修饰键，否则会劫持网页的字母快捷键
  if (!sc.ctrl && !sc.alt && !sc.meta && !sc.shift) return false;
  // 纯 Shift+字母是网页常用的选区操作（Shift+左右方向键等），一并排除
  if (!sc.ctrl && !sc.alt && !sc.meta && sc.shift && !isFunc) return false;
  return true;
}

/** 人类可读的显示形式。已是规范串，直接原样返回即可 */
export function display(s) {
  const sc = parse(s);
  if (!sc) return '';
  return [...MOD_ORDER.filter((m) => sc[m.toLowerCase()]), sc.key].join(' + ');
}

/** 是否是已被占用的高风险组合，给录制界面做提示 */
export function isRisky(s) {
  const sc = parse(s);
  if (!sc) return false;
  // Ctrl+W / Ctrl+T / Ctrl+N 等被浏览器占用，页面里收不到
  const browserKeys = new Set(['W', 'T', 'N', 'L', 'D', 'Q']);
  if (sc.ctrl && !sc.shift && !sc.alt && browserKeys.has(sc.key)) return true;
  // 无修饰的 F5 是刷新，F12 是开发者工具
  if (!sc.ctrl && !sc.alt && !sc.meta && !sc.shift && /^(F5|F11|F12)$/.test(sc.key)) return true;
  return false;
}
