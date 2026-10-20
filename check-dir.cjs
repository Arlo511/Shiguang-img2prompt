/**
 * 扩展目录卫生检查。
 *
 * 为什么必须查：Chrome 拒绝加载含保留前缀（`_` / `._` / `__MACOSX`）文件的扩展目录，
 * 而且是**整包加载失败** —— 不是报某个文件有问题，是直接「无法加载清单」。
 * 一次在扩展目录里建了 `_preview/` 做视觉对照，扩展就再也加载不上了，
 * 报错信息里完全看不出是哪个文件造成的。
 *
 * 预览、临时产物一律放在扩展目录之外。
 *
 * 注意：不要用 `/^[_.]/` 一刀切。`.gitignore`、`.github/` 也是点开头，
 * 但它们是仓库必需品，而 Chrome 根本不看这些 —— 一刀切会让本检查
 * 在任何 git 仓库里都误报，久而久之就没人看它的输出了。
 * 误报比不检查更危险。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// Chrome 真正会拒绝的：单下划线前缀（AppleDouble）、点下划线、双下划线
const RESERVED = [/^_[^_]/, /^\._/, /^__/];

// 点开头的仓库元数据：合法，但不该出现在扩展包的内容里（会白占体积）
const REPO_META = new Set(['.gitignore', '.gitattributes']);

const offenders = [];

function walk(dir, depth = 0) {
  if (depth > 4) return;
  for (const name of fs.readdirSync(dir)) {
    // readdirSync 不会返回 . 和 ..，不需要额外排除
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full);

    if (RESERVED.some((re) => re.test(name))) {
      offenders.push({ rel, kind: '前缀保留名', reason: 'Chrome 会拒绝加载整个扩展目录' });
    }
    // 仓库元数据：提示但不阻塞
    else if (REPO_META.has(name)) {
      console.log(`  · ${rel}（仓库元数据，打包扩展时可以排除）`);
    }
    // 预览类文件即使没有保留前缀，也不该进扩展目录
    if (/preview|screenshot|tmp|debug/i.test(name) && /\.html?$/i.test(name)) {
      offenders.push({ rel, kind: '预览/临时文件', reason: '会被打包进扩展，且不影响功能' });
    }
    if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
  }
}

walk(ROOT);

if (offenders.length) {
  console.log('✗ 扩展目录含不应存在的文件：\n');
  for (const o of offenders) {
    console.log('  ' + o.rel);
    console.log('    ' + o.kind + ' — ' + o.reason);
  }
  console.log('\n移出扩展目录后重新加载。预览请放到目录之外。');
  process.exit(1);
}

// manifest 完整性
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
console.log('✓ 扩展目录无保留前缀文件');
console.log('  name:', mf.name);
console.log('  version:', mf.version);