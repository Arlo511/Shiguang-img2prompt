/**
 * ISOLATED world 内容脚本
 *
 * 职责：
 *   1. 给右键命中的元素打标记 —— 取图函数靠它精确定位
 *   2. 记录右键坐标 —— 标记找不到时的备选
 *   3. 拖拽 / 粘贴入口 —— **默认关闭**，需在设置里开启
 *
 * 为什么用「元素标记」而不是「坐标」：
 *   坐标方案在 iframe / shadow DOM 里会失效。注入只跑主框架时，
 *   elementFromPoint 拿到的是 iframe 元素本身，而不是里面的图片。
 *   小红书瀑布流、Pinterest 卡片大量用 iframe 和 shadow DOM。
 *
 * 为什么不用 chrome.runtime 消息传数据：
 *   executeScript 注入的脚本内部抛错时不会 reject，会制造「通信正常」的假象。
 *   而 content script 与 executeScript({world:'ISOLATED'}) 共享同一个
 *   隔离世界和同一个 window 对象，直接挂 window.__PR_* 最可靠。
 *
 * 拖拽与粘贴的取舍：
 *   用户反馈这两者都会与其他插件冲突（拖拽与手势扩展、Ctrl+V 与网页编辑器），
 *   所以默认关闭。开启后也只监听用户明确指定的快捷键，避免劫持默认粘贴。
 */

const MARK_ATTR = 'data-pr-hit';
const KEY_CLICK = '__PR_LAST_CLICK__';
const KEY_PASTE = '__PR_PASTED__';
const CLICK_TTL = 20_000;
const TOKEN = Date.now().toString(36);

/** 从 storage 读触发设置。失败时返回全关的保守默认值 */
async function loadTriggers() {
  try {
    const s = await chrome.storage.local.get([
      'contextMenu',
      'paste',
      'dragDrop',
      'pasteShortcut',
    ]);
    return {
      contextMenu: s.contextMenu !== false,
      paste: s.paste === true,
      dragDrop: s.dragDrop === true,
      pasteShortcut: s.pasteShortcut || 'none',
    };
  } catch {
    return { contextMenu: true, paste: false, dragDrop: false, pasteShortcut: 'none' };
  }
}

/** 旧版枚举值 → 规范化串。升级后自动平替 */
const LEGACY_SHORTCUT = {
  ctrlShiftV: 'Ctrl+Shift+V',
  altV: 'Alt+V',
  ctrlV: 'Ctrl+V',
};

/** 把当前设置写到 window 上，供注入函数读取（同步可用） */
async function publishConfig() {
  const t = await loadTriggers();
  if (LEGACY_SHORTCUT[t.pasteShortcut]) {
    t.pasteShortcut = LEGACY_SHORTCUT[t.pasteShortcut];
    chrome.storage.local.set({ pasteShortcut: t.pasteShortcut }).catch(() => {});
  }
  window.__PR_CONFIG__ = t;
  return t;
}

// --- 右键：给命中的最深元素打标记 ---
//
// 关键：很多站点（含小红书大图页）会自己实现右键菜单并调用
// preventDefault()，这时 Chrome 原生菜单被抑制，扩展的菜单项
// **根本不会出现**。所以这里除了打标记，还要记住「原生菜单是否被抑制」，
// 由下面的自绘菜单补位。
window.addEventListener(
  'contextmenu',
  (e) => {
    try {
      document.querySelectorAll(`[${MARK_ATTR}]`).forEach((n) => {
        try {
          n.removeAttribute(MARK_ATTR);
        } catch {}
      });

      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const target =
        (path && path[0] && path[0].nodeType === 1 ? path[0] : null) ||
        (e.target && e.target.nodeType === 1 ? e.target : null);

      if (target && typeof target.setAttribute === 'function') {
        target.setAttribute(MARK_ATTR, TOKEN);
      }

      // 若右键目标是 <img>，记下它的真实地址 —— 这是最可靠的定位来源，
      // 自绘菜单点击时可以直接复用，不必再靠几何猜。
      let srcUrl = '';
      try {
        const img =
          target && target.tagName === 'IMG'
            ? target
            : target && typeof target.closest === 'function'
              ? target.closest('img')
              : null;
        if (img) srcUrl = img.currentSrc || img.src || '';
      } catch {}

      // 同时记视口坐标与文档坐标：
      //   clientX/Y  —— 与 getBoundingClientRect() 同系，几何命中用
      //   pageX/Y    —— 右键菜单弹出后若页面被滚动，文档坐标仍能定位
      window[KEY_CLICK] = {
        x: e.clientX,
        y: e.clientY,
        pageX: typeof e.pageX === 'number' ? e.pageX : e.clientX + window.scrollX,
        pageY: typeof e.pageY === 'number' ? e.pageY : e.clientY + window.scrollY,
        srcUrl,
        at: Date.now(),
      };

      // 在事件派发结束后再看 defaultPrevented —— 页面自己的处理器
      // 可能在其后的冒泡阶段才调 preventDefault。
      setTimeout(() => {
        try {
          window[KEY_CLICK].defaultPrevented = !!e.defaultPrevented;
          if (e.defaultPrevented) {
            renderFallbackMenu(e.clientX, e.clientY, window[KEY_CLICK]);
          }
        } catch {}
      }, 0);
    } catch {}
  },
  true
);

