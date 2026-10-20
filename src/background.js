/**
 * Service worker：串起取图层 → 字段层 → 渲染层
 */

import { resolveRatio, normalizeFields } from './core/schema.js';
import { reverseImage, getSettings, resolveProvider } from './core/api.js';
import { saveRecord, findByFingerprint, fingerprint, listRecords } from './core/store.js';
import { listPresets, getActiveId, setActiveId } from './core/presets.js';

/**
 * 切换到下一个提示词方案。
 *
 * 放在 SW 而不是面板里，是因为 chrome.commands 只在后台上下文触发 ——
 * 面板关着时按快捷键也得能切（用户下一批图要换个方案，
 * 不该先开个窗口）。SW 改完存储，面板下次渲染自然跟上。
 *
 * 徽标反馈：快捷键没有「按了」的视觉反馈，用户会怀疑没生效。
 * 短暂显示当前方案的序号（1/2/3），1.5 秒后清掉。
 */
async function cyclePreset() {
  const all = await listPresets();
  if (all.length < 2) {
    await flashBadge('1');
    return;
  }
  const cur = await getActiveId();
  const idx = all.findIndex((p) => p.id === cur);
  const next = all[((idx < 0 ? 0 : idx) + 1) % all.length];

  await setActiveId(next.id);
  await flashBadge(String(all.indexOf(next) + 1));
}

async function flashBadge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#2E7D5B' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 1500);
  } catch {
    // 徽标是纯反馈，失败不该影响切换本身
  }
}

chrome.commands?.onCommand.addListener((cmd) => {
  if (cmd === 'cycle-preset') cyclePreset().catch(() => {});
  // copy-prompt 由面板自己处理（需要拿到当前 textarea 的文本），
  // 这里只把消息转过去，面板开着才转。
  if (cmd === 'copy-prompt') {
    chrome.runtime
      .sendMessage({ type: 'PR_COPY_PROMPT' })
      .catch(() => {});
  }
});

/** 当前激活的提示词方案名，用于在记录里留痕 */
async function currentPresetName() {
  try {
    const id = await getActiveId();
    const all = await listPresets();
    return all.find((p) => p.id === id)?.name || '默认';
  } catch {
    return '默认';
  }
}

/** 取标签页当前页面地址 —— 这是「网站名」的真实来源 */
async function pageUrlOf(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || '';
  } catch {
    return '';
  }
}

/**
 * 已知 CDN / 图床域名。
 *
 * 这些域名前缀看着像站点，其实只是图片存放处 ——
 * 从 i.pinimg.com 提取出的「Pinimg」不是网站名，而是图片站。
 * 命中就说明 originUrl 指向 CDN，此时应改用 tab 的页面地址。
 */
const CDN_HOST_HINTS = [
  'pinimg', 'xhscdn', 'imgix', 'cdninstagram', 'fbcdn', 'licdn',
  'cloudfront', 'akamaized', 'alicdn', 'qiniucdn', 'byteimg',
  'gtimg', 'sinaimg', 'douyinpic', 'douyincdn', 'pstatp', 'yimg',
];

/** 判断域名是否像 CDN / 图床 */
function looksLikeCdn(host) {
  const h = String(host || '').toLowerCase();
  return CDN_HOST_HINTS.some((k) => h.includes(k));
}

/**
 * 从图片 URL 提取网站名。
 *
 * 取主机名去掉 www. 与后缀 ——「www.pinterest.com」→「Pinterest」。
 * 二级后缀（co.uk / com.cn）要连同主域一起保留，
 * 否则 example.co.uk 会只剩「Co」。
 */
function siteNameFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw || raw === 'local' || !/^https?:\/\//i.test(raw)) return '';
  try {
    let host = new URL(raw).hostname.toLowerCase();
    host = host.replace(/^www\./, '');
    if (!host) return '';

    const parts = host.split('.');
    if (parts.length < 2 || /^\d/.test(parts[parts.length - 1])) return '';

    // example.co.uk → example（只取主域）
    const tail2 = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'];
    const second = parts[parts.length - 2];
    const main = tail2.includes(second) && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
    if (!main || /^\d/.test(main)) return '';

    return main.charAt(0).toUpperCase() + main.slice(1);
  } catch {
    return '';
  }
}

/**
 * 本分钟内同站点的序号。
 *
 * 刻意只按同站计数：连续反推一批 Pinterest 图会得到 001、002、003，
 * 序号本身有可读性。跨站共用一个计数会让数字失去意义。
 *
 * SW 会被回收，所以这个计数是**尽力而为**——重启后可能重新从 001 开始。
 * 序号已随记录落库，展示时用的是存下来的值，不会变。
 */
let nameSeqMap = new Map();

function nextNameSeq(createdAt, siteName) {
  const d = new Date(createdAt || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  const key =
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `${p2(d.getHours())}${p2(d.getMinutes())}-${siteName || '本地'}`;
  const next = (nameSeqMap.get(key) || 0) + 1;
  nameSeqMap.set(key, next);

  // 只保留最近两小时，避免长时间运行后无限增长
  if (nameSeqMap.size > 500) {
    nameSeqMap = new Map([...nameSeqMap].slice(-200));
  }
  return next;
}

const MENU_ID = 'pr-reverse-image';   // 唯一的菜单项 id
const MENU_TITLE = '用拾光反推提示词';
const MAX_EDGE = 1024;

/**
 * 两个菜单项，配合使用：
 *
 * contexts:['image'] —— Chrome 会填 info.srcUrl，这是最可靠的定位方式。
 *   但只有鼠标悬停在 <img>/<area> 上才显示。
 *
 * contexts:['all'] —— 任意位置都显示，能覆盖 background-image 容器，
 *   但 **info.srcUrl 会被置空**，只能靠右键坐标 / 元素标记定位。
 *
 * 之前只用 ['all']，代价是丢掉了 srcUrl，于是依赖坐标和标记 ——
 * 而 Pinterest 首页 DOM 复用频繁，标记会命中错误的元素，表现为
 * 「点哪张都是同一张」。所以现在两个都给：有 img 时用带 srcUrl 的那个。
 */
/**
 * 菜单创建（幂等）。
 *
 * 为什么必须幂等：service worker 顶层代码每次唤醒都会重跑，
 * 而 contextMenus.create 是异步的、removeAll 也有延迟。
 * 并发唤醒时会出现「removeAll 还没执行完 → 又跑一次 → create 重复 id」，
 * 报错 `Cannot create item with duplicate id`。
 *
 * 两个保障：
 *   1. 串行队列 menuQueue —— 同一时刻只跑一个创建流程
 *   2. 创建前先查是否已存在，存在就跳过（真正的幂等）
 */
let menuQueue = Promise.resolve();

function scheduleMenuSync() {
  menuQueue = menuQueue
    .catch(() => {})
    .then(syncMenus);
  return menuQueue;
}

async function syncMenus() {
  const { contextMenu } = await chrome.storage.local.get('contextMenu');

  // 先清空再建。removeAll 有回调，必须等它完成 ——
  // 否则会在旧菜单还在时create 同 id，触发 duplicate id 报错。
  await new Promise((resolve) => {
    try {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });

  // 用户关掉了右键菜单，就不建
  if (contextMenu === false) return;

  buildMenus();
}

function buildMenus() {
  const make = (props) => {
    try {
      chrome.contextMenus.create(props, () => {
        // 重复 id 或其他失败会写到 lastError，读掉即可避免控制台报未捕获
        void chrome.runtime.lastError;
      });
    } catch {
      /* 已存在等情况忽略 */
    }
  };

  // 只建一个菜单项，任意位置右键都出现。
  //
  // contexts 同时列 'image' 和 'all'：'all' 保证在 background-image
  // 容器、空白处也出现；带 'image' 则右键真图片时 Chrome 仍会填
  // info.srcUrl，那是定位最可靠的线索（页面上找不到对应 <img> 时可
  // 直接用它）。只有 'all' 的话 srcUrl 恒为空，就只能靠坐标猜了。
  //
  // 刻意不设 documentUrlPatterns —— 它只认 http/https/file/ftp 等标准
  // 协议，而小红书的大图弹层常用 blob: / data: URL 或独立 iframe，
  // 加上这个限制会导致「首页能右键、反推失败」，大图页则菜单根本不出现。
  // 不限制的代价是chrome:// 页面也会显示菜单，但扩展在那些页面
  // 本来就无法注入，用户不会误用。
  make({
    id: MENU_ID,
    title: MENU_TITLE,
    contexts: ['image', 'all'],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleMenuSync();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleMenuSync();
});

// service worker 每次被唤醒都会重新执行顶层代码 —— contextMenus 在休眠后会丢，
// 必须补建。走同一队列避免并发重复创建。
scheduleMenuSync();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab?.id) return;

  // 先看有没有待处理的拖拽/粘贴图片 —— 消息通道失效时它还在
  if (await grabDropped(tab.id)) return;

  await runFromUrl({
    srcUrl: info.srcUrl || '',
    pageUrl: info.pageUrl,
    tabId: tab.id,
    // srcUrl 非空说明 Chrome 已识别出右键目标是图片，这是最可靠的定位来源。
    // 为空（点在 background-image 容器或页面空白）时退到标记 + 几何命中。
    preferSrcUrl: Boolean(info.srcUrl),
  });
});

