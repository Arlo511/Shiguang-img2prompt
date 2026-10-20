/* 双向查 DOM id：JS 里用了但 HTML 里不存在 / HTML 里有但 JS 从不碰。
 *
 * 第二类更隐蔽 —— 删代码时留下一个没人用的元素，
 * 它仍会占版面、仍可能被 CSS 命中，通常要到肉眼对不上才发现。
 *
 * 跑：node check-dom.cjs
 */
const fs = require('fs');

const PAIRS = [
  { html: 'src/panel/panel.html', js: ['src/panel/panel.js'] },
  { html: 'src/popup/popup.html', js: ['src/popup/popup.js', 'src/popup/open-panel.js'] },
];

let problems = 0;

for (const { html, js } of PAIRS) {
  const hsrc = fs.readFileSync(html, 'utf8');
  const allJs = js.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  // HTML 里的所有 id
  const htmlIds = new Set();
  for (const m of hsrc.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

  // JS 里 $('xxx') 的用法
  const usedIds = new Set();
  for (const m of allJs.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) usedIds.add(m[1]);
  // document.getElementById 也算
  for (const m of allJs.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) usedIds.add(m[1]);

  // 动态创建的 id：JS 里 createElement 之后赋了 .id =
  // 这类是运行时自举的，HTML 里本来就不该有，检查时要排除。
  const dynamicIds = new Set();
  for (const m of allJs.matchAll(/createElement\([\s\S]{0,200}?\.id\s*=\s*'([^']+)'/g)) {
    dynamicIds.add(m[1]);
  }

  console.log(`\n── ${html}`);
  console.log(`   HTML 元素 id: ${htmlIds.size} 个，JS 引用: ${usedIds.size} 个`);

  const missing = [...usedIds]
    .filter((id) => !htmlIds.has(id) && !dynamicIds.has(id))
    .sort();
  if (missing.length) {
    console.log(`   ✗ JS 引用了但 HTML 不存在（会抛 null 错误）:`);
    missing.forEach((id) => console.log(`       #${id}`));
    problems += missing.length;
  } else {
    const dyn = [...dynamicIds].filter((id) => usedIds.has(id));
    console.log(
      `   ✓ 所有 JS 引用的 id 都存在` +
        (dyn.length ? `（${dyn.join(', ')} 为运行时动态创建）` : '')
    );
  }

  // HTML 有但 JS 不碰的。CSS 可能用，但 id 选择器通常意味着 JS 要用
  const orphans = [...htmlIds].filter((id) => !usedIds.has(id)).sort();
  if (orphans.length) {
    console.log(`   · HTML 里有但 JS 不引用（可能是纯 CSS 目标，确认一下）:`);
    orphans.forEach((id) => console.log(`       #${id}`));
  }
}

console.log(
  problems
    ? `\n发现 ${problems} 个会导致运行时报错的失效引用`
    : `\n✓ 没有失效的 DOM 引用`
);
process.exit(problems ? 1 : 0);