/**
 * 自绘菜单：页面屏蔽了原生右键菜单时的兜底。
 *
 * 为什么要做这个：Chrome 的扩展菜单项只在**原生**上下文菜单里渲染。
 * 页面若自己画菜单并 preventDefault()，扩展菜单项不会有任何表现 ——
 * 表现为「某些页面右键完全没反应」，很容易被误判成 URL 白名单问题。
 *
 * 策略：把自己的条目**插进页面画的那个菜单里**。克隆已有条目，
 * 样式、分隔线、hover、位置全部自动继承 —— 与页面菜单完全一致。
 * 只有确实找不到页面菜单时，才退回自绘浮层。
 */

// 从光标处的元素栈往上找「页面画的菜单容器」
function findPageMenu(x, y) {
  let stack = [];
  try {
    stack = document.elementsFromPoint(x, y) || [];
  } catch {
    return null;
  }

  for (const start of stack) {
    let node = start;
    let depth = 0;
    while (node && node !== document.body && depth < 14) {
      const found = testMenuContainer(node);
      if (found) return found;
      node = node.parentElement;
      depth++;
    }
  }
  return null;
}

/** 元素是否是一个菜单容器；是则返回 { container, items } */
function testMenuContainer(el) {
  if (!el || el.nodeType !== 1) return null;
  const r = el.getBoundingClientRect();
  // 菜单的尺寸特征：不太宽、不太高
  if (r.width < 70 || r.width > 420 || r.height < 50 || r.height > 700) return null;
  const items = collectItemsDeep(el);
  return items.length >= 2 ? { container: el, items } : null;
}

/**
 * 递归向下找「像菜单项」的一组子元素。
 *
 * 不能只看直接子元素：小红书的结构是
 *   div.menu > ul > li*3
 * 直接子元素只有一个 ul，其 textContent 是三条菜单文字连在一起
 * （超过 30 字符），会被过滤掉 -> 判定「不是菜单」。
 * 所以必须逐层下探，找到「这一层的子元素全都像菜单项」的那一层。
 */
function collectItemsDeep(container) {
  const isItem = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12 || r.height > 80) return false;
    const t = (el.textContent || '').trim();
    return !!t && t.length <= 30;
  };

  let level = [container];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const kids = [];
    let itemCount = 0;
    for (const el of level) {
      for (const c of el.children || []) {
        kids.push(c);
        if (isItem(c)) itemCount++;
      }
    }
    if (itemCount >= 2) {
      const items = kids.filter(isItem);
      const hs = items.map((e) => e.getBoundingClientRect().height);
      // 高度差异过大说明这组元素不是同属一个菜单
      if (Math.max(...hs) - Math.min(...hs) <= 16 && compactlyStacked(items)) {
        return items;
      }
    }
    // 子节点过多时不再下探，避免在超大容器里白跑
    if (kids.length > 80) return [];
    level = kids;
  }
  return [];
}

/**
 * 菜单项在视觉上是**紧邻排列**的：前一项的底边紧接下一项的顶边。
 *
 * 这道过滤能排除页面上偶然同尺寸的并列元素（比如两个高度相近的卡片）——
 * 它们尺寸、文字长度都符合，但彼此之间有空隙，不是菜单。
 */
function compactlyStacked(items) {
  if (items.length < 2) return false;
  const rects = items
    .map((e) => e.getBoundingClientRect())
    .sort((a, b) => a.top - b.top);

  let maxGap = 0;
  for (let i = 1; i < rects.length; i++) {
    const gap = Math.abs(rects[i].top - rects[i - 1].bottom);
    if (gap > maxGap) maxGap = gap;
    // 间隙超过一个条目高度就说明不是一组菜单项
    if (gap > Math.min(rects[i].height, rects[i - 1].height) * 0.6) return false;
  }
  return true;
}