/**
 * 拖拽 / 粘贴入口。
 *
 * 两条通道并行，因为它们各自的失效原因不同：
 *   1. 消息通道（chrome.runtime.sendMessage）—— SW 刚被唤醒时监听器
 *      可能尚未就绪，且 channel 的失败会被.catch 静默吞掉。
 *   2. 共享对象（window.__PR_PASTED__）—— content.js 与注入函数共享
 *      同一个隔离世界，这个通道不依赖任何监听器。
 * 任一成功即可，两条都失败才算真的失败。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PR_IMAGE_READY') {
    const tabId = sender.tab?.id;
    if (tabId) {
      // 不 await，让消息通道立刻返回；真实处理独立进行
      handleDataUrl(msg.dataUrl, msg.mime, tabId);
    }
    sendResponse({ ok: true });
    return true; // 保持通道开放
  }

  // 设置页点了「打开面板」—— 空载荷，只把面板窗口显示出来。
  //
  // 此前打开面板的唯一途径是右键图片，那必然带着一次反推，
  // 导致「只想看看之前存了什么」也必须先随便找张图反推一次。
  //
  // 用 bare:true 而不是 {}：面板正开着时若把 prPanel 覆写成空对象，
  // 用户正在看的结果会被清掉。「打开面板」不该有副作用。
  if (msg?.type === 'PR_OPEN_PANEL') {
    openPanel({ bare: true }).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
    );
    return true;
  }

  // 设置页保存后重建右键菜单 —— 用户可能刚把右键开关打开或关掉
  if (msg?.type === 'PR_SETTINGS_CHANGED') {
    scheduleMenuSync().then(() => sendResponse({ ok: true }));
    return true;
  }

  // content.js 自绘菜单项被点击 —— 等价于点了扩展菜单项。
  // 页面自己画右键菜单时原生菜单不会出现，只能走这条路。
  if (msg?.type === 'PR_REVERSE_AT') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: '无法定位标签页' });
      return true;
    }
    runFromUrl({
      srcUrl: msg.srcUrl || '',
      pageUrl: sender.tab?.url || '',
      tabId,
      preferSrcUrl: Boolean(msg.srcUrl),
    }).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
    );
    return true;
  }

  // 面板请求「重新反推」—— 需要 SW 手里还留着这张图的 dataUrl
  if (msg?.type === 'PR_FORCE_REVERSE') {
    forceReverseCurrent().then(
      (r) => sendResponse({ ok: true, result: r }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
    );
    return true;
  }

  // 面板请求展示某条历史记录的完整内容（列表里只存了摘要）
  if (msg?.type === 'PR_GET_RECORD') {
    getRecordById(msg.id).then(
      (r) => sendResponse({ ok: true, record: r }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  return undefined;
});

/** 主动去页面里捞拖拽/粘贴的图片。所有 frame 都要查 —— 图片可能在 iframe 里 */
async function grabDropped(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: takeDroppedInPage,
      args: [],
    });
    for (const r of results) {
      const got = r?.result ?? null;
      if (got?.dataUrl) {
        await handleDataUrl(got.dataUrl, got.mime, tabId);
        return true;
      }
    }
  } catch {
    /* 页面可能正在跳转 */
  }
  return false;
}

/**
 * 在页面里取走待处理的拖拽/粘贴图片（取走即清空，避免重复处理）。
 * 被序列化注入，不能引用外部作用域。
 */
function takeDroppedInPage() {
  try {
    const p = window.__PR_PASTED__;
    if (!p || !p.dataUrl) return null;
    window.__PR_PASTED__ = null;
    return { dataUrl: p.dataUrl, mime: p.mime || 'image/jpeg' };
  } catch {
    return null;
  }
}

/**
 * 取图主流程。
 *
 * 架构要点：不用 content script 的 message 通道做取图。
 * chrome.scripting.executeScript 注入的脚本内部抛错时 **不会 reject**，
 * 它照样 resolve，于是「注入成功」的假象会掩盖「监听器根本没注册」，
 * 后面的 sendMessage 必然失败。改成用 func 直接在页面里执行并返回结果，
 * 不依赖任何监听器，也就不存在这个问题。
 */
async function runFromUrl({ srcUrl, pageUrl, tabId, preferSrcUrl }) {
  // 1. 在页面里执行取图函数，直接拿回结果
  let resolved = null;
  let resolveError = null;

  try {
    // 所有 frame 都要跑：小红书瀑布流 / Pinterest 卡片大量用 iframe，
    // 只注入主框架会拿不到 iframe 里的图。
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: resolveImageInPage,
      args: [srcUrl || '', Boolean(preferSrcUrl)],
    });

    // 多个 frame 各自返回结果，按「定位可信度」排序取最优。
    //
    // 关键：不能按 frameId 挑。之前「优先 iframe 命中」的规则是错的 ——
    // Pinterest 图片在主框架里，而 iframe 里恰好有一张固定的图
    // （广告位、推荐位），于是每次都选它，表现就是「每次都是同一张」。
    //
    // 可信度排序（source 越具体越可信）：
    //   browser   Chrome 明确告诉我们的右键目标
    //   attr      data-* 原图属性命中
    //   cursor    右键标记/坐标命中
    //   dom       页面里匹配到 srcUrl
    //   background/picture/video-poster  结构性推断
    //   scan      兜底扫描（取面积最大）—— 最不可信
    const RANKS = {
      browser: 100,
      attr: 90,
      cursor: 80,
      dom: 70,
      picture: 60,
      'video-poster': 55,
      background: 50,
      scan: 10,
    };

    const hits = results
      .map((r) => ({ frameId: r.frameId, v: r.result }))
      .filter((x) => x.v && x.v.url)
      .map((x) => ({ ...x, rank: RANKS[x.v.source] ?? 40 }))
      .sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank;
        // 同分时优先主框架 —— 子框架里的 scan 结果往往与右键目标无关
        const af = a.frameId || 0;
        const bf = b.frameId || 0;
        if (af !== bf) return af - bf;
        return 0;
      });

    if (hits.length) {
      resolved = { ...hits[0].v, frameId: hits[0].frameId, rank: hits[0].rank };
      // 取图来源标记，便于用户判断走的是哪条路径
      resolved.debug = `${resolved.source}${hits[0].frameId ? `@f${hits[0].frameId}` : ''}`;
    } else {
      resolveError =
        results[0]?.result?.error || '未能定位图片，请刷新页面后重试';
    }
  } catch (e) {
    resolveError = describeInjectError(e);
  }

  if (!resolved?.url) {
    await openPanel({
      error: resolveError || '未能定位图片，请刷新页面后重新右键一次',
    });
    return;
  }

  // 2. 取图。四级策略逐级降级：
  //    canvas 像素 → 页面 fetch → 截屏 → SW 直取
  // 取图。候选地址按优先级排列，逐个尝试直到拿到原图。
  //
  // 两个候选的分工：
  //   pageUrl —— 页面正在用的地址。带时效签名时只有它有效，但可能已被 CDN
  //              压缩成缩略图
  //   url     —— 剥离 CDN 后缀的原图地址。画质更高，但签名可能已被破坏
  //
  // 顺序上先试页面地址：它现在是有效的（签名还在），只是尺寸小些。
  // 拿不到再试剥离后的原图地址。
  const candidates = [];
  if (resolved.pageUrl && resolved.pageUrl !== resolved.url) candidates.push(resolved.pageUrl);
  candidates.push(resolved.url);

  let dataUrl = null;
  let via = '';
  let usedUrl = '';
  let diag = [];

  for (const cand of candidates) {
    if (!cand) continue;
    let r = null;
    try {
      r = await fetchInPage(tabId, cand, resolved.rect, resolved.frameId || 0, pageUrl);
    } catch {
      /* fetchInPage 内部已逐级降级 */
    }
    diag = diag.concat(r?.diag || []);
    if (r?.dataUrl) {
      dataUrl = r.dataUrl;
      via = r.via;
      usedUrl = cand;
      break;
    }
  }

  if (!dataUrl) {
    // 去重后展示失败原因
    const seen = new Set();
    const uniq = diag.filter((d) => {
      const k = d.name + d.note;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const reasons = uniq.map((d) => `${d.name}：${d.note}`).join('；');
    await openPanel({
      error: `无法取到该图片。${reasons || '所有取图方式均失败'}`,
      diag: uniq,
    });
    return;
  }

  const VIA_LABEL = {
    original: '原图',
    direct: '扩展直取',
    canvas: '画布像素（渲染尺寸）',
    screenshot: '屏幕截图（渲染尺寸）',
    viewport: '整屏截图（渲染尺寸）',
    fetch: '页面请求',
  };

  const meta = {
    originUrl: usedUrl || resolved.url,
    // 页面地址单独存一份。originUrl 是**图片本身的地址**，
    // 往往指向 CDN（i.pinimg.com、sns-webpic-qc.xhscdn.com…），
    // 从它提取域名只会得到图片站而非来源网站。
    // runFromUrl 的入参里已有 pageUrl，直接用；拿不到时才回查 tab。
    pageUrl: pageUrl || (await pageUrlOf(tabId)),
    width: resolved.w,
    height: resolved.h,
    source: `${resolved.debug || resolved.source}+${VIA_LABEL[via] || via}`,
  };

  // 暂存图片，面板点「重新反推」时直接复用，不必再走一次取图
  await stashPending(dataUrl, meta, tabId);

  try {
    await processImage(dataUrl, meta);
  } catch (e) {
    await openPanel({ error: describeFetchError(e, resolved.url) });
  }
}

/**
 * 截屏兜底：把图片所在区域截下来。
 *
 * 防盗链站点的终解：浏览器已经把这张图渲染在屏幕上了，
 * captureVisibleTab 直接读像素，完全不需要再发网络请求。
 * 代价是只能拿到屏幕分辨率（而非原始分辨率），
 * 但对提示词反推来说够用 —— 1024 长边的截图足够模型看清光线和构图。
 */
/**
 * 安全截图。
 *
 * **第一个参数是 windowId，不是 tabId。** 这是本函数最关键的一点：
 * `chrome.tabs.captureVisibleTab(windowId, options)` 的签名只接受窗口 id，
 * 传 tabId 会被当成 windowId 去查，报 `No window with id: <tabId>` ——
 * 错误信息看着像「窗口被销毁」，实际是参数类型不匹配。
 *
 * 另一个坑：只能截「当前活动窗口」，目标标签页不在活动窗口时要先激活。
 */
async function safeCapture(tabId) {
  // 关键：captureVisibleTab 的第一个参数是 **windowId**，不是 tabId。
  // 传错成tabId 时 Chrome 会当成 windowId 去找，报
  // `No window with id: <tabId>` —— 看起来像「窗口被销毁」，
  // 实际是参数类型不匹配。之前一直因此认为截屏不可用。
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { error: '标签页已关闭' };
  }
  if (!tab) return { error: '标签页不存在' };

  const windowId = tab.windowId;

  // 先尝试直接截 —— 多数情况下目标窗口就是活动窗口
  try {
    const d = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (d) return { dataUrl: d };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/No tab with id/i.test(msg)) return { error: '标签页已关闭' };
    // 其他错误继续尝试下面的恢复流程
  }

  // 恢复：把标签页所在窗口激活后再试
  try {
    await chrome.windows.update(windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    // 等一帧，确保渲染完成
    await new Promise((r) => setTimeout(r, 120));
  } catch {
    /* 恢复失败也继续试截屏 */
  }

  try {
    const d = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { dataUrl: d, restored: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/No tab with id/i.test(msg)) return { error: '标签页已关闭' };
    if (/No window with id/i.test(msg)) return { error: '窗口已销毁' };
    if (/Cannot access contents/i.test(msg)) return { error: '无截屏权限' };
    return { error: `截屏失败：${msg.slice(0, 80)}` };
  }
}

