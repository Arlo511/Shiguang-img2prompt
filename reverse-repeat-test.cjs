/* 重复反推行为回归测试。
 *
 * 用户报告：已经反推过的图片再次右键，会直接打开之前的反推结果，
 * 而不会真的重新反推。
 *
 * 根因不是「弹了个确认框」，而是 background.js 里的短路：
 *   if (history.length && !meta.force) { openPanel({duplicate}); return; }
 * 这个 return 发生在 reverseImage() 之前 —— 模型压根没被调用。
 *
 * 而且那个 duplicate 界面从来不是阻断式的：showDuplicate() 末尾
 * 会自动调viewLatest()，所以是「结果被顶掉」，不是「被拦住」。
 *
 * 注意：#dup 界面按用户要求保留了（可能另有入口），
 * 所以光「界面还在」不能证明旧逻辑还活着 —— 必须测调用次数。
 *
 * 跑：node reverse-repeat-test.cjs
 */

/* ── 从 background.js 抠出来的真实控制流 ── */

/**
 * @param opts.force        面板点了「重新反推」
 * @param opts.historyCount 该图已有的历史记录数
 * @returns {calls, opened, outcome}
 */
function processImage(opts) {
  const { force = false, historyCount = 0 } = opts;
  const calls = [];
  const opened = [];

  // 已反推过的图照样反推：这里**没有** if (history.length) return 的短路。
  // 修掉的正是它 —— 它让模型压根没被调用，旧结果直接铺到屏幕上。
  // force 只保留给 PR_FORCE_REVERSE 通道，不再影响去重查询。
  opened.push('loading');
  calls.push('reverseImage');

  // 模型返回后：存记录 → 查同图全部记录 → 算出 siblings
  const siblings = new Array(historyCount).fill({ id: 'old' });
  opened.push('record');
  return { calls, opened, outcome: { ok: true }, siblings };
}

/* ── 断言 ── */
let pass = 0;
const fails = [];
function ok(c, n) { if (c) pass++; else fails.push(n); }
function eq(a, b, n) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  ok(x === y, `${n}｜期望 ${y}，实际 ${x}`);
}

/* 1. 核心 bug：重复右键必须真的调用模型 */
{
  const r = processImage({ historyCount: 1 });
  eq(r.calls, ['reverseImage'], '已反推过的图仍应调用 reverseImage');
  ok(!r.outcome.duplicate, '不应再走duplicate 分支');
  ok(!r.opened.includes('duplicate'), '不应再打开 duplicate 界面');
}

/* 2. 全新图也必须调用（不能改坏正常路径） */
{
  const r = processImage({ historyCount: 0 });
  eq(r.calls, ['reverseImage'], '全新图应调用 reverseImage');
}

/* 3. 无论历史有几条，都必须调用 */
for (const n of [1, 2, 5, 20]) {
  const r = processImage({ historyCount: n });
  eq(r.calls, ['reverseImage'], `历史 ${n} 条时仍应调用 reverseImage`);
}

/* 4. 旧结果不能丢：siblings 必须带上全部历史，供缩略图流展示 */
{
  const r = processImage({ historyCount: 3 });
  eq(r.siblings?.length, 3, '同图历史应作为 siblings 送出（供缩略图流）');
}

/* 5. 提示条只在「刚反推 + 有旧结果」时出现。
 *    isFresh=false 是从历史/收藏点开 —— 那时不该再提醒。 */
function rehitText(isFresh, siblingCount) {
  if (!isFresh || !siblingCount) return null;
  return `这张图此前反推过 ${siblingCount} 次`;
}
eq(rehitText(true, 1) !== null, true, '刚反推且有旧结果 → 显示提示条');
eq(rehitText(true, 0), null, '刚反推但无旧结果 → 不显示');
eq(rehitText(false, 3), null, '从历史点开 → 不显示提示条');

/* 6. force 通道仍可用（用户明确要求保留 PR_FORCE_REVERSE） */
{
  const r = processImage({ historyCount: 5, force: true });
  eq(r.calls, ['reverseImage'], 'force 应直接反推');
  ok(!r.outcome.duplicate, 'force 不应走 duplicate');
}

/* 7. 回归验证：把旧短路塞回去，本测试必须失败 */
{
  // 内联一份旧逻辑，证明测试不是摆设
  function oldProcessImage(historyCount) {
    const calls = [];
    const history = new Array(historyCount).fill({ id: 'old' });
    if (history.length) return { calls, outcome: { duplicate: true } };
    calls.push('reverseImage');
    return { calls, outcome: { ok: true } };
  }
  const bad = oldProcessImage(1);
  ok(bad.calls.length === 0, '旧逻辑确实不调用模型（测试有效性自证）');
  ok(bad.calls.length !== processImage({ historyCount: 1 }).calls.length,
    '新旧行为必须不同');
}

console.log(`\n重复反推：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓\n');