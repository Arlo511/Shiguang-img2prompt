/* 折叠状态回归测试。
 *
 * 这个 bug 的形态很典型：三条各自看着都合理的逻辑叠在一起，
 * 结果「取消勾选后还是展开」。三条都得在测试里覆盖，
 * 少一条就等于留了个后门。
 *
 * 跑：node fold-test.cjs
 */

/* ── 从 panel.js 抠出来的真实逻辑（保持一致，改一处两边都要改）── */

function makePanel() {
  return {
    folds: { favorites: false, history: false }, // <details>.open
    foldStateApplied: false,
    favOpen: false,
    histOpen: false,
  };
}

function applyFoldDefaults(panel, favOpen, histOpen, force = false) {
  panel.favOpen = favOpen;
  panel.histOpen = histOpen;
  if (panel.foldStateApplied && !force) return;
  panel.foldStateApplied = true;
  panel.folds.favorites = favOpen;
  panel.folds.history = histOpen;
}

/** 模拟面板开着时用户在设置页改了勾选 */
function onSettingsChanged(panel, changes) {
  let favOpen = panel.favOpen;
  let histOpen = panel.histOpen;
  if (changes.favOpen !== undefined) favOpen = changes.favOpen === true;
  if (changes.histOpen !== undefined) histOpen = changes.histOpen === true;
  panel.favOpen = favOpen;
  panel.histOpen = histOpen;
  applyFoldDefaults(panel, favOpen, histOpen, true);
}

/** 点开历史详情：历史区收起，并把「原本是否展开」记进现场 */
function openDetail(panel) {
  const historyWasOpen = panel.folds.history;
  panel.folds.history = false;
  return { historyWasOpen };
}

/** 点返回：原样还原展开状态 */
function back(panel, prev) {
  if (prev && prev.historyWasOpen) panel.folds.history = true;
}

/* ── 断言 ── */

let pass = 0;
const fails = [];

function ok(cond, name) {
  if (cond) pass++;
  else fails.push(name);
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${name}｜期望 ${e}，实际 ${a}`);
}

/* 1. 两个都没勾选 → 折叠 */
{
  const p = makePanel();
  applyFoldDefaults(p, false, false);
  eq([p.folds.favorites, p.folds.history], [false, false], '未勾选时两者都应折叠');
}

/* 2. 只勾收藏 */
{
  const p = makePanel();
  applyFoldDefaults(p, true, false);
  eq([p.folds.favorites, p.folds.history], [true, false], '只勾收藏时历史应保持折叠');
}

/* 3. 只勾历史 */
{
  const p = makePanel();
  applyFoldDefaults(p, false, true);
  eq([p.folds.favorites, p.folds.history], [false, true], '只勾历史时收藏应保持折叠');
}

/* 4. 核心回归：用户手动展开过，取消勾选后必须收回去。
 *    这是用户报告的那个现象 —— 面板窗口复用，boot 不重跑，
 *    没有 force 就等于设置改了永远不生效。 */
{
  const p = makePanel();
  applyFoldDefaults(p, true, true);
  // 用户在面板里手动点开了（模拟残留的展开状态）
  p.folds.favorites = true;
  p.folds.history = true;
  // 设置页取消勾选 → storage.onChanged 触发
  onSettingsChanged(p, { favOpen: false, histOpen: false });
  eq([p.folds.favorites, p.folds.history], [false, false], '取消勾选后应强制收起');
}

/* 5. 取消勾选后，再点开历史详情又返回，不该把它撑开 */
{
  const p = makePanel();
  applyFoldDefaults(p, false, false);
  const prev = openDetail(p);
  back(p, prev);
  eq(p.folds.history, false, '默认折叠时看历史再返回，历史应仍折叠');
}

/* 6. 默认展开时，看历史再返回要还原成展开（不能把用户的展开状态吃掉） */
{
  const p = makePanel();
  applyFoldDefaults(p, false, true);
  const prev = openDetail(p);
  eq(p.folds.history, false, '点开详情时历史应收起');
  back(p, prev);
  eq(p.folds.history, true, '返回时应还原为展开');
}

/* 7. 用户手动操作优先于设置：闸门必须挡住重复覆盖 */
{
  const p = makePanel();
  applyFoldDefaults(p, true, true);
  p.folds.history = false; // 用户手动收起
  applyFoldDefaults(p, true, true); // 再来一次（不该生效）
  eq(p.folds.history, false, '手动收起后不该被重绘覆盖回去');
}

/* 8. 只改一个键，另一个不动 */
{
  const p = makePanel();
  applyFoldDefaults(p, false, true);
  onSettingsChanged(p, { favOpen: true });
  eq([p.folds.favorites, p.folds.history], [true, true], '只改收藏时历史应保持原状态');
}

/* 9. 没有 prev（直接返回按钮，如从收藏进入）时不该乱展开 */
{
  const p = makePanel();
  applyFoldDefaults(p, false, false);
  back(p, null);
  eq(p.folds.history, false, '无现场记录时返回不该展开历史');
}

/* ── 结果 ── */
console.log(`\n折叠状态：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓\n');