/**
 * 截屏兜底：把图片所在区域截下来。
 *
 * 防盗链站点的终解：浏览器已经把这张图渲染在屏幕上了，
 * captureVisibleTab 直接读像素，完全不需要再发网络请求。
 *
 * 失败原因细分后写进诊断日志 —— 之前笼统报「图片不在可视区域内」，
 * 掩盖了真实原因（焦点问题 / 权限问题 / rect 无效）。
 */
async function captureRect(tabId, rect) {
  if (!rect) return { dataUrl: null, reason: '拿不到图片的屏幕位置（rect 为空）' };
  if (rect.w < 8 || rect.h < 8) {
    return { dataUrl: null, reason: `图片矩形过小 ${Math.round(rect.w)}×${Math.round(rect.h)}` };
  }

  const shot = await safeCapture(tabId);
  if (!shot?.dataUrl) {
    return { dataUrl: null, reason: shot?.error || '截屏返回空' };
  }
  const dataUrl = shot.dataUrl;

  const vp = await getViewport(tabId);
  if (!vp?.w) return { dataUrl: null, reason: '读不到页面视口尺寸' };

  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    // 截屏按 devicePixelRatio 缩放过，用「截屏宽 / 视口宽」反推比例
    const ratio = bitmap.width / vp.w;
    const sx = Math.max(0, Math.round(rect.x * ratio));
    const sy = Math.max(0, Math.round(rect.y * ratio));
    const sw = Math.min(Math.round(rect.w * ratio), bitmap.width - sx);
    const sh = Math.min(Math.round(rect.h * ratio), bitmap.height - sy);

    if (sw <= 8 || sh <= 8) {
      const why =
        rect.x * ratio > bitmap.width
          ? '图片位于视口右侧之外（页面可能已横向滚动）'
          : rect.y * ratio > bitmap.height
            ? '图片位于视口下方之外（可能未滚动到可见）'
        : '裁剪区域过小';
      bitmap.close?.();
      return { dataUrl: null, reason: why };
    }

    const MAX = 1024;
    const downscale = Math.min(1, MAX / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * downscale));
    const h = Math.max(1, Math.round(sh * downscale));

    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
    bitmap.close?.();

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return { dataUrl: await blobToDataUrl(blob), reason: null };
  } catch (e) {
    return { dataUrl: null, reason: '截屏解码失败：' + String((e && e.message) || e).slice(0, 80) };
  }
}

/**
 * 整屏截取的兜底：坐标裁剪失败时用。
 *
 * 何时会走到：容器用了 CSS transform（scale 过的缩略图很常见），
 * getBoundingClientRect 拿到的是变换后的矩形，与截图像素对不上，
 * 裁出来是空的或只有一角。整屏截取至少能让模型看到图，
 * 比完全失败强 —— 提示词反推不依赖像素级精确。
 */
async function captureViewport(tabId) {
  try {
    const shot = await safeCapture(tabId);
    if (!shot?.dataUrl) return null;
    const dataUrl = shot.dataUrl;
    const vp = await getViewport(tabId);
    if (!vp?.w) return null;
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());

    // 缩到长边 1024，控制 token
    const MAX = 1024;
    const downscale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * downscale));
    const h = Math.max(1, Math.round(bitmap.height * downscale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

/** 读页面视口宽高（缓存，避免每次都注入查询） */
let viewportCache = { key: '', value: null };
async function getViewport(tabId) {
  const k = String(tabId);
  if (viewportCache.key === k && viewportCache.value) return viewportCache.value;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => ({ w: window.innerWidth, h: window.innerHeight }),
    });
    const v = r?.result;
    if (v?.w) {
      viewportCache = { key: k, value: v };
      return v;
    }
  } catch {}
  return null;
}
/**
 * 在页面上下文里取图。四级策略，逐级降级。
 *
 * 1. canvas 快照 —— 最可靠。图片已经渲染在页面里，直接从 `<img>` 读像素，
 *    完全不过网络。唯一的限制是 CORS：若图片服务器没发
 *    `Access-Control-Allow-Origin`，canvas 会被污染（tainted）读不出来。
 *    但小红书 / Pinterest 的图片 CDN 通常都发 CORS 头，所以这条一般能成。
 * 2. 页面内 fetch —— canvas 不可用时试这个。Referer 是页面 URL，能过防盗链；
 *    但跨域 fetch 要么被 CORS 拦、要么 403。
 * 3. 截屏快照 —— 浏览器已经把这张图渲染在屏幕上了，截屏直接读像素，
 *    完全不需要再发请求，对防盗链是终解。代价是只有屏幕分辨率。
 * 4. SW 直取 —— 最后兜底，Referer 是 extension 域名，防盗链站点必 403。
 *
 * 之前只做了 2 和 4，403 时没有任何转圜余地。加上 1 和 3 才是完整解法。
 */
