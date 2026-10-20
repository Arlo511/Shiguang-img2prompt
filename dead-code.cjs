/* 死代码扫描：找出「导出了但从没被用」的符号。
 *
 * 与 check-undef.cjs 的区别：那个检查器用单行正则匹配 import，
 * 抓不到多行解构导入，于是把几百个正常符号报成未定义 ——
 * 误报比不检查更危险，会让人以为代码有问题而浪费时间。
 * 这个文件只报**有把握**的结论：导出了但零引用。
 *
 * 跑：node dead-code.cjs
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(js|css|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const contents = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

const suspects = [];

for (const [file, src] of contents) {
  if (!file.endsWith('.js')) continue;

  // 抓 export function / export const
  const decls = [
    ...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g),
    ...src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g),
    ...src.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*=/g),
  ];

  for (const m of decls) {
    const name = m[1];
    const rel = path.relative(__dirname, file);

    // 本文件内部引用不算死代码 —— 比如 RENDERERS 表引用 renderNanoBanana，
    // listPresets 引用 BUILTIN_PRESET。这些是「导出但同文件自用」。
    const afterDecl = src.slice(m.index + m[0].length);
    const selfUses = (
      afterDecl.match(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g')) || []
    ).length;
    if (selfUses > 0) continue;

    // 在本文件之外的所有文件里统计 import 引用
    let refs = 0;
    for (const [other, osrc] of contents) {
      if (other === file) continue;
      const hits = osrc.match(
        new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, 'g')
      );
      if (hits) refs += hits.length;
    }
    if (refs === 0) suspects.push({ rel, name, kind: m[0].slice(0, 16) });
  }
}

if (!suspects.length) {
  console.log('\n✓ 没有「导出但零引用」的符号');
} else {
  console.log(`\n以下 ${suspects.length} 个导出在任何其他文件里都没被 import：`);
  for (const s of suspects) {
    console.log(`  ${s.rel.padEnd(24)} ${s.name}`);
  }
  console.log('\n注意：可能是动态 import、字符串引用，或确实该删。逐个 grep 确认后再动。');
}