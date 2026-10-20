/**
 * 「打开面板」按钮的绑定。
 *
 * 为什么单独一个文件，而不是放进 popup.js：
 *
 *   popup.js 是 type="module"，静态 import 优先于一切代码执行。
 *   只要 api.js / providers.js / vlm.js 里任何一处在**加载期**抛错
 *   （顶层求值失败、依赖路径变化、一个语法的引入失误），
 *   整个 popup.js 就不会执行 —— 里面绑好的监听全部落空。
 *   表现是「按钮在，点它毫无反应，控制台也只有一条无关的模块错误」。
 *
 *   而打开面板是进入这个插件的**唯一入口**，不能跟那些
 *   可选功能的加载成败绑定在一起。所以它必须是一段
 *   不依赖任何 import 的独立脚本 —— 本文件就是这个。
 *
 * MV3 的 CSP 禁止内联脚本（script-src 'self'），
 * 所以不能写成 HTML 里的 <script>...</script>，必须是独立文件。
 */
(function () {
  const btn = document.getElementById('openPanel');
  const msg = document.getElementById('opMsg');
  if (!btn) return;

  // 标记已接管，popup.js 据此跳过重复绑定（一次点击只开一个窗口）
  btn.dataset.inlined = '1';

  const fail = (e) => {
    btn.disabled = false;
    if (msg) {
      msg.hidden = false;
      msg.className = 'opmsg err';
      msg.textContent = '打开面板失败：' + String((e && e.message) || e);
    }
    // SW 侧的异常在这里看不到，控制台是唯一线索
    console.warn('[拾光] 打开面板失败', e);
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (msg) msg.hidden = false;
    if (msg) msg.textContent = '正在打开面板…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'PR_OPEN_PANEL' });
      if (res && res.ok === false) throw new Error(res.error || '未知错误');
      // 成功才关掉 popup。失败要留在页面上，
      // 否则 window.close() 会把错误信息一起销毁，用户只看到「点了没反应」。
      window.close();
    } catch (e) {
      fail(e);
    }
  });
})();