/**
 * 取图：原图优先，逐级降级。
 *
 * 目标统一为「拿到原图」。之前混着 canvas 像素 / 页面 fetch / 截屏 /
 * SW 直取四条路径，语义不清 —— canvas 和截屏拿到的都是屏幕分辨率的
 * 渲染结果，不是原图。现在把「原图」作为唯一目标，只有它彻底拿不到
 * 才退到渲染像素兜底。
 *
 * 顺序：
 *   1. 页面内 fetch 原图  —— 唯一能同时绕过防盗链 + 拿到原图的路径
 *   2. SW 带正确 Referer 直取 —— 页面 fetch 被 CORS 拦时的补充
 *   3. 画布像素（渲染尺寸，非原图）
 *   4. 屏幕截图（渲染尺寸，非原图，最后手段）
 *
 * @param frameId 定位成功的那个 frame。只在该 frame 里取像素 ——
 *   之前对所有 frame 都跑一遍 canvas，子框架里找不到图就退化成
 *   「取页面最大图」，然后被误选成结果，表现为「反推的不是我选的那张」。
 */
async function fetchInPage(tabId, url, rect, frameId, pageUrl) {
  const diag = [];
  const step = (name, ok, note) => {
    diag.push({ name, ok: !!ok, note });
    return ok;
  };

  // ---- 1. 页面内 fetch 原图（首选）----
  // 在页面上下文发请求：Referer 是页面 URL，能过防盗链；
  // 用 cors 模式但拿不到响应时自动退回 no-cors 拿 opaque blob。
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      world: 'ISOLATED',
      func: fetchOriginalInPage,
      args: [url],
    });
    const got = results?.[0]?.result;
    if (got?.dataUrl) {
      step('原图请求', true, got.width && got.height ? `${got.width}×${got.height}` : '');
      return { dataUrl: got.dataUrl, via: 'original', diag };
    }
    step('原图请求', false, got?.reason || '页面内取原图失败');
  } catch (e) {
    const msg = String((e && e.message) || e);
    step(
      '原图请求',
      false,
      /frame/i.test(msg) ? '目标框架已消失' : '无法在页面中执行脚本'
    );
  }

  // ---- 2. SW 带正确 Referer 直取 ----
  // 页面 fetch 被 CORS 拦住时，SW 直取反而可能成功：
  // 扩展的 fetch 能带任意 Referer，小红书认的是 Referer 白名单而非来源。
  try {
    const d = await fetchAsDataUrl(url, pageUrl);
    if (d) {
      step('扩展直取', true);
      return { dataUrl: d, via: 'direct', diag };
    }
    step('扩展直取', false, '服务器拒绝访问');
  } catch (e) {
    step('扩展直取', false, describeFetchError(e, url).slice(0, 40));
  }

  // ---- 3. 画布像素（非原图，仅兜底）----
  try {
    const target = frameId || 0;
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [target] },
      world: 'ISOLATED',
      func: snapshotCanvasInPage,
      args: [url, rect || null],
    });
    for (const r of results) {
      const got = r?.result;
      if (got?.dataUrl) {
        step('画布像素', true, '渲染分辨率，非原图');
        return { dataUrl: got.dataUrl, via: 'canvas', diag };
      }
      if (got?.tainted) step('画布像素', false, '图片未开放跨域（canvas 被污染）');
      else if (got?.error) step('画布像素', false, got.error);
    }
    step('画布像素', false, '该框架内未找到已加载的图片');
  } catch (e) {
    const msg = String((e && e.message) || e);
    step('画布像素', false, /frame/i.test(msg) ? '目标框架已消失' : '无法执行脚本');
  }

  // ---- 4. 屏幕截图（最后手段，非原图）----
  // 注意必须在 openPanel 之前执行：captureVisibleTab 只能截活动标签页，
  // 面板 popup 一旦抢焦点就截不到了。
  if (!rect) {
    step('屏幕截图', false, '拿不到图片的屏幕位置，改用整屏截图');
    const full = await captureViewport(tabId);
    if (full) {
      step('整屏截图', true, '渲染分辨率，非原图');
      return { dataUrl: full, via: 'viewport', diag };
    }
    step('整屏截图', false, '截屏失败');
  } else {
    const shot = await captureRect(tabId, rect);
    if (shot?.dataUrl) {
      step('屏幕截图', true, '渲染分辨率，非原图');
      return { dataUrl: shot.dataUrl, via: 'screenshot', diag };
    }
    step('屏幕截图', false, shot?.reason || '截图失败，改用整屏');
    const full = await captureViewport(tabId);
    if (full) {
      step('整屏截图', true, '渲染分辨率，非原图');
      return { dataUrl: full, via: 'viewport', diag };
    }
    step('整屏截图', false, '截屏失败');
  }

  return { dataUrl: null, via: '', diag };
}

/**
 * 在页面上下文取原图。**被序列化注入，不能引用外部作用域。**
 *
 * 两种模式依次尝试：
 *   1. cors —— 服务端有 ACAO 头时能读到真实尺寸与原图字节
 *   2. no-cors —— 拿 opaque response，blob 仍可用（opaque 的
 *      content-type 为空，但二进制是完整的），可画进 canvas 读像素
 *
 * no-cors 是绕防盗链的关键：请求照发（Referer 正确），服务器返 200，
 * 只是浏览器不让 JS 看响应头。而图片字节本身是完整的。
 */
function fetchOriginalInPage(url) {
  return (async () => {
    const MAX = 1024;

    const shrink = (bitmap) => {
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.92);
    };

    // 路径 1：cors
    try {
      const res = await fetch(url, { credentials: 'include', mode: 'cors' });
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size > 1024) {
          const bmp = await createImageBitmap(blob);
          const dataUrl = shrink(bmp);
          bmp.close?.();
          if (dataUrl) {
            return { dataUrl, width: 0, height: 0, cors: true };
          }
        }
      }
    } catch {
      /* cors 不可用，走 no-cors */
    }

    // 路径 2：no-cors —— opaque 响应，字节完整
    try {
      const res = await fetch(url, { credentials: 'include', mode: 'no-cors' });
      // opaque 响应 type 为 'opaque'，status 为 0，这是正常现象
      const blob = await res.blob();
      if (!blob || blob.size <= 1024) {
        return { dataUrl: null, reason: '原图请求返回空内容' };
      }
      // opaque blob 的 type 是空字符串，createImageBitmap 仍能按内容解码
      const bmp = await createImageBitmap(blob);
      const dataUrl = shrink(bmp);
      const w = bmp.width;
      const h = bmp.height;
      bmp.close?.();
      if (dataUrl) return { dataUrl, width: w, height: h, cors: false };
      return { dataUrl: null, reason: '原图无法转换为位图' };
    } catch (e) {
      return { dataUrl: null, reason: 'no-cors 请求失败：' + String((e && e.message) || e).slice(0, 60) };
    }
  })();
}

/**
 * 从已渲染的 `<img>` 用 canvas 取像素。
 * 被序列化注入，不能引用外部作用域。
 *
 * 定位方式优先用**几何坐标**而非 URL 匹配 ——
 * 传进来的 url 是剥离过 CDN 后缀的（/originals/、!nd_已删），
 * 与页面里 `<img>` 的 currentSrc 根本不同，按 URL 匹配必然失败。
 * 几何坐标则一定是页面真实渲染出来的那个元素，100% 可靠。
 *
 * 返回 { dataUrl, tainted } —— tainted 为 true 表示 CORS 污染，
 * canvas.toDataURL() 抛SecurityError，此时由调用方降级。
 */
