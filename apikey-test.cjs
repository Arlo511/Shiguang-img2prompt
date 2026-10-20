/**
 * API Key 保存逻辑测试
 *
 * 背景（真实 bug）：保存成功后代码会把输入框清空（`$('apiKey').value = ''`，
 * 避免明文密钥留在界面上）。而原来的判断是
 *
 *     if (typed) keys[provider] = typed;
 *     else if (keys[provider]) delete keys[provider];   // 空值 = 清除
 *
 * 于是第二次点保存时，输入框因为上一步被清空而是空的，
 * 且该provider 确实已配置 → 被当成「用户想清除」→ 刚存的 key 被自己删掉。
 * 用户看到的现象是「保存一次就没了」。
 *
 * 修法：引入 keyTouched 标记，区分「没碰过的空」与「用户主动清空」。
 * 本测试把这三种状态跑一遍，防止回归。
 */

// ── 被测逻辑（与 popup.js 中的实现保持一致）─────────────────────
function makeSaveState(storageKeys, provider, fieldValue, keyTouched) {
  const keys = { ...storageKeys };
  const typed = String(fieldValue || '').trim();
  let cleared = false;

  if (typed) keys[provider] = typed;
  else if (keyTouched) { delete keys[provider]; cleared = true; }

  return { keys, cleared, msg: cleared ? 'cleared' : typed ? 'saved' : 'noop' };
}

// ── 断言 ────────────────────────────────────────────────────────
const t = [];
const eq = (name, actual, expected) =>
  t.push([name, JSON.stringify(actual) === JSON.stringify(expected),
          `期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`]);

// 场景 1：首次填入并保存
eq('首次保存写入 key',
  makeSaveState({}, 'agnes', 'sk-abc', false).keys,
  { agnes: 'sk-abc' });

// 场景 2（核心回归）：保存后输入框被代码清空，再次保存 —— key 必须还在
{
  const first = makeSaveState({}, 'agnes', 'sk-abc', false);
  eq('  · 第一次后 storage', first.keys, { agnes: 'sk-abc' });

  // 代码主动清空输入框，keyTouched 随之重置
  const second = makeSaveState(first.keys, 'agnes', '', false);
  eq('二次保存不清除 key', second.keys, { agnes: 'sk-abc' });
  eq('  · 二次保存无操作', second.msg, 'noop');
}

// 场景 3：连点三次也不能丢
{
  let keys = {};
  let touched = false;
  for (let i = 0; i < 3; i++) {
    const r = makeSaveState(keys, 'agnes', i === 0 ? 'sk-abc' : '', touched);
    keys = r.keys;
    touched = false; // 每次保存后重置
  }
  eq('连续保存三次仍保留', keys, { agnes: 'sk-abc' });
}

// 场景 4：用户主动清空 → 确实清除
{
  const r = makeSaveState({ agnes: 'sk-abc' }, 'agnes', '', true);
  eq('主动清空会删除 key', r.keys, {});
  eq('  · 提示为已清除', r.msg, 'cleared');
}

// 场景 5：清空后又在同一框里填了新key → 应写入而非清除
{
  const r = makeSaveState({ agnes: 'sk-old' }, 'agnes', 'sk-new', true);
  eq('覆盖为新 key', r.keys, { agnes: 'sk-new' });
}

// 场景 6：多服务商互不影响
{
  let keys = {};
  keys = makeSaveState(keys, 'agnes', 'k1', false).keys;
  keys = makeSaveState(keys, 'deepseek', 'k2', false).keys;
  eq('两个服务商都在', keys, { agnes: 'k1', deepseek: 'k2' });

  // 切到已配置的服务商，输入框是空的且没碰过→ 不能删
  keys = makeSaveState(keys, 'agnes', '', false).keys;
  eq('切服务商后保存不影响 key', keys, { agnes: 'k1', deepseek: 'k2' });

  // 切到未配置的服务商 → 无事发生
  keys = makeSaveState(keys, 'gemini', '', false).keys;
  eq('未配置服务商不受影响', keys, { agnes: 'k1', deepseek: 'k2' });
}

// 场景 7：只含空格的输入算作「没填」
eq('纯空格视为空且未碰过→ 保留',
  makeSaveState({ agnes: 'k' }, 'agnes', '   ', false).keys,
  { agnes: 'k' });

// 场景 8：从未配置过 + 空输入 = 什么都不做（不能凭空写 undefined）
eq('未配置且空输入不写入',
  makeSaveState({}, 'agnes', '', false).keys,
  {});
eq('  · 且不是清除', makeSaveState({}, 'agnes', '', false).msg, 'noop');

const bad = t.filter((x) => !x[1]);
bad.forEach((x) => console.log('✗', x[0], x[2]));
console.log(bad.length ? `${bad.length} / ${t.length} 失败` : `全部 ${t.length} 项通过`);