/**
 * 在给定子树里找菜单容器（用于 MutationObserver 回调）。
 */
function findMenuInSubtree(root) {
  if (!root || root.nodeType !== 1) return null;
  const direct = testMenuContainer(root);
  if (direct) return direct;

  let all;
  try {
    all = root.querySelectorAll('div,ul,ol,section,nav');
  } catch {
    return null;
  }
  const n = Math.min(all.length, 600);
  for (let i = 0; i < n; i++) {
    const found = testMenuContainer(all[i]);
    if (found) return found;
  }
  return null;
}

/**
 * 全页扫描找菜单容器。
 *
 * 为什么必须有这条路径：原先只用 `elementsFromPoint(x, y)`，
 * 而 x/y 是**右键坐标**。但页面菜单不一定覆盖在光标上——
 * 小红书的大图菜单会向上弹出或贴着容器边缘生长，
 * 光标处可能压根没有任何菜单元素。
 *
 * 于是探测失败 → 退到自绘 → 而自绘位置又依赖探测结果做避让 →
 * 探测成功就避让、失败就贴光标 —— 这正是「位置乱跑」的来源。
 *
 * 全页扫描不依赖坐标，只认「尺寸像菜单 + 条目紧邻排列」这两个特征。
 */
function scanWholePageForMenu() {
  let all;
  try {
    all = document.querySelectorAll('div,ul,ol,section,nav,header,footer,aside');
  } catch {
    return null;
  }
  // 小红书这类重页面元素很多，限制扫描量；
  // 菜单一般是刚挂载的，DOM 顺序上靠后，从尾部扫命中率更高。
  const total = all.length;
  const limit = Math.min(total, 2500);
  for (let i = limit - 1; i >= 0; i--) {
    const found = testMenuContainer(all[i]);
    if (found) return found;
  }
  return null;
}

/** 光标处探测 + 全页扫描，两条路径合并 */
function locatePageMenu(x, y) {
  return findPageMenu(x, y) || scanWholePageForMenu();
}

/** 插入到页面菜单里，或画独立浮层 */
function renderFallbackMenu(x, y, click) {
  // 配置尚未发布时不画 —— 宁可少一次菜单，也不要在用户关了右键后还弹出来。
  // install() 会在 storage 读取完成后补发布。
  const cfg = window.__PR_CONFIG__;
  if (!cfg || cfg.contextMenu === false) return;

  cleanupFallbackMenu();

  // 页面菜单常常在之后几帧才挂载（很多站点用 requestAnimationFrame
  // 或 setTimeout）。固定次数的重试无法覆盖各种时序 —— 表现为
  // 「有时插进页面菜单、有时退到自绘」，位置看起来随机。
  //
  // 三条探测路径并行，任何一条命中就插入：
  //   1. MutationObserver —— 菜单被插入 DOM 的那一刻（最快最准）
  //   2. 立即探测 —— 页面菜单已存在（同步渲染的站点）
  //   3. 定时重扫 —— 菜单由框架托管、复用已有节点时 observer 看不到
  let settled = false;
  let sawMenu = false;
  let obs = null;
  let timers = [];

  const finish = (found) => {
    if (settled) return;
    settled = true;
    try {
      obs?.disconnect();
    } catch {}
    for (const t of timers) clearTimeout(t);
    timers = [];
    if (found && insertIntoPageMenu(found, click)) return;
    // 页面菜单出现过又消失了（用户已点别处）：不该再画一个
    if (sawMenu) return;
    drawOwnMenu(x, y, click);
  };

  const probe = () => {
    if (settled) return;
    const found = locatePageMenu(x, y);
    if (found) {
      sawMenu = true;
      finish(found);
    }
  };

  try {
    obs = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1) continue;
          const found = findMenuInSubtree(node);
          if (found) {
            sawMenu = true;
            finish(found);
            return;
          }
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* observe 失败则只靠下面的定时重扫 */
  }

  // 立即探测一次（页面菜单已经存在的情况）
  probe();
  if (settled) return;

  // 定时重扫：覆盖「菜单节点被框架复用、observer 看不到新增」的情况。
  // 间隔递增 —— 菜单通常在前几百毫秒挂载，之后就不太可能了。
  for (const ms of [50, 120, 250, 450, 700, 1000, 1400]) {
    timers.push(setTimeout(probe, ms));
  }
}