function snapshotCanvasInPage(url, rect) {
  return new Promise((resolve) => {
    try {
      const imgs = Array.from(document.images || []);

      // 几何定位：取与 rect 重叠最大的可见 img。
      // 评分与解析层resolveImageInPage.seekByGeometry 完全一致，
      // 避免「定位到了 A 图、取像素时取到 B 图」这种错位。
      let target = null;

      if (rect && rect.w > 0 && rect.h > 0) {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        let bestScore = -1;
        for (const img of imgs) {
          if (!img.naturalWidth) continue;
          const r = img.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;

          const cxIn = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
          const ox = Math.max(
            0,
            Math.min(r.right, rect.x + rect.w) - Math.max(r.left, rect.x)
          );
          const oy = Math.max(
            0,
            Math.min(r.bottom, rect.y + rect.h) - Math.max(r.top, rect.y)
          );
          const overlap = ox * oy;
          if (overlap <= 0) continue;

          // 中心命中权重最高；重叠相同时取渲染面积更小的（最上层那张）
          const score = (cxIn ? 1e12 : 0) + overlap * 1000 - r.width * r.height;
          if (score > bestScore) {
            bestScore = score;
            target = img;
          }
        }
      }

      if (!target && url) {
        const key = String(url).split(/[?!#]/)[0];
        const tail = key.split('/').pop();
        target =
          imgs.find((i) => (i.currentSrc || '').split(/[?!#]/)[0] === key) ||
          imgs.find((i) =>
            (i.currentSrc || i.src || '').split(/[?!#]/)[0].endsWith(tail)
          ) ||
          null;
      }

      if (!target || !target.naturalWidth) {
        return resolve({ dataUrl: null, error: '页面中未找到已加载的图片' });
      }

      const MAX = 1024;
      const scale = Math.min(
        1,
        MAX / Math.max(target.naturalWidth, target.naturalHeight)
      );
      const w = Math.max(1, Math.round(target.naturalWidth * scale));
      const h = Math.max(1, Math.round(target.naturalHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(target, 0, 0, w, h);

      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.92) });
    } catch (e) {
      // SecurityError = canvas 被 CORS 污染，交给调用方降级到截屏
      resolve({
        dataUrl: null,
        tainted: true,
        error: String((e && e.message) || e),
      });
    }
  });
}

/**
 * 在页面上下文执行的取图函数。
 *
 * 会被序列化后注入，不能引用外部作用域的任何变量或函数——
 * 所有依赖必须在这里重新声明。这也是刻意不用 message 通道的原因。
 *
 * @param {string} srcUrl        右键目标 img 的 URL（contexts:['image'] 时 Chrome 才会填）
 * @param {boolean} preferSrcUrl  true 表示来自 image 菜单项，srcUrl 必然可靠
 */
function resolveImageInPage(srcUrl, preferSrcUrl) {
  const out = (o) => ({ ok: true, w: 0, h: 0, ...o });

  try {
    // --- 工具：srcset 取最大 ---
    const pickLargest = (srcset) => {
      const items = String(srcset)
        .split(',')
        .map((s) => s.trim().split(/\s+/))
        .filter((p) => p[0]);
      if (!items.length) return null;
      const best = items.sort(
        (a, b) => (parseInt(b[1], 10) || 0) - (parseInt(a[1], 10) || 0)
      )[0];
      try {
        return new URL(best[0], location.href).href;
      } catch {
        return best[0];
      }
    };

    const abs = (u) => {
      try {
        return new URL(u, location.href).href;
      } catch {
        return u;
      }
    };

    /**
     * 剥离 CDN 缩放后缀，尽量拿原图。
     *
     * 原则：**宁可少剥离，也不能破坏签名。**
     *
     * 小红书 `sns-webpic-*` 的地址在 `!` 之后是
     * 「格式指令 + 时效签名」的复合体（有效期约 1 分钟）：
     *   xxx.jpg!nd_dft_wlteh_webp_3tplv-abc-c0_lfpUpWMg9WmP
     * 两者用 `_` / `-` 混连，任何正则都容易切错位置——我试过三种切法，
     * 每种都会啃掉签名的一部分（`!.*$` 连签名一起删；按 `nd_` 匹配会
     * 吃掉分隔符 `_`，签名从 `_3tplv` 变成 `-abc`）。
     *
     * 破坏签名必然 403，而少剥离只是画质差一点 ——
     * 风险收益比完全不划算。所以小红书这段**原样保留**。
     * 取图时会优先用页面实际在用的地址（`pageUrl`），
     * 剥离版仅作为候选之一。
     */
    const stripCdn = (raw) => {
      if (!raw) return raw;
      let u = String(raw).split('#')[0];

      // Pinterest：路径级缩放 /236x/ /736w/ → /originals/
      // 这条安全：改的是路径，不涉及 query 里的签名
      u = u.replace(/\/(?:\d+x|\d+w)\//i, '/originals/');

      // 小红书：仅当 `!` 之后确定是纯格式指令时才剥离
      if (u.includes('!')) {
        const tail = u.slice(u.indexOf('!') + 1);
        const pureFormat =
          /^[a-z0-9_]+$/i.test(tail) && /(?:webp|jpg|jpeg|png|avif)/i.test(tail);
        // 含这些片段说明后面跟着签名，不能动
        const hasSignature =
          /(?:tplv|lfp|wmq|dft|wlteh|spectrum|imgtype)/i.test(tail);
        if (pureFormat && !hasSignature) {
          u = u.slice(0, u.indexOf('!'));
        }
      }

      // 微博等：imageView2 整段都是缩放指令，不含签名，可安全剥离
      if (u.includes('imageView2') || u.includes('/w/')) return u.split('?')[0];

      if (u.includes('?')) {
        const [base, q] = u.split('?');
        // 只剥缩放类参数，token / 签名 / 时间戳一律保留
        const kept = q
          .split('&')
          .filter((kv) => !/^(w|width|imageView2|format)=/i.test(kv));
        return kept.length ? `${base}?${kept.join('&')}` : base;
      }
      return u;
    };

    const ORIG_ATTRS = [
      'data-original', 'data-origin-src', 'data-actualsrc', 'data-lazy-src',
      'data-src', 'data-url', 'data-echo', 'data-image-src', 'data-large',
      'data-big', 'zoomfile',
    ];

    /** 从 img 元素拿最优地址 */
    const fromImg = (img) => {
      let best = null;
      for (const a of ORIG_ATTRS) {
        const v = img.getAttribute(a);
        if (v && /\.(jpe?g|png|webp|gif|avif|bmp|heic)/i.test(v)) {
          best = abs(v);
          break;
        }
      }
      if (!best) {
        const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (ss) best = pickLargest(ss);
      }
      const cur = img.currentSrc || img.src || best;
      if (!cur) return null;

      // 一并带上屏幕矩形 —— 万一 CDN 防盗链导致取不到像素，
      // SW 可以用 captureVisibleTab 截这块区域（浏览器已渲染，不走网络）
      let rect = null;
      try {
        const r = img.getBoundingClientRect();
        if (r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight) {
          rect = {
            x: Math.max(0, r.left),
            y: Math.max(0, r.top),
            w: Math.min(r.width, innerWidth - Math.max(0, r.left)),
            h: Math.min(r.height, innerHeight - Math.max(0, r.top)),
          };
        }
      } catch {}

      return out({
        url: stripCdn(best || cur),
        // 页面实际在用的地址（未剥离）。小红书的 webpic 地址带时效签名，
        // 剥离后的版本未必还有效 —— 两条都给，取图时逐个尝试。
        pageUrl: cur,
        w: img.naturalWidth || 0,
        h: img.naturalHeight || 0,
        source: best ? 'attr' : 'dom',
        rect,
      });
    };

    /** 从元素向上找带 background-image 的容器 */
    const fromBackground = (el) => {
      let node = el;
      let depth = 0;
      while (node && node !== document.documentElement && depth < 12) {
        let bg = '';
        try {
          bg = getComputedStyle(node).backgroundImage;
        } catch {}
        if (bg && bg !== 'none') {
          const m = bg.match(/url\((['"]?)(.*?)\1\)/);
          if (m && m[2] && !m[2].startsWith('data:')) {
            // 背景图场景页面里可能没有 <img>，canvas 快照用不上，
            // 必须带上矩形给截屏兜底
            let rect = null;
            try {
              const r = node.getBoundingClientRect();
              if (r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight) {
                rect = {
                  x: Math.max(0, r.left),
                  y: Math.max(0, r.top),
                  w: Math.min(r.width, innerWidth - Math.max(0, r.left)),
                  h: Math.min(r.height, innerHeight - Math.max(0, r.top)),
                };
              }
            } catch {}
            const raw = abs(m[2]);
            return out({
              url: stripCdn(raw),
              pageUrl: raw,
              source: 'background',
              rect,
            });
          }
        }
        node = node.parentElement;
        depth++;
      }
      return null;
    };

    /** 从命中元素向上找图片，img 优先于背景图 */
    const seekUpward = (start) => {
      if (!start) return null;
      let node = start;
      let depth = 0;
      let bgHit = null;
      let imgHit = null;

      while (node && depth < 14) {
        const tag = (node.tagName || '').toLowerCase();

        if (tag === 'img' && !imgHit) {
          const r = fromImg(node);
          if (r?.url) {
            imgHit = { ...r, source: r.source === 'attr' ? 'attr' : 'cursor' };
            break;
          }
        } else if (tag === 'source' && !imgHit) {
          const v = node.getAttribute('srcset') || node.src;
          const best = v ? pickLargest(v) : null;
          if (best) {
            imgHit = out({ url: stripCdn(best), source: 'cursor' });
            break;
          }
        } else if (tag === 'video' && !bgHit && !imgHit) {
          const poster = node.getAttribute('poster');
          if (poster) {
            bgHit = out({
              url: stripCdn(abs(poster)),
              w: node.videoWidth || 0,
              h: node.videoHeight || 0,
              source: 'cursor',
            });
          }
        }

        if (!bgHit && !imgHit) {
          let bg = '';
          try {
            bg = getComputedStyle(node).backgroundImage;
          } catch {}
          if (bg && bg !== 'none') {
            const m = bg.match(/url\((['"]?)(.*?)\1\)/);
            // linear-gradient(...) 没有 url()，正则不匹配会自然跳过
            if (m && m[2] && !m[2].startsWith('data:')) {
              bgHit = out({ url: stripCdn(abs(m[2])), source: 'cursor' });
            }
          }
        }

        node = node.parentElement;
        depth++;
      }

      // img 优先：它才是用户真正右键的那个元素。
      // Pinterest 卡片是「容器背景图 + 内部 img」，先返回背景图会拿到封面。
      return imgHit || bgHit;
    };

    /**
     * 几何命中：在整页可见 img 里找矩形包含右键坐标的那个。
     *
     * 为什么必须有这一步：Pinterest / 小红书的卡片结构是
     * <a> 里塞多个 <img>，向上遍历到 <a> 时会拿到容器里**第一个** img，
     * 而不是你右键的那个。DOM 层级无法区分同一容器内的兄弟节点，
     * 但几何位置可以 —— 你点在哪张图上，那张图的矩形就包含那个坐标。
     */
    const seekByGeometry = (px, py) => {
      let best = null;
      let fallback = null;
      const imgs = document.querySelectorAll('img');

      for (const img of imgs) {
        let rect;
        try {
          rect = img.getBoundingClientRect();
        } catch {
          continue;
        }
        if (rect.width <= 0 || rect.height <= 0) continue;
        // 点不在矩形内
        if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) continue;

        const r = fromImg(img);
        if (!r?.url) continue;

        const area = rect.width * rect.height;
        const cand = { ...r, area };

        // 小图标（头像、按钮图）另存为 fallback
        if (rect.width < 60 || rect.height < 60) {
          if (!fallback || area < fallback.area) fallback = cand;
          continue;
        }
        // 点在多个候选内时（图片重叠），取面积最小的 —— 那通常是最上层可见的那张
        if (!best || area < best.area) best = cand;
      }

      return best || fallback
        ? { ...(best || fallback), source: 'cursor' }
        : null;
    };

    // --- 路径 A：srcUrl 精确匹配（最可靠，必须排第一）---
    // 来自 contexts:['image'] 菜单项时，Chrome 已经确认用户右键的是哪张图，
    // srcUrl 就是它。必须最先查 —— 标记和坐标都可能因为 DOM 复用而命中错误元素，
    // 这正是 Pinterest 首页「点哪张都是同一张」的成因。
    if (srcUrl) {
      const key = srcUrl.split(/[?!#]/)[0];
      const imgs = Array.from(document.images || []);
      const hit =
        imgs.find((i) => i.currentSrc === srcUrl || i.src === srcUrl) ||
        imgs.find((i) => (i.currentSrc || '').split(/[?!#]/)[0] === key) ||
        imgs.find((i) => (i.currentSrc || i.src || '').split(/[?!#]/)[0].endsWith(key.split('/').pop()));
      if (hit) {
        const r = fromImg(hit);
        if (r?.url) return { ...r, source: preferSrcUrl ? 'browser' : r.source };
      }
      // 页面上找不到对应 img（可能在 iframe 里），但 srcUrl 本身可用
      if (preferSrcUrl) {
        return out({ url: stripCdn(abs(srcUrl)), source: 'browser' });
      }
    }

    // --- 路径 B：右键标记元素命中 ---
    // content.js 在 contextmenu 时给命中的最深元素打了 data-pr-hit 标记。
    // 与 srcUrl 共享同一个隔离世界，不需要消息通道。

    // --- 路径 B：几何命中（最可靠，且不依赖 DOM 层级）---
    // 只有右键光标处这条路径拿不到 srcUrl，必须靠坐标。
    // 先按几何找 —— 它能区分同一容器内的兄弟 img，DOM 向上遍历做不到。
    //
    // 两种坐标都试：视口坐标（与 getBoundingClientRect 同系）和
    // 文档坐标（页面在菜单弹出后滚动过时仍然准）。
    const clickNow = window.__PR_LAST_CLICK__;
    if (clickNow && Date.now() - clickNow.at < 20000) {
      const geo1 = seekByGeometry(clickNow.x, clickNow.y);
      if (geo1?.url) return geo1;

      if (typeof clickNow.pageX === 'number') {
        const geo2 = seekByGeometry(
          clickNow.pageX - window.scrollX,
          clickNow.pageY - window.scrollY
        );
        if (geo2?.url) return geo2;
      }
    }

    const marked = document.querySelector('[data-pr-hit]');
    if (marked) {
      const r = seekUpward(marked);
      if (r?.url) return r;
      // 标记可能打在图片内部的装饰元素上，向下找一层
      const inner = marked.querySelector ? marked.querySelector('img') : null;
      if (inner) {
        const r2 = fromImg(inner);
        if (r2?.url) return r2;
      }
    }

    // --- 路径 C：坐标命中（几何与标记都失败时）---
    if (clickNow) {
      const el = document.elementFromPoint(clickNow.x, clickNow.y);
      if (el) {
        const r = seekUpward(el);
        if (r?.url) return r;
      }
    }

    // --- 路径 C：坐标不可用时的兜底扫描 ---
    const scan = [];
    const collect = (el) => {
      if (!el || scan.length > 400) return;
      const tag = (el.tagName || '').toLowerCase();

      if (tag === 'img') {
        const r = fromImg(el);
        if (r?.url) scan.push(r);
        return;
      }
      if (tag === 'source') {
        const v = el.getAttribute('srcset') || el.src;
        if (v) {
          const best = pickLargest(v);
          if (best) scan.push(out({ url: stripCdn(best), source: 'picture' }));
        }
        return;
      }
      if (tag === 'video') {
        const poster = el.getAttribute('poster');
        if (poster) {
          scan.push(
            out({
              url: stripCdn(abs(poster)),
              w: el.videoWidth || 0,
              h: el.videoHeight || 0,
              source: 'video-poster',
            })
          );
        }
      }
    };

    document.querySelectorAll('img').forEach(collect);

    const sized = scan.filter((r) => r.w >= 200 && r.h >= 200);
    const pool = sized.length ? sized : scan;
    if (pool.length) {
      pool.sort((a, b) => b.w * b.h - a.w * a.h);
      // 标为 scan —— 兜底扫描不区分用户点了哪张，可信度最低。
      // 父框架若有更可信的命中，SW 侧会优先采纳父框架的。
      return { ...pool[0], source: 'scan' };
    }

    // --- 路径 D：background-image 容器兜底 ---
    const containers = Array.from(
      document.querySelectorAll('div,section,li,span,a')
    ).slice(0, 3000);
    for (const el of containers) {
      const r = fromBackground(el);
      if (r?.url) return { ...r, source: 'scan' };
    }

    return { ok: false, error: '未能定位到图片，请刷新页面后重试' };
  } catch (e) {
    return { ok: false, error: '取图脚本异常：' + String((e && e.message) || e) };
  }
}

/** 把注入失败原因翻成人话，便于用户判断该刷新还是该换页面 */
function describeInjectError(e) {
  const msg = String((e && e.message) || e);
  if (/Cannot access contents|Cannot access a chrome/i.test(msg)) {
    return '该页面禁止扩展注入（浏览器内部页或应用商店页），请换到普通网页';
  }
  if (/Missing host permission/i.test(msg)) {
    return '缺少该站点权限，请在 chrome://extensions 里允许访问该站点';
  }
  if (/tab closed|Invalid tab|No tab with id/i.test(msg)) return '标签页已关闭，请重新打开';
  if (/Frame with ID .* was removed/i.test(msg)) return '页面正在跳转，请跳转完成后重试';
  if (/ISOLATED world is not supported|world.*MAIN.*not/i.test(msg)) {
    return '当前 Chrome 版本不支持该注入方式，请升级浏览器';
  }
  return '取图脚本无法在页面运行：' + msg.slice(0, 140);
}

/** 跨域取图失败的常见原因翻译成人话 */
function describeFetchError(e, url) {
  const msg = String(e?.message || e);
  if (/取图失败 403/.test(msg)) return '目标服务器拒绝访问（403），原图可能有防盗链';
  if (/取图失败 404/.test(msg)) return '原图地址失效（404）';
  if (/Failed to fetch|NetworkError|ERR_/.test(msg)) {
    return `无法跨域取图：${new URL(url, 'https://x.com').host} 可能限制了外部访问`;
  }
  return msg;
}

/**
 * 处理本地图片（拖拽 / 粘贴）。
 *
 * 加去重锁：一次拖拽会同时走消息通道和共享对象两条路，
 * 不去重会弹出两个面板、反推两次。
 */
/** 通知页面内浮层更新状态 */
async function notifyToast(tabId, msg, sub, kind) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PR_SHOW_TOAST', msg, sub, kind });
  } catch {
    /* 页面可能已关闭或尚未注入 */
  }
}

/**
 * 当前待反推图片的暂存。
 *
 * 面板点「重新反推」时图片早就取回来了（可能要过防盗链），
 * 重新走一遍取图流程既慢又可能失败，所以暂存 dataUrl 供复用。
 * 用 storage.local 而非内存 —— service worker 随时可能被回收。
 */
let pending = { dataUrl: '', meta: {}, tabId: 0 };

async function stashPending(dataUrl, meta, tabId) {
  pending = { dataUrl, meta, tabId };
  await chrome.storage.local.set({ prPending: pending });
}

async function loadPending() {
  const { prPending } = await chrome.storage.local.get('prPending');
  if (prPending?.dataUrl) {
    pending = prPending;
    return pending;
  }
  return pending.dataUrl ? pending : null;
}

/** 面板请求重新反推：复用暂存的图片，跳过取图环节 */
async function forceReverseCurrent() {
  const p = (await loadPending()) || pending;
  if (!p?.dataUrl) throw new Error('图片已失效，请重新右键一次');
  return forceReverse(p.dataUrl, p.meta);
}

/** 按 id 取完整历史记录 */
async function getRecordById(id) {
  const recs = await listRecords(500);
  return recs.find((r) => String(r.id) === String(id)) || null;
}

async function handleDataUrl(dataUrl, mime, tabId) {
  try {
    // 去重：一次拖拽会同时走消息通道和共享对象两条路。
    // 用 local 存指纹而非内存 —— service worker 回收会清零内存变量，
    // 那样同一次拖拽会被处理两遍、弹出两个面板。
    const sig = `${dataUrl.length}:${dataUrl.slice(-64)}`;
    const { lastHandledSig } = await chrome.storage.local.get('lastHandledSig');
    if (lastHandledSig === sig) return;
    await chrome.storage.local.set({ lastHandledSig: sig, lastHandledAt: Date.now() });

    // 清掉共享对象里的副本，避免被 grabDropped 再取一次
    if (tabId) grabDropped(tabId).catch(() => {});

    await notifyToast(tabId, '正在识别图片…', '通常 5~10 秒');

    // originUrl 用**像素指纹**而不是字符串 'local'。
    // 原来所有本地图片共用 'local' 这一个指纹 —— 拖进来 5 张不同的图，
    // 会被判为「同一张图的 5 次反推」，卡片流里全是无关记录。
    const meta = {
      originUrl: await localFingerprint(dataUrl),
      width: 0,
      height: 0,
      source: 'local',
    };
    await stashPending(dataUrl, meta, tabId);

    const outcome = await processImage(dataUrl, meta);

    if (outcome?.cancelled) {
      await notifyToast(tabId, '已取消反推', '查看历史记录');
    } else {
      await notifyToast(tabId, '反推完成', '提示词已输出到面板', 'done');
    }
  } catch (e) {
    await notifyToast(tabId, '反推失败', String((e && e.message) || e), 'err');
    await openPanel({ error: String((e && e.message) || e) });
  }
}

/**
 * 跨域取原图并压到长边 1024。
 * 降采样是为了省 token，不是为了省画质——1024 已经足够模型看清光线和构图。
 *
 * 防盗链的关键在 Referer。小红书要求 Referer 必须是
 * `https://www.xiaohongshu.com/`（精确匹配，少斜杠都失败），
 * 而扩展的 fetch 默认发自己的 origin，会被判为盗链 403。
 * 所以这里显式指定 Referer —— 扩展有 host 权限时能设置任意 Referer。
 *
 * 小红书 CDN 还有第二层限制：`sns-webpic-*` 的路径里内嵌时间戳，
 * 约 1 分钟后失效，即使 Referer 正确也会 403。这类 URL 必须
 * 优先走「页面内 fetch」（现取现用，签名还在有效期内）。
 */
async function fetchAsDataUrl(url, pageUrl) {
  if (!url) throw new Error('图片地址为空');

  // Referer 用页面 URL；若调用方没给页面地址，按域名猜一个
  const referrer = pageUrl || guessReferer(url);

  const res = await withTimeout(
    fetch(url, { credentials: 'include', referrer, referrerPolicy: 'unsafe-url' }),
    15000
  ).catch(() => {
    throw new Error('取图超时（15秒），该图片服务器可能限制了外部访问');
  });

  if (!res.ok) {
    // 403 且是 webpic 地址 → 十有八九是时效签名过期，不是 Referer 问题
    if (res.status === 403 && /sns-webpic/i.test(url)) {
      throw new Error('原图签名已过期（约 1 分钟有效期），需重新获取地址');
    }
    throw new Error(`取图失败 ${res.status}`);
  }
  const blob = await res.blob();
  if (blob.type && !blob.type.startsWith('image/')) {
    throw new Error('目标不是图片');
  }

  let bitmap;
  try {
    bitmap = await withTimeout(createImageBitmap(blob), 10000);
  } catch {
    // 部分站点返回的其实是 WebP/AVIF 变体，解码失败时直接用原 blob
    return blobToDataUrl(blob);
  }

  const maxEdge = Math.max(bitmap.width, bitmap.height);
  if (maxEdge > MAX_EDGE) {
    const scale = MAX_EDGE / maxEdge;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    return blobToDataUrl(out);
  }

  bitmap.close?.();
  return blobToDataUrl(blob);
}

/**
 * 按图片域名猜一个合法的 Referer。
 *
 * 防盗链站点普遍只认自家 Referer，与其空手不如给一个合理的猜测：
 * 用图片 URL 的主域名 + 小红书已知的精确格式。
 */
function guessReferer(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;

    // 小红书：必须精确匹配，含尾部斜杠
    if (/xhscdn\.com$|xiaohongshu\.com$/.test(host)) {
      return 'https://www.xiaohongshu.com/';
    }
    if (/pinimg\.com$|pinterest\.com$/.test(host)) {
      return 'https://www.pinterest.com/';
    }
    // 通用：取主域名
    const parts = host.split('.');
    const base = parts.slice(-2).join('.');
    return `https://${base}/`;
  } catch {
    return undefined;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * 本地图片的指纹：基于像素内容。
 *
 * 不能用固定字符串（原来写的是 'local'）—— 那会让**所有**本地图片
 * 共用一个指纹，拖进来 5 张不同的图会被判为同一张图的 5 次反推。
 * 不能用文件名—— 不同图的文件名完全可能撞车。
 *
 * 算法与面板里的 contentFingerprint 完全一致（32×32 采样 +
 * 三通道揉值 + FNV-1a）。两边必须一致，否则同一张图经不同链路
 * 进来会算出两个指纹，又会多出一格。
 *
 * 已知取舍：同图若经不同缩放路径再采样，像素级有差异，
 * 可能被算成两张图。多一格比串图轻得多。
 */
async function localFingerprint(dataUrl) {
  try {
    const KEY = 32;
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(KEY, KEY);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, KEY, KEY);
    const px = ctx.getImageData(0, 0, KEY, KEY).data;
    bmp.close?.();

    let h = 0x811c9dc5;
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i] + px[i + 1] * 3 + px[i + 2] * 7;
      h = (h ^ (v & 0xff)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
      h = (h ^ ((v >>> 8) & 0xff)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `px:${KEY}x${KEY}:${(h >>> 0).toString(16)}`;
  } catch {
    // 兜底：至少保证不同文件不会全撞
    const body = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
    return `data:${body.length}:${body.slice(0, 24)}`;
  }
}

async function processImage(dataUrl, meta) {
  const { mime, base64, width, height } = splitDataUrl(dataUrl);

  // 真实宽高：优先用嗅探到的，其次解码 dataURL
  const dims = width && height ? { width, height } : await probe(dataUrl);
  const ratio = resolveRatio(dims.width, dims.height);

  const fp = fingerprint(meta.originUrl, dims.width, dims.height);
  const thumbnail = await shrink(dataUrl, 220);

  // 已反推过的图**照样重新反推**，不设任何确认关卡。
  //
  // 原来的做法是查到历史就 openPanel({duplicate}) 然后 return ——
  // 结果是模型根本没被调用，屏幕上铺的是上一次的旧记录，
  // 而用户明明点了「右键反推」 expecting 一个新结果。
  //
  // 而且那个duplicate 界面从来不是阻断式的：showDuplicate() 末尾
  // 会自动调viewLatest()，一弹出就把旧结果显示出来了 ——
  // 所以它不是「拦了一下」，而是「结果被顶掉了」。
  //
  // 旧结果没浪费：它会作为 siblings 一起送到面板，
  // 既有缩略图网格展示，历史记录里也按指纹聚合。

  await openPanel({ loading: true, originUrl: meta.originUrl, source: meta.source });

  const settings = await chrome.storage.local.get(getSettings());

  // 保活 service worker。
  //
  // MV3 的 SW 空闲 30 秒就会被回收。视觉反推正常 5~10 秒，
  // 模型繁忙时可能到几十秒 —— SW 一旦被回收，这个 await 永远等不到结果，
  // 面板那边只会一直转圈，用户看不到任何报错（表现就是「反推不出结果」）。
  //
  // 定时写 storage 是一个最小的保活手段：它产生扩展级活动，
  // 让 Chrome 判定 SW 还在被使用。间隔必须显著小于 30 秒，
  // 25 秒是留了余量的取值。
  const keepAlive = setInterval(() => {
    chrome.storage.local.set({ prSwAlive: Date.now() }).catch(() => {});
  }, 25_000);

  let fields;
  let provider;
  try {
    ({ fields, provider } = await reverseImage({
      imageBase64: base64,
      mimeType: mime,
    }));
  } catch (e) {
    // 失败也要把面板从「正在反推」状态里放出来，
    // 否则用户只会看到一个永远转圈的界面 + 一个页面 toast。
    await openPanel({ error: String((e && e.message) || e) });
    throw e;
  } finally {
    clearInterval(keepAlive);
  }

  const normalized = normalizeFields(fields);
  // 记下这次用的是哪套提示词方案 —— 否则用户看到结果时
  // 无从判断它出自默认还是自己的自定义写法
  const presetName = await currentPresetName();
  // 网站名优先取 tab 页面域名；图片 URL 常指向 CDN，直接用它会得到
  // 「Pinimg」这类图片站名而非来源网站
  const siteName = siteNameFromUrl(meta.pageUrl) || (() => {
    let host = '';
    try { host = new URL(String(meta.originUrl || '')).hostname; } catch { return '本地'; }
    return looksLikeCdn(host) ? '本地' : (siteNameFromUrl(meta.originUrl) || '本地');
  })();
  const createdAt = Date.now();
  const record = {
    thumbnail,
    // 完整图供面板点击放大（缩略图只有 220px，看不清细节）。
    // 存本地 IndexedDB，不入库不外传。
    fullImage: dataUrl,
    fields: normalized,
    // normalizeFields() 会丢掉未声明的键，所以这个标记必须在这里单独存，
    // 不能指望它能从 fields 里透出来
    empty: !!fields.__empty,
    // 模型没按双语要求返回（自定义提示词常见）：面板据此说明原因，
    // 否则用户看到中文栏是英文只会以为插件坏了
    singleLang: !!fields.__singleLang,
    ratio,
    dims,
    fingerprint: fp,
    originUrl: meta.originUrl,
    // 命名用的元数据：网站名与序号在保存时定死，
    // 否则重开历史时重新计算，序号会变成 001、001、001
    siteName,
    nameSeq: nextNameSeq(createdAt, siteName),
    dims,
    fingerprint: fp,
    originUrl: meta.originUrl,
    engine: settings.engine || 'nanobanana',
    provider,
    presetName,
    via: resolveProvider(settings).label,
    createdAt,
  };
  const newId = await saveRecord(record);

  // 把本次结果也带出去，面板可一并展示历史对比
  const all = await findByFingerprint(fp);
  const siblings = newId
    ? all.filter((r) => r.id !== newId)
    : all.slice(1);

  await openPanel({
    record: newId ? { ...record, id: newId } : record,
    siblings,
    originUrl: meta.originUrl,
    source: meta.source,
  });
  return { ok: true, id: newId };
}

/** 用户选择「重新反推」 */
async function forceReverse(dataUrl, meta) {
  return processImage(dataUrl, { ...meta, force: true });
}

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('图片数据格式异常');
  return { mime: m[1], base64: m[2] };
}

/**
 * 解码 dataURL 拿真实宽高。
 * 注意：service worker 环境没有 Image 构造器，必须用 createImageBitmap，
 * 否则 probe 恒返回 0×0，导致比例与指纹都失效。
 */
async function probe(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await withTimeout(createImageBitmap(blob), 8000);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dims;
  } catch {
    return { width: 0, height: 0 };
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

/** 降采样生成缩略图，同样不能用 Image */
async function shrink(dataUrl, edge) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    return blobToDataUrl(out);
  } catch {
    return dataUrl; // 缩略图失败不影响主流程
  }
}

/**
 * 面板窗口管理
 *
 * 并发保护要同时覆盖两层：
 *   1. 内存 Promise 锁 —— 同一 SW 生命周期内的并发调用
 *   2. 窗口自注册 —— 面板打开时主动上报自己的 id
 *
 * 只靠内存锁不够：service worker 会被回收，锁和 storage.session 里的
 * 记录都可能失效，此时再来一次右键就会又开一个窗口 —— 这是
 * 「同时出现两个界面」的根因。窗口自注册让 id 始终以实际存在的
 * 窗口为准，不依赖任何可能丢失的缓存。
 *
 * 兜底：创建前先扫一遍所有窗口，若已存在面板窗口就复用。
 */
let panelLock = Promise.resolve();

function openPanel(payload) {
  panelLock = panelLock
    .catch(() => {}) // 上一次失败不影响本次
    .then(() => doOpenPanel(payload));
  return panelLock;
}

async function doOpenPanel(payload) {
  const url = chrome.runtime.getURL('src/panel/panel.html');

  // 1. 面板自注册（最可靠）。面板打开时会写 prPanelWindowId + prPanelAlive，
  //    这两个值由实际存在的窗口提供，SW 回收不影响。
  const { prPanelWindowId, prPanelAlive } = await chrome.storage.local.get([
    'prPanelWindowId',
    'prPanelAlive',
  ]);

  // alive 时间戳超过 3 分钟说明面板可能已关闭，才允许新建。
  // 心跳每 30 秒一次，3 分钟余量足够宽裕 —— 之前设90 秒时
  // 偶尔会误判面板已关闭，导致状态写进了无人接收的窗口。
  const aliveRecently = prPanelAlive && Date.now() - prPanelAlive < 180_000;

  if (prPanelWindowId && aliveRecently && (await windowExists(prPanelWindowId))) {
    // 面板还开着：只更新状态并聚焦，**绝不新建窗口**。
    //
    // 这里必须 return 而不是「聚焦失败就落到下面重建」。
    // 之前把 windows.update + tabs.update 一起包在 try 里，而
    // chrome.tabs.update({active,windowId}) 因为缺 tabId 会抛错，
    // catch 一执行就走进新建分支 —— 于是每次反推都弹第二个窗口。
    // 聚焦是锦上添水，失败也无所谓；窗口存在这一事实才是判断依据。
    //
    // bare 只是「把窗口叫到前台」，不能顺带覆写 prPanel ——
    // 否则用户正在看的结果会被一个空状态清掉。
    if (!payload || !payload.bare) {
      const next = { ...payload, at: Date.now() };
      await chrome.storage.local.set({ prPanel: next });
      // 主动推给面板。
      //
      // 只写 storage 是不够的：面板原先靠 3 秒轮询感知新状态，
      // 而轮询**只在 loading 期间运行**，反推一完成就停了。
      // 于是第二次右键另一张图时，面板仍在显示上一次的结果 ——
      // 用户看到「怎么换图了内容没变」。
      // storage 的 onChanged 面板侧已监听，这里只需确保窗口被聚焦。
      focusQuietly(prPanelWindowId);
      return;
    }
    focusQuietly(prPanelWindowId);
    return;
  }

  // 2. 没有存活的面板 → 新建
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width: 460,
    height: 660,
    focused: true,
  });

  // 用 local（持久）而非 session —— session 在 SW 回收后可能丢内容，
  // 那正是「加载时开一个、完成后再开一个」的原因
  await chrome.storage.local.set({
    prPanelWindowId: win.id,
    prPanelAlive: Date.now(),
    // 新建时即使 bare 也要写一份状态，否则面板会拒绝消费
    // （consume 靠 state.at 与 consumedAt 区分新旧），
    // 结果是空的 prPanel 让 boot() 什么都不做。
    prPanel: { ...(payload || {}), at: Date.now() },
  });
}

/**
 * 把面板窗口拉到前台。失败静默。
 *
 * 单独抽出来是因为它**绝不能影响 openPanel 的分支决策** ——
 * 聚焦只是锦上添花，窗口是否复用只取决于它存不存在。
 * 之前把聚焦写进 try/catch，catch 后落到新建分支，
 * 结果每次反推都多弹一个窗口。
 */
function focusQuietly(windowId) {
  // popup 窗口通常只有一个标签页，windows.update 聚焦即可；
  // 不再调 tabs.update —— 它需要 tabId，缺省会抛错。
  try {
    chrome.windows.update(windowId, { focused: true }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* 忽略 */
  }
}

/**
 * 面板存活心跳：窗口存在就刷新时间戳。
 * 存local 而非 session —— session 在 service worker 回收后可能丢内容。
 */
function windowExists(id) {
  return new Promise((resolve) => {
    chrome.windows.get(id, { populate: false }, (win) => {
      if (chrome.runtime.lastError) return resolve(false);
      resolve(Boolean(win));
    });
  });
}

/** 面板窗口被关闭时清掉标记，下次右键会新建 */
chrome.windows.onRemoved.addListener((id) => {
  chrome.storage.local.get('prPanelWindowId').then(({ prPanelWindowId }) => {
    if (prPanelWindowId === id) {
      chrome.storage.local.remove(['prPanelWindowId', 'prPanelAlive']);
    }
  });
});

