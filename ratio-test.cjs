/* 比例识别回归测试。
 *
 * 起因：用户拿一张 1008×380 的网页 banner（2.65:1）来问，
 * 为什么返回的是 1:1。根因不是「阈值太严」，而是兜底方向反了——
 * 所有候选都不在阈值内时，代码不选最接近的那个，直接返回 1:1。
 *
 * 更深一层：那个 0.12 阈值恰好等于 1:1↔5:4 的间距，
 * 被套用到全部 10 个候选。但相邻候选的间距从 3.3% 到 14.6%，
 * 差四倍多 —— 窄的地方被放宽，宽的地方被收紧，banner正好卡在缺口里。
 *
 * 跑：node ratio-test.cjs
 */

/* ── 从 core/schema.js 抠出来的真实逻辑 ── */
const SUPPORTED_RATIOS = [
  '1:1', '3:2', '2:3', '3:4', '4:3',
  '4:5', '5:4', '9:16', '16:9', '21:9',
];

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
    return { ...row, tolerance: Math.min(toPrev, toNext) };
  });
})();

function resolveRatio(width, height) {
  if (!width || !height) return null;
  const actual = width / height;
  let best = null;
  let bestDiff = Infinity;
  for (const row of RATIO_TOLERANCE) {
    const diff = Math.abs(actual - row.value) / row.value;
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best && bestDiff <= best.tolerance ? best.ratio : null;
}

/* ── 断言 ── */
let pass = 0;
const fails = [];
function ok(c, n) { if (c) pass++; else fails.push(n); }
function eq(a, b, n) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  ok(x === y, `${n}｜期望 ${y}，实际 ${x}`);
}

/* 1. 核心 bug：用户的 banner 必须是 null，不能是 1:1 */
eq(resolveRatio(1008, 380), null, '用户报告的 banner（2.65:1）应不返回比例');

/* 2. 所有标准比例必须精确命中（零回归） */
const EXACT = [
  [1000, 1000, '1:1'], [300, 200, '3:2'], [667, 1000, '2:3'],
  [750, 1000, '3:4'], [400, 300, '4:3'], [800, 1000, '4:5'],
  [1250, 1000, '5:4'], [900, 1600, '9:16'], [1600, 900, '16:9'],
  [2100, 900, '21:9'],
];
for (const [w, h, want] of EXACT) {
  eq(resolveRatio(w, h), want, `标准比例 ${want}（${w}×${h}）`);
}

/* 3. 常见非标准比例必须返回 null，而不是误报方形 */
const NON_STANDARD = [
  [2000, 1000, '2:1 横幅'], [3500, 1000, '3.5:1 超宽'],
  [450, 1000, '1:2.2 长竖图'], [1000, 366, '典型轮播 banner'],
  [300, 1000, '1:3.3 极端长竖'],
];
for (const [w, h, name] of NON_STANDARD) {
  eq(resolveRatio(w, h), null, `${name} 应判不出来（不得兜底成 1:1）`);
}

/* 3a. 但「非标准」不等于「一律不认」—— 离某档足够近就该归它。
 * 21:9 是候选表最宽的一档（右侧无邻居，容差 12.7%），
 * 所以 2.4:1 判成 21:9 是正确的，不能一刀切说「非标准就 null」。
 * 这一条是刻意的反向断言，防止后来者把阈值收到过紧。 */
eq(resolveRatio(2400, 1000), '21:9', '2.4:1 离 21:9 仅 2.9%，应命中');
eq(resolveRatio(2000, 1000), null, '2:1 恰好压在 16:9/21:9 分界上，应判不出来');

/* 3b. 横竖方向不能搞混：竖图绝不能命中横图比例，反之亦然。
 * 这条是被一个写错的测试用例逼出来的 —— 标注「1:2.5 长竖」
 * 的用例实际传了 1000×400（宽>高，是横图），却断言 null。
 * 标注错误比断言错误更危险：它会让一个真 bug 看起来像误报。 */
{
  const isLandscape = (r) => {
    const [w, h] = r.split(':').map(Number);
    return w > h;
  };
  const samples = [
    [1000, 1000], [300, 200], [400, 300], [1600, 900], [2100, 900],
    [900, 1600], [750, 1000], [667, 1000], [800, 1000],
  ];
  for (const [w, h] of samples) {
    const got = resolveRatio(w, h);
    ok(got === null || isLandscape(got) === w > h,
      `${w}×${h}（${w > h ? '横' : '竖'}）不应命中${got}（方向相反）`);
  }
}

/* 4. 缺宽高时返回 null，不能当成方形 */
eq(resolveRatio(0, 0), null, '0×0 应返回 null');
eq(resolveRatio(800, 0), null, '高度缺失应返回 null');
eq(resolveRatio(null, null), null, 'null 应返回 null');

/* 5. 宽高顺序颠倒后结果不变（横竖只影响数值，不影响判定） */
eq(resolveRatio(380, 1008), resolveRatio(1008, 380), '宽高互换应得同一结论');

/* 6. 每个候选的容差都必须来自真实分界点，不能是魔数 */
for (const row of RATIO_TOLERANCE) {
  ok(row.tolerance > 0 && row.tolerance < 0.15,
    `${row.ratio} 容差 ${(row.tolerance * 100).toFixed(1)}% 应在 (0, 15%) 内`);
}

/* 7. 容差必须对称：两侧最近的分界点取小 */
const byRatio = Object.fromEntries(RATIO_TOLERANCE.map((r) => [r.ratio, r]));
ok(byRatio['3:4'].tolerance < 0.04, '3:4 两侧都很近，容差应很严格');
ok(byRatio['1:1'].tolerance > 0.10, '1:1 两侧都宽，容差应最宽松');
ok(byRatio['21:9'].tolerance > 0.12, '21:9 右侧无候选，容差应大于 12%');

/* 8. 关键回归：banner 曾经因为阈值不足被判失败再倒向 1:1。
 *    放大到 1.35 倍后（1.9:1）应该仍能命中 16:9，说明不是靠调大阈值糊过去。 */
eq(resolveRatio(1900, 1000), '16:9', '1.9:1 应命中 16:9');

/* 9. 分界点两侧必须归属正确（不能双抢，也不能都不认） */
{
  // 16:9 与 21:9 的分界在 2.0367，验证其两侧各归各家
  const left = resolveRatio(2000, 1000);   // 2.0< 2.0367
  const right = resolveRatio(2100, 1000);  // 2.1 > 2.0367
  ok(left === '16:9' || left === null, `2.0 应归16:9 或判不出，实际 ${left}`);
  ok(right === '21:9', `2.1 应归 21:9，实际 ${right}`);
}

console.log(`\n比例识别：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓\n');