/** 往页面菜单里插一条。成功返回 true。 */
function insertIntoPageMenu(found, click) {
  try {
    const items = found.items;
    if (!items || !items.length) return false;

    // 克隆**第一个**条目而不是最后一个：最后一个通常带
    // `:last-child` / `:last-of-type` 样式（去掉底部圆角或边框），
    // 克隆它会让新条目看起来跟菜单不一致。
    const proto = items[0];
    const node = proto.cloneNode(true);
    node.removeAttribute(MARK_ATTR);

    // 保留结构（图标、span 等），只替换文字节点。
    // 直接 textContent = 会把内部结构清掉，某些菜单项的排版
    // 依赖 flex 子元素，全清了就散了。
    replaceTextKeepingStructure(node, '用拾光反推提示词');
    node.style.cursor = 'pointer';

    // 用 pointerdown 触发而非 click：外部收起监听可能挂在
    // pointerdown 上并移除节点，那样 click 永远派发不到这里。
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      cleanupFallbackMenu();
      requestReverse(click);
    });

    // 插到最后一条之后，位置与页面菜单融为一体
    const last = items[items.length - 1];
    if (last.parentNode === found.container) {
      found.container.insertBefore(node, last.nextSibling);
    } else {
      found.container.appendChild(node);
    }

    fallbackNodes.push(node);
    watchRemoval(node);
    return true;
  } catch {
    return false;
  }
}

/**
 * 替换元素里的文字，但保留子元素结构。
 * 优先替换最内层的纯文字节点；若该条目只有一个文本节点则直接设。
 */
function replaceTextKeepingStructure(el, text) {
  const textNodes = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if ((child.textContent || '').trim()) textNodes.push(child);
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(el);

  if (!textNodes.length) {
    el.textContent = text;
    return;
  }
  // 保留第一个有文字的节点，删掉其余（避免原条目多段文字残留）
  textNodes[0].textContent = text;
  for (let i = 1; i < textNodes.length; i++) {
    try {
      textNodes[i].remove();
    } catch {}
  }
}

/**
 * 自绘浮层：页面没有菜单、或插不进去时的兜底。
 *
 * 定位必须是**确定性规则**，不能依赖「探测到页面菜单就避让」。
 * 之前正是这个依赖导致位置乱跑：探测成功→避让到侧边，失败→贴光标，
 * 两次右键结果不同。现在无论探测结果如何都走同一套规则：
 *
 *   1. 贴着光标右下（与 Chrome 原生菜单的行为一致）
 *   2. 右边放不下就翻到光标左侧
 *   3. 下边放不下就翻到光标上方
 *   4. 最后统一内收到屏幕内
 *
 * 也就是**Chrome 原生菜单的定位算法**。这样每次位置都可预期，
 * 用户看到的是稳定的、与浏览器一致的弹出位置。
 */
