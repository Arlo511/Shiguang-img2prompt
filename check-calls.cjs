// 精准检查：模块顶层定义 vs 顶层代码里的裸调用。
// 只关心"模块级函数/常量是否在使用前定义"这一类问题 ——
// 这正是 service worker 里最容易犯且最难发现的错（TDZ /拼写）。
const fs = require('fs');

const files = [
  'src/background.js',
  'src/panel/panel.js',
  'src/popup/popup.js',
  'src/content.js',
  'src/core/store.js',
  'src/core/api.js',
  'src/core/vlm.js',
  'src/core/renderers.js',
  'src/core/schema.js',
];

let bad = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');

  // 1. 收集所有「模块级」定义（行首无缩进）
  const defLine = new Map();
  lines.forEach((line, i) => {
    let m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) defLine.set(m[1], i);
    m = line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m) defLine.set(m[1], i);
    // 解构导入
    m = line.match(/^import\s*\{([^}]+)\}/);
    if (m) {
      for (const p of m[1].split(',')) {
        const name = p.trim().split(/\s+as\s+/).pop().trim();
        if (name) defLine.set(name, i);
      }
    }
  });

  // 2. 找出所有「模块级裸调用」：不在函数内、不是声明、不是属性访问
  let depth = 0;
  let inBlockComment = false;
  const problems = [];
  lines.forEach((line, i) => {
    let raw = line;

    // 块注释处理
    if (inBlockComment) {
      if (raw.includes('*/')) {
        inBlockComment = false;
        raw = raw.slice(raw.indexOf('*/') + 2);
      } else return;
    }
    if (!inBlockComment && raw.includes('/*')) {
   if (raw.includes('*/', raw.indexOf('/*') + 2)) {
        raw =
    raw.slice(0, raw.indexOf('/*')) +
          raw.slice(raw.indexOf('*/') + 2);
      } else {
        raw = raw.slice(0, raw.indexOf('/*'));
      inBlockComment = true;
      }
    }
    if (/^\s*\/\//.test(raw)) return;

    // 更新花括号深度（粗略：忽略字符串内的）
    const stripped = raw
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/\/\/.*$/, '');
for (const ch of stripped) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }

    if (depth !== 0) return; // 只看顶层语句
    if (/^\s*(import|export|const|let|var|function|async)\b/.test(raw)) return;

    // 找裸调用：不在点号后、不是对象键
    const calls = stripped.match(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g) || [];
    for (const c of calls) {
   const name = c.replace(/\s*\($/, '');
      if (!defLine.has(name)) {
      problems.push({ line: i + 1, name, text: raw.trim().slice(0, 70) });
      }
    }
  });

  if (problems.length) {
    bad++;
    console.log(`\n${f} —— 顶层调用了未定义的函数：`);
    for (const p of problems) {
      console.log(`  行 ${p.line}  ${p.name}()   |  ${p.text}`);
    }
  }
}

if (bad === 0) console.log('所有文件的顶层调用均可解析');
else process.exitCode = 1;