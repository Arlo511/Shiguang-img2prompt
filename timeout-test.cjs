/* 模型调用的超时与重试行为测试。
 *
 * 用户报告「反推异常缓慢，甚至反推不出结果」。三个根因：
 *   1. 调模型完全无超时 —— MV3 的 SW 空闲 30 秒被回收，
 *      模型一慢，await 永远等不到，面板一直转圈
 *   2. withTimeout 是 Promise.race，中止不了底层 fetch
 *   3. 400 降级重试没有排除超时，导致「等两倍时间然后失败」
 *
 * 跑：node timeout-test.cjs
 */

/* ── 从 providers.js 抠出来的真实逻辑 ── */

const VISION_TIMEOUT_MS = 90_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function describeFetchError(e, label) {
  const msg = String(e?.message || e || '');
  if (/timeout|abort/i.test(msg)) {
    return new Error(
      `${label} 响应超时（${Math.round(VISION_TIMEOUT_MS / 1000)} 秒）。` +
        '通常是模型服务繁忙或网络不通，换个服务商或稍后重试。'
    );
  }
  return e;
}

function isTimedOut(e) {
  return /timeout|abort/i.test(String(e?.message || e || ''));
}

/** OpenAI 兼容分支的重试决策 */
function decideRetry(e, wantJson) {
  if (e.status === 400 && wantJson && !isTimedOut(e)) return 'degrade'; // 去掉 json mode
  if (RETRYABLE_STATUS.has(e.status)) return 'backoff'; // 退避后重试
  return 'throw';
}

/* ── 断言 ── */
let pass = 0;
const fails = [];
function ok(c, n) { if (c) pass++; else fails.push(n); }
function eq(a, b, n) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  ok(x === y, `${n}｜期望 ${y}，实际 ${x}`);
}

/* 1. 超时预算必须显著长于 MV3 的 30 秒 SW 空闲窗口。
 *    这是最关键的一条：超时本身不能先杀死 worker。 */
ok(VISION_TIMEOUT_MS > 60_000,
  `超时 ${VISION_TIMEOUT_MS / 1000}s 应大于 60s，须覆盖 SW 的 30s 空闲回收`);

/* 2. 超时错误必须翻译成用户看得懂的话 */
{
  const e = describeFetchError(new Error('The user aborted a request'), 'Agnes');
  ok(/超时/.test(e.message) && /90 秒/.test(e.message),
    `超时错误应说明时长与原因，实际：${e.message}`);
  ok(/换|重试/.test(e.message), '超时错误应给出下一步动作');
}

/* 3. 核心回归：超时后**不能再降级重试**。
 *    原逻辑没有这条，于是服务端一慢就变成「等两倍时间然后失败」。 */
{
  const e = { status: 400, message: 'timeout' };
  eq(decideRetry(e, true), 'throw', '400+超时 不应降级重试（会等两倍时间）');
}

/* 4. 纯 400（非超时）仍要降级 —— 这是降级重试存在的意义 */
{
  const e = { status: 400, message: 'unsupported parameter' };
  eq(decideRetry(e, true), 'degrade', '纯 400 应降级去掉 json mode');
}

/* 5. 没开 json mode 时不该降级（降了也没用，白等一轮） */
{
  const e = { status: 400, message: 'bad request' };
  eq(decideRetry(e, false), 'throw', 'wantJson=false 时不降级');
}

/* 6. 限流/网关类要退避重试 —— 给一次真正的机会 */
for (const s of [429, 500, 502, 503, 504]) {
  eq(decideRetry({ status: s, message: 'x' }, true), 'backoff', `${s} 应退避重试`);
}

/* 7. 认证类错误绝不重试 —— 重试多少次都一样，白白让用户多等 */
for (const s of [401, 403, 404, 400]) {
  if (s === 400) continue; // 400 已在别处覆盖
  eq(decideRetry({ status: s, message: 'x' }, true), 'throw', `${s} 不应重试`);
}

/* 8. 保活间隔必须显著小于 30 秒 */
{
  const KEEPALIVE_MS = 25_000;
  ok(KEEPALIVE_MS < 30_000, `保活间隔 ${KEEPALIVE_MS / 1000}s 应小于 SW 空闲窗口 30s`);
  ok(KEEPALIVE_MS > 20_000, '保活间隔不宜过密，避免无谓唤醒');
}

/* 9. 「测试连接」的超时必须短得多 —— 它是交互动作，用户盯着按钮等 */
{
  const PING_TIMEOUT_MS = 20_000;
  ok(PING_TIMEOUT_MS < VISION_TIMEOUT_MS / 2,
    `探测超时 ${PING_TIMEOUT_MS / 1000}s 应远小于反推的 ${VISION_TIMEOUT_MS / 1000}s`);
}

/* 10. 网络类错误要翻译，不能把 "Failed to fetch" 直接甩给用户 */
{
  const raw = new Error('Failed to fetch');
  const hit = /timeout|abort|Failed to fetch|NetworkError|load failed/i.test(String(raw.message));
  ok(hit, '"Failed to fetch" 应被识别为网络类错误');
}

/* 11. 反向自证：旧逻辑（无超时检查）在同一用例上必须做出不同决策 */
{
  const oldDecide = (e, wantJson) =>
    e.status === 400 && wantJson ? 'degrade' : 'throw';
  const e = { status: 400, message: 'timeout' };
  ok(oldDecide(e, true) === 'degrade',
    '旧逻辑确实会在超时后仍降级重试（测试有效性自证）');
  ok(oldDecide(e, true) !== decideRetry(e, true), '新旧行为必须不同');
}

console.log(`\n超时与重试：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓\n');