function drawOwnMenu(x, y, click) {
  try {
    const W = 184;
    const H = 40;
    const OFFSET = 2;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 主选：光标右下
    let left = x + OFFSET;
    let top = y + OFFSET;

    // 右边放不下 → 翻到左侧
    if (left + W > vw - 8) {
      left = Math.max(8, x - W - OFFSET);
    }
    // 下边放不下 → 翻到上方
    if (top + H > vh - 8) {
      top = Math.max(8, y - H - OFFSET);
    }

    // 统一内收，保证不出屏
    left = Math.max(8, Math.min(left, vw - W - 8));
    top = Math.max(8, Math.min(top, vh - H - 8));

    const host = document.createElement('div');
    host.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;left:0;top:0;';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `
      <style>
        .m {
          position: fixed;
          min-width: 176px; padding: 4px 0;
          background: #fff; border-radius: 8px;
          box-shadow: 0 6px 24px rgba(0,0,0,.16);
          border: 1px solid rgba(0,0,0,.06);
          font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #1f2328;
        }
        .i { padding: 8px 16px; cursor: pointer; white-space: nowrap; }
        .i:hover { background: #f0f4f8; }
      </style>
      <div class="m" id="m">
        <div class="i" id="i">用拾光反推提示词</div>
      </div>`;

    const item = sh.getElementById('i');

    // 用 pointerdown 而不是 click 触发。
    //
    // 关键：外部收起监听若也挂在 pointerdown 上，会在同一个事件里
    // 先把 host 移除，于是后续的 click 永远派发不到这个元素上——
    // 表现为「菜单能看见、点了没反应」。让点击在最开始的
    // pointerdown 就触发，彻底避开这个时序问题。
    item.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      requestReverse(click);
    });

    sh.getElementById('m').style.left = `${left}px`;
    sh.getElementById('m').style.top = `${top}px`;

    document.documentElement.appendChild(host);
    fallbackNodes.push(host);
    dismissOnOutside(host);
  } catch {}
}

let fallbackNodes = [];

function cleanupFallbackMenu() {
  for (const n of fallbackNodes) {
    try {
      n.remove();
    } catch {}
  }
  fallbackNodes = [];
}

/** 页面菜单关闭时把插入的条目一并移除，否则会留残影 */
function watchRemoval(node) {
  const obs = new MutationObserver(() => {
    if (!node.isConnected) {
      obs.disconnect();
      const i = fallbackNodes.indexOf(node);
      if (i >= 0) fallbackNodes.splice(i, 1);
    }
  });
  try {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
}

/**
 * 点击别处 / 滚动 / Esc 时收起自绘浮层。
 *
 * 注意 pointerdown 的判断顺序问题：菜单项自己的 pointerdown 处理器
 * 和这里的收起监听是同一个事件。收起监听必须**先判断事件目标是不是
 * 我们自己的菜单**，是则放行 —— 否则会把菜单移除掉，导致项的点击
 * 永远不触发（表现为「菜单能看见，点了没反应」）。
 */
function dismissOnOutside(host) {
  const onDown = (ev) => {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    if (path.includes(host) || ev.target === host) {
      // 点自己：只解除这一次监听，不收起 —— 菜单项的 pointerdown
      // 处理器随后还要触发。留着监听会导致它累积。
      window.removeEventListener('pointerdown', onDown, { capture: true });
      return;
    }
    cleanupFallbackMenu();
  };
  setTimeout(() => {
    // 都用 once：即便事件没触发，也保证下次右键时不会有多份监听叠加
    window.addEventListener('pointerdown', onDown, { once: true, capture: true });
    window.addEventListener(
      'wheel',
      () => cleanupFallbackMenu(),
      { once: true, capture: true }
    );
    window.addEventListener(
      'keydown',
      () => cleanupFallbackMenu(),
      { once: true, capture: true }
    );
  }, 0);
  setTimeout(cleanupFallbackMenu, 8000);
}

/**
 * 扩展上下文是否还有效。
 *
 * 用户在 chrome://extensions 里点了「重新加载」之后，**已经打开的网页里
 * 注入过的 content script 不会被卸载**，但它持有的 chrome.runtime 通道
 * 已经失效。此时任何 sendMessage 调用都会抛
 * `Uncaught Error: Extension context invalidated.` —— 而且是**同步抛出**，
 * 不会走Promise 的 catch，于是直接变成页面控制台里一条无上下文的红字，
 * 用户只看到「报错」，完全不知道该做什么。
 *
 * 这不是代码 bug：只要扩展被重载，先前打开的页面必然如此。
 * 但我们至少能把它变成一句可执行的提示，而不是一条红字。
 */
function isContextValid() {
  // chrome.runtime 本身存在，但 id 变undefined 是上下文失效的可靠信号
  return !!(chrome?.runtime && chrome.runtime.id);
}

/** 上下文失效时的统一提示。只提示一次，避免反复触发刷屏 */
let contextDeadNotified = false;
function notifyContextDead() {
  if (contextDeadNotified) return;
  contextDeadNotified = true;
  toast('扩展已重新加载', '请刷新当前页面后再试', 'err');
}

/** 让 service worker 走一次反推（等价于点了扩展菜单项） */
function requestReverse(click) {
  cleanupFallbackMenu();

  if (!isContextValid()) {
    notifyContextDead();
    return;
  }

  toast('正在反推…', '约 5~10 秒');

  // 整段包 try/catch：sendMessage 在上下文失效时是同步抛出，
  // 外层的 Promise.catch 接不住
  try {
    chrome.runtime
      .sendMessage({
        type: 'PR_REVERSE_AT',
        srcUrl: (click && click.srcUrl) || '',
        x: click && click.x,
        y: click && click.y,
      })
      .then((res) => {
        if (res && res.ok === false && res.error) toast('反推未启动', res.error, 'err');
      })
      .catch(() => {
        toast('反推未启动', '请刷新页面后重试', 'err');
      });
  } catch {
    notifyContextDead();
  }
}

/**
 * 页面内浮层提示。
 *
 * 为什么要它：拖拽/粘贴的结果最终显示在面板里，而面板是新开的窗口，
 * 用户此刻的注意力还在网页上。没有即时反馈的话会以为没触发。
 * 浮层让「已接收 → 反推中 → 完成」这条链路始终可见，不必切窗口。
 *
 * 用 shadow DOM 隔离样式，避免被页面 CSS 影响。
 */
const toastHost = document.createElement('div');
toastHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
const shadow = toastHost.attachShadow({ mode: 'closed' });
shadow.innerHTML = `
  <style>
    .box {
      position: fixed; right: 16px; bottom: 16px;
      background: #1f2328; color: #fff;
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 12px 16px; border-radius: 10px; max-width: 320px;
      box-shadow: 0 8px 24px rgba(0,0,0,.2);
      display: flex; align-items: center; gap: 10px;
    }
    .box.hidden { display: none; }
    /* 投放区显示时，反推提示上移让位，两者不重叠 */
    .zone.show ~ .box { bottom: 172px; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #58a6ff; flex: none;
      animation: pulse 1.2s ease-in-out infinite;
    }
    .dot.done { background: #3fb950; animation: none; }
    .dot.err  { background: #f85149; animation: none; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    .txt { flex: 1; }
    .sub { font-size: 11px; opacity: .7; margin-top: 2px; }

    /* 拖拽投放区。宽高与 JS 的 ZONE_W/ZONE_H 保持一致 */
    .zone {
      position: fixed; right: 24px; bottom: 24px;
      width: min(208px, calc(100vw - 48px));
      height: min(132px, calc(100vh - 48px));
      border: 2px dashed rgba(56, 139, 253, .7);
      border-radius: 14px;
      background: rgba(9, 105, 218, .10);
      backdrop-filter: blur(3px);
      display: none;
      align-items: center; justify-content: center;
      text-align: center;
      color: #0c447c;
      font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 6px 28px rgba(0,0,0,.18);
      pointer-events: none;
      transition: transform .12s ease, background .12s ease, border-color .12s ease;
      z-index: 1;
    }
    .zone.show { display: flex; }
    .zone.over {
      border-color: #0969da;
      background: rgba(9, 105, 218, .22);
      transform: scale(1.05);
    }
    /* 浅色页面下文字改深色 */
    .zone.light { color: #0c447c; }
    .zt { font-weight: 600; font-size: 13px; }
    .zs { font-size: 11px; opacity: .75; margin-top: 3px; }
  </style>
  <div class="zone" id="zone">
    <div>
      <div class="zt">拖到这里反推提示词</div>
      <div class="zs">松开鼠标即开始识别</div>
    </div>
  </div>
  <div class="box hidden" id="box">
    <div class="dot" id="dot"></div>
    <div class="txt">
      <div id="msg">准备中…</div>
      <div class="sub" id="sub">拾光 Img2Prompt</div>
    </div>
  </div>`;

function mountToast() {
  if (!document.body) {
    // body 可能还没就绪，等一下再挂
    setTimeout(mountToast, 200);
    return;
  }
  document.documentElement.appendChild(toastHost);
}

let toastTimer = null;
function toast(msg, sub, kind) {
  try {
    const box = shadow.getElementById('box');
    const dot = shadow.getElementById('dot');
    if (!box) return;
    shadow.getElementById('msg').textContent = msg;
    shadow.getElementById('sub').textContent = sub || '拾光';
    dot.className = 'dot' + (kind ? ' ' + kind : '');
    box.classList.remove('hidden');
    clearTimeout(toastTimer);
    // 成功/失败提示停留久一些，进行中的短一点
    toastTimer = setTimeout(() => box.classList.add('hidden'), kind ? 6000 : 30000);
  } catch {}
}

/* ---------------- 拖拽投放区 ---------------- */

/**
 * 投放区的几何参数。判定必须和 CSS 里的尺寸一致，
 * 否则会出现「视觉上在区内但判定为区外」。
 */
const ZONE_W = 208;
const ZONE_H = 132;
const ZONE_MARGIN = 24;

/**
 * 点是否落在投放区内。
 *
 * 几何必须与 CSS 完全一致（.zone 的 width/height/right/bottom），
 * 否则会出现「视觉上在区内但判定为区外」——用户松手了却没反应。
 *
 * 视口小于区域时 CSS 的 fixed 会自动贴边，但这里的计算会得到负起点，
 * 所以两边都做clamp，保证判定与视觉一致。
 */
function isOverZone(x, y) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 视口小于区域时收缩区域尺寸，保证完整在屏内（与 CSS 表现一致）
  const w = Math.min(ZONE_W, Math.max(0, vw - ZONE_MARGIN * 2));
  const h = Math.min(ZONE_H, Math.max(0, vh - ZONE_MARGIN * 2));

  const left = Math.max(0, vw - w - ZONE_MARGIN);
  const top = Math.max(0, vh - h - ZONE_MARGIN);

  return x >= left && x <= left + w && y >= top && y <= top + h;
}

/** 显示 / 隐藏投放区 */
function showDropZone(on) {
  try {
    const z = shadow.getElementById('zone');
    if (!z) return;
    z.classList.toggle('show', !!on);
    if (!on) z.classList.remove('over');
  } catch {}
}

/** 拖拽经过时的高亮反馈 */
function updateDropZoneHover(over) {
  try {
    const z = shadow.getElementById('zone');
    if (!z) return;
    z.classList.toggle('over', !!over);
  } catch {}
}

mountToast();

/**
 * 存下图片并交给 background 处理。
 *
 * 消息通道可能失败（SW 未唤醒 / content script 刚注入），失败时静默保留
 * window.__PR_PASTED__，由用户右键时 grabDropped 兜底捞取。
 */
function stash(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const payload = { dataUrl: reader.result, mime: file.type, at: Date.now() };
    window[KEY_PASTE] = payload;

    toast('已接收图片，正在反推…', '拾光');

    if (!isContextValid()) {
      notifyContextDead();
      return;
    }

    // 通知 SW 立即反推并弹面板 —— 这是拖拽/粘贴的主动路径，
    // 不该要求用户先打开面板或再点一次右键。
    //
    // try/catch 的原因同requestReverse：上下文失效时 sendMessage
    // 是同步抛出，Promise 的 catch 接不住。
    try {
      chrome.runtime
        .sendMessage({ type: 'PR_IMAGE_READY', dataUrl: payload.dataUrl, mime: payload.mime })
        .then((res) => {
          if (res?.ok === false) toast('反推未启动', res.error || '', 'err');
        })
        .catch(() => {
          toast('反推未启动', '请刷新页面后重试', 'err');
        });
    } catch {
      notifyContextDead();
    }
  };
  reader.readAsDataURL(file);
}

/**
 * 判断事件是否命中用户设定的组合键。
 *
 * 这里内联一份而不从 core/shortcut.js import：content script 由
 * manifest 以普通脚本声明，不是 module，没有 import 语法可用。
 * 两处必须同步演进 —— core/shortcut.js 是 popup 录制用的权威实现，
 * 本函数是它在页面侧的运行时副本。
 *
 * 严格比较四个修饰位而非「包含」：否则 Ctrl+V 会被 Ctrl+Shift+V
 * 命中，两种设置就分不出彼此。
 */
function matchShortcut(e, s) {
  const parts = String(s || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  const key = parts.pop();
  const set = new Set(parts.map((p) => p.toLowerCase()));
  const raw = String(e.key || '');
  const norm = raw.length === 1 ? raw.toUpperCase() : raw;
  return (
    e.ctrlKey === (set.has('ctrl') || set.has('control')) &&
    e.altKey === (set.has('alt') || set.has('option')) &&
    e.shiftKey === set.has('shift') &&
    e.metaKey === (set.has('meta') || set.has('cmd') || set.has('command')) &&
    norm === (key.length === 1 ? key.toUpperCase() : key)
  );
}

/** 从 paste 事件里取图片（剪贴板数据只在这里有） */
function grabFromClipboard(e) {
  const item = [...(e.clipboardData?.items || [])].find((i) =>
    i.type.startsWith('image/')
  );
  if (!item) return false;
  const f = item.getAsFile();
  if (!f) return false;
  stash(f);
  return true;
}

/**
 * 直接从系统剪贴板读图片。
 *
 * 为什么不能只靠 paste 事件：
 *   paste 事件只在页面**有可粘贴目标**时才会派发。焦点在 body 或
 *   普通 div 上时，Chrome 不会产生 paste 事件（复制一张图再随手
 *   Ctrl+V 到页面上，什么都不会发生）—— 这正是原先「网页端按快捷键
 *   没反应」的直接原因。而且剪贴板里若只有文字，paste 事件的
 *   clipboardData 也不含图片。
 *
 * navigator.clipboard.read() 不依赖焦点位置与可粘贴目标，是唯一
 * 在任意页面都稳定可用的读法。需要在 manifest 申请 clipboardRead。
 */
async function readClipboardImage() {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await it.getType(type);
      if (blob && blob.size) {
        stash(new File([blob], 'clipboard.' + type.split('/')[1], { type }));
        return blob;
      }
    }
  } catch {
    // 权限被拒或剪贴板无图片 —— 静默失败，用户按了没反应不该弹错
  }
  return null;
}

// service worker 把反推结果状态推回来，浮层据此更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'PR_SHOW_TOAST') {
    toast(msg.msg || '', msg.sub || '', msg.kind || '');
  }
});

// --- 安装可选监听 ---
async function install() {
  const t = await publishConfig();

  /*
   * 拖拽：默认关闭。
   *
   * 交互设计：拖拽时**不直接触发**，只在屏幕角落显示一个投放区，
   * 用户把图片拖进去才反推。
   *
   * 为什么这么做：
   *   1. 避免误触 —— 页面上拖拽的场景太常见（拖文本、拖别的元素、
   *      手势插件自己的拖拽），无条件响应会打断用户
   *   2. 明确意图 —— 用户看到「拖到这里」的提示，知道该怎么触发
   *   3. 浏览器行为不被打断 —— 落在区域外时不 preventDefault，
   *      浏览器的默认行为（在新标签页打开图片等）照常
   *
   * 用 dragenter/dragleave 计数判断是否真的在拖入（这两个事件在
   * 移动鼠标时会反复触发，直接用会闪）。
   */
  if (t.dragDrop) {
    let zoneActive = false;

    /**
     * 判断这次拖拽是否携带图片文件。
     *
     * 必须看 `dataTransfer.types` 而不是 `files` —— dragenter 阶段
     * files 可能还不可用，且拖拽页面内元素（如链接、图片）时
     * files 为空但 types 有值。
     */
    const dragsImage = (e) => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      const types = dt.types;
      if (types && typeof types.includes === 'function') {
        return types.includes('Files');
      }
      return !!(dt.files && dt.files.length);
    };

    const showZone = () => {
      if (zoneActive) return;
      zoneActive = true;
      showDropZone(true);
    };
    const hideZone = () => {
      if (!zoneActive) return;
      zoneActive = false;
      showDropZone(false);
      updateDropZoneHover(false);
    };

    // 进入页面：显示投放区
    window.addEventListener(
      'dragenter',
      (e) => {
        if (!dragsImage(e)) return;
        showZone();
      },
      true
    );

    // 离开窗口：relatedTarget 为 null 表示出去了
    window.addEventListener(
      'dragleave',
      (e) => {
        if (e.relatedTarget === null) hideZone();
      },
      true
    );

    // 拖拽经过：阻止默认行为才能收到 drop，同时更新高亮
    window.addEventListener(
      'dragover',
      (e) => {
        if (!zoneActive) return;
        // 必须 preventDefault，否则 drop 不触发
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        updateDropZoneHover(isOverZone(e.clientX, e.clientY));
      },
      true
    );

    // 投放：只在区域内才接管
    window.addEventListener(
      'drop',
      (e) => {
        if (!zoneActive) return; // 区域没显示说明不是拖文件进来，不干预
        // 落在区域外 → 放行给浏览器（打开图片等默认行为）
        if (!isOverZone(e.clientX, e.clientY)) return;

        const f = e.dataTransfer?.files?.[0];
        if (!f || !f.type.startsWith('image/')) return;

        e.preventDefault();
        e.stopPropagation();
        hideZone();
        stash(f);
      },
      true
    );

    window.addEventListener('dragend', hideZone, true);
    window.addEventListener('blur', hideZone);
  }

  // 快捷键粘贴：默认关闭。只响应用户自己设定的组合键。
  //
  // 双通道：keydown 命中后先直接读剪贴板（不依赖焦点位置），
  // 若浏览器拒绝了 Clipboard API，再退回 paste 事件兜底
  // （页面上有可粘贴目标时这条能work）。
  if (t.paste && t.pasteShortcut && t.pasteShortcut !== 'none') {
    let armed = false;
    let armTimer = null;

    const disarm = () => {
      armed = false;
      clearTimeout(armTimer);
    };

    window.addEventListener(
      'keydown',
      (e) => {
        if (!matchShortcut(e, t.pasteShortcut)) return;

        // 按下快捷键时页面内不该再触发原有的粘贴行为，
        // 否则剪贴板里的图片会被网页编辑器/搜索框吃掉。
        e.preventDefault();
        e.stopPropagation();

        disarm();
        readClipboardImage().then((blob) => {
          if (blob) return;
          // 读不到就上膛，等paste 事件兜底
          armed = true;
          armTimer = setTimeout(disarm, 800);
        });
      },
      true
    );

    window.addEventListener(
      'paste',
      (e) => {
        if (!armed) return;
        disarm();
        if (grabFromClipboard(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  }

  // 兜底：面板内的粘贴走这条路径（面板是扩展页面，不受网页拦截影响）。
  // 网页里不装这条 —— 那是用户的设置开关要管的范围。
}

install();