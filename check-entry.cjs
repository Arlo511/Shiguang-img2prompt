/**
 * 入口完整性检查。
 *
 * 这次出过一次真实故障：popup.js 末尾的 `boot();` 调用被误删
 * （它和「包装 boot」那段代码在同一个编辑块里，删除时一起没了）。
 * 后果是**整个模块加载后什么都不执行** ——
 * 保存设置失效、触发方式不生效、提示词方案下拉框为空。
 *
 * 三个症状完全不同的功能同时失效，指向同一个根因时，
 * 一定要去查「这个文件的入口到底有没有被调用」。
 * 静态语法检查（node --check）**查不出这类问题**：
 * 一个只有定义没有调用的文件，语法完全合法。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

/** 每个入口脚本必须有对应调用的一对 */
const ENTRIES = [
  { file: 'src/popup/popup.js', entry: 'boot' },
  { file: 'src/panel/panel.js', entry: 'boot' },
];

let bad = 0;

for (const { file, entry } of ENTRIES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    console.log('✗ 文件不存在:', file);
    bad++;
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');

  // 是否有定义
  const defined = new RegExp(`(?:async\\s+)?function\\s+${entry}\\s*\\(`).test(src);

  // 是否有调用：行首出现 entry()（允许分号/空白），排除定义行本身
  const lines = src.split(/\r?\n/);
  let called = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (t.startsWith('function ')) continue;              // 定义
    if (new RegExp(`^${entry}\\s*\\(\\s*\\)\\s*;?$`).test(t)) { called = true; break; }
    if (new RegExp(`^(void\\s+)?${entry}\\s*\\(\\s*\\)\\s*;?`).test(t)) { called = true; break; }
  }

  // 有定义没调用 = 静默失效
  if (!defined) {
    console.log(`✗ ${file}: 未找到 ${entry}() 的定义`);
    bad++;
  } else if (!called) {
    console.log(`✗ ${file}: 定义了 ${entry}() 但从未调用 —— 整个脚本不会执行`);
    bad++;
  } else {
    console.log(`✓ ${file}: ${entry}() 已定义且被调用`);
  }
}

// popup/open-panel.js 是零依赖的独立入口，同样要确认被引用
const openPanel = path.join(ROOT, 'src/popup/open-panel.js');
if (fs.existsSync(openPanel)) {
  const popupHtml = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
  console.log(
    popupHtml.includes('open-panel.js')
      ? '✓ popup.html 已引入 open-panel.js'
      : '✗ popup.html 未引入 open-panel.js —— 打开面板按钮会失效'
  );
}

if (bad) {
  console.log('\n✗ 入口不完整，修复后再测试');
  process.exit(1);
}
console.log('\n✓ 入口完整');
