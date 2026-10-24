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
const fs = require('fs');
const os = require('os');

/**
 * 语法检查必须按 manifest 声明的解析模式走，不能一律用 `node --check x.js`。
 *
 * 背景（踩过的坑）：`node --check` 对 `.js` 走 **CommonJS/sloppy** 解析，
 * 对 `.mjs` 走 **ES module/strict** 解析。同一份逐字节相同的文件，
 * `.js` 通过、`.mjs` 失败 —— 说明存在只在 strict 模式暴露的语法错误。
 * Chrome 按 manifest 的 `"type": "module"` 解析 service worker，
 * 所以必须用 module 模式检查，否则检查器给的是假阳性。
 *
 * 做法：把含 import/export 的文件复制成 `.mjs` 再 `--check`。
 * 复制到临时目录而不是仓库里，避免污染工作区。
 */
function isModuleSource(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  return /^\s*(import|export)[\s{*]/m.test(src);
}

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
  ['timeout-test.cjs', '超时与重试'],
];

/** 静态检查：只关心退出码，输出是给人看的 */
const CHECKS = [
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

/**
 * 按文件的真实解析模式做语法检查。
 * @param {string} file  仓库相对路径
 * @returns {{ok:boolean, out:string}}
 */
function checkSyntax(file) {
  const abs = path.join(__dirname, file);
  if (!isModuleSource(file)) {
    // 普通脚本：直接 `--check`
    return run(file, ['--check']);
  }
  // module 文件：复制为 .mjs 走 strict/module 解析
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-syntax-')), 'probe.mjs');
  try {
    fs.copyFileSync(abs, tmp);
    const out = execFileSync(NODE, ['--check', tmp], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, out: out || '' };
  } catch (e) {
    // 报错信息里带的是临时文件路径，回填成仓库路径才好定位
    const txt = `${e.stdout || ''}${e.stderr || ''}`.split(tmp).join(file);
    return { ok: false, out: txt };
  } finally {
    try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch {}
  }
}

/**
 * 反向验证检查器：故意注入一个**只在 strict/module 模式暴露**的错误。
 *
 * 选 `with` 语句而不是「多一个 `}`」：`with` 在 sloppy 模式合法、在 strict 模式报错，
 * 所以它能证明检查器**确实在用 module 模式**跑，而不是碰巧用 CommonJS 也过了。
 * 若用「多一个 `}`」这种两种模式都报错的错误，自检会给出假的安全感。
 *
 * 检查器自己不报错 = 检查器是坏的，那所有「全绿」都不可信。
 */
function selfTest() {
  const src = fs.readFileSync(path.join(__dirname, 'src/background.js'), 'utf8');
  const injected = src + '\nwith ({}) { }\n';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-selftest-'));
  const tmp = path.join(tmpDir, 'probe.mjs');
  try {
    fs.writeFileSync(tmp, injected, 'utf8');
    execFileSync(NODE, ['--check', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: false, out: '注入 strict-only 错误后仍然通过 —— 检查器没在用 module 模式' };
  } catch (e) {
    const msg = `${e.stderr || ''}`;
    return {
      ok: /with statement/i.test(msg),
      out: msg.split('\n').slice(0, 3).join('\n'),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n═══ 语法检查 ═══');
for (const f of SYNTAX) {
  // --check 必须排在文件名**之前**。写成 ['file','--check'] 时
  // node 会把它当脚本参数、真的去执行该文件，于是报
  // "ReferenceError: chrome is not defined" ——
  // 那不是代码的问题，是命令行拼错了，很容易误判成源码有 bug。
  const r = checkSyntax(f);
  if (!r.ok) {
    failed++;
    console.log(`  ✗ ${f}`);
    console.log(r.out.split('\n').slice(0, 4).map((l) => '      ' + l).join('\n'));
  }
}
if (!failed) console.log(`  ✓ ${SYNTAX.length} 个文件语法正确`);

console.log('\n═══ 检查器自检 ═══');
{
  const r = selfTest();
  if (r.ok) console.log('  ✓ strict-only 错误能被检出（确在用 module 模式）');
  else {
    failed++;
    console.log(`  ✗ 检查器自检失败`);
    console.log(r.out.split('\n').slice(0, 4).map((l) => '      ' + l).join('\n'));
  }
}

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