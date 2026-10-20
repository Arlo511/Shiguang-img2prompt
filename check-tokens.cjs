/**
 * 设计令牌体检。
 *
 * 改完 CSS 必跑：令牌体系最大的风险不是写错值，而是
 *   1. 用了没定义的变量 → 该属性失效回落成黑/透明
 *   2. 又出现新的硬编码色 → 令牌体系被绕过，下次换主色又要逐处改
 *   3. 圆角/字号重新散落 → 同类控件外观不一致，就是「拼装感」的来源
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const tokens = fs.readFileSync(path.join(ROOT, 'src/tokens.css'), 'utf8');

function check(file) {
  const s = fs.readFileSync(file, 'utf8');
  const defs = new Set(
    [...tokens.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1])
  );
  [...s.matchAll(/--([a-z0-9-]+)\s*:/g)].forEach((m) => defs.add(m[1]));

  const used = new Set([...s.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !defs.has(u));

  // 硬编码色：跳过 :root 令牌定义块内的（那里本就该写字面值）
  const body = s.replace(/:root\s*\{[^}]*\}/gs, '').replace(/@media[^{]*\{[^}]*\}/gs, '');
  const hex = [...new Set(body.match(/#[0-9a-fA-F]{3,8}/g) || [])];

  // rgba 形式同样要查：上一轮只扫十六进制，
  // 结果漏掉了 rgba(217,119,87,...) 形式的品牌色光带
  const rgba = [...new Set(body.match(/rgba?\([^)]+\)/g) || [])].filter(
    // 半透明黑遮罩配白字是中性用法（toast /灯箱 /进度条），保留
    (r) => !/^rgba\(0,\s*0,\s*0/.test(r) && !/^rgba\(\s*41,\s*37,\s*36/.test(r)
  );

  const radii = [...new Set(body.match(/border-radius:\s*[0-9]+px/g) || [])];
  const sizes = [...new Set(body.match(/font-size:\s*[0-9]+px/g) || [])];

  console.log('\n' + file);
  console.log('  未定义变量   :', missing.length ? missing.join(', ') : '无');
  console.log('  硬编码色     :', hex.length ? hex.join(' ') : '无');
  console.log('  硬编码 rgba  :', rgba.length ? rgba.join(' ') : '无');
  console.log('  字面圆角     :', radii.length ? radii.join(' ') : '无');
  console.log('  字面字号     :', sizes.length ? sizes.join(' ') : '无');
  return { missing, hex, rgba, radii, sizes };
}

let bad = 0;
for (const f of ['src/panel/panel.html', 'src/popup/popup.html']) {
  const r = check(path.join(ROOT, f));
  if (r.missing.length) bad++;
}

// --brand 是否被定义在暗色块里（否则暗色下品牌色不会变）
const darkBlock = tokens.match(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n\}/);
console.log('\n暗色块包含 --brand :', darkBlock && darkBlock[0].includes('--brand') ? '是' : '否 ✗');
console.log('令牌总数:', [...tokens.matchAll(/^\s*--([a-z0-9-]+)\s*:/gm)].length);

if (bad) {
  console.log('\n✗ 有未定义变量，需修复');
  process.exit(1);
}
console.log('\n✓ 变量引用完整');
