/**
 * 一键验证：跑全部语法检查 + 测试套件 + 静态检查。
 *
 * 为什么需要它：这个项目有 11 个检查脚本，逐个敲容易漏，
 * 而漏掉某个检查恰恰是「以为验证过了其实没验」的来源。
 *
 * 判成败用退出码而不是 grep 输出 ——
 * 之前用 `grep -q "失败"` 判断，把「0 失败」也当成了失败。
 *
 * 跑：node verify-all.cjs
 */
const { execFileSync } = require('child_process');
const path = require('path');

const SYNTAX = [
  'src/background.js',
  'src/content.js',
  'src/panel/panel.js',
  'src/popup/popup.js',
  'src/popup/open-panel.js',
  'src/core/api.js',
  'src/core/naming.js',
  'src/core/presets.js',
  'src/core/providers.js',
  'src/core/renderers.js',
  'src/core/schema.js',
  'src/core/shortcut.js',
  'src/core/store.js',
  'src/core/vlm.js',
];

/** 测试脚本：名字即用途，输出里带「N 通过」 */
const TESTS = [
  ['ratio-test.cjs', '比例识别'],
  ['fold-test.cjs', '折叠状态'],
  ['naming-test.cjs', '命名格式'],
  ['apikey-test.cjs', 'API Key 保存'],
  ['reverse-repeat-test.cjs', '重复反推'],
];

/** 静态检查：只关心退出码，输出是给人看的 */
const CHECKS = [
  ['check-calls.cjs', '顶层调用可解析'],
  ['check-entry.cjs', '入口完整'],
  ['check-dir.cjs', '目录无冗余'],
  ['check-tokens.cjs', '设计令牌一致'],
  ['check-dom.cjs', 'DOM 引用有效'],
  ['dead-code.cjs', '无死代码导出'],
];

const NODE = process.execPath;
let failed = 0;

function run(file, nodeArgs = []) {
  try {
    // 成功时也要把 stdout 带回来 —— 测试脚本的「N 通过」在输出里，
    // 丢了就只剩一个光秃秃的 ✓，看不出这次到底跑了多少项。
    const out = execFileSync(NODE, [...nodeArgs, file], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, out: out || '' };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

console.log('\n═══ 语法检查 ═══');
for (const f of SYNTAX) {
  // --check 必须排在文件名**之前**。写成 ['file','--check'] 时
  // node 会把它当脚本参数、真的去执行该文件，于是报
  // "ReferenceError: chrome is not defined" ——
  // 那不是代码的问题，是命令行拼错了，很容易误判成源码有 bug。
  const r = run(f, ['--check']);
  if (!r.ok) {
    failed++;
    console.log(`  ✗ ${f}`);
    console.log(r.out.split('\n').slice(0, 4).map((l) => '      ' + l).join('\n'));
  }
}
if (!failed) console.log(`  ✓ ${SYNTAX.length} 个文件语法正确`);

console.log('\n═══ 测试 ═══');
for (const [file, label] of TESTS) {
  const r = run(file, []);
  const m = r.out.match(/(\d+)\s*(?:通过|项通过)/);
  if (r.ok) console.log(`  ✓ ${label.padEnd(14)} ${m ? m[1] + ' 项' : ''}`);
  else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(r.out.split('\n').slice(0, 6).map((l) => '      ' + l).join('\n'));
  }
}

console.log('\n═══ 静态检查 ═══');
for (const [file, label] of CHECKS) {
  const r = run(file, []);
  if (r.ok) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(r.out.split('\n').filter(Boolean).slice(0, 6).map((l) => '      ' + l).join('\n'));
  }
}

console.log(failed ? `\n✗ ${failed} 项未通过\n` : '\n全部通过 ✓\n');
process.exit(failed ? 1 : 0);