import { RENDERERS } from '../core/renderers.js';
import { listRecords, clearRecords, deleteRecords, saveRecord, addFavorite, listFavorites, isFavorite, updateFavoriteText, removeFavorite } from '../core/store.js';
import { reverseImage, resolveProvider } from '../core/api.js';
import { normalizeFields, resolveRatio } from '../core/schema.js';
import { matches } from '../core/shortcut.js';
import { formatRecordName } from '../core/naming.js';

/**
 * 取元素。
 *
 * id 不存在时返回一个**惰性空代理**而不是 undefined ——
 * 直接给 undefined 赋值会抛 `Cannot set properties of undefined`，
 * 一处元素缺失就会中断整条调用链（曾经导致 boot() 挂掉、
 * 连带反推结果、返回按钮、收藏全部失效）。
 * 现在缺元素只会静默无效，不会连累其他功能。
 */
const $ = (id) => {
  const el = document.getElementById(id);
  if (el) return el;
  // 开发期可见：控制台会提示哪个 id 拼错了
  if (!warnedMissing.has(id)) {
    warnedMissing.add(id);
    console.warn('[拾光] 元素不存在：#' + id);
  }
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === 'hidden') return true;
        if (prop === 'textContent' || prop === 'innerHTML' || prop === 'value') return '';
        if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
        if (prop === 'dataset') return {};
        // 事件绑定、querySelectorAll 等一律给空实现
        if (prop === 'querySelectorAll') return () => [];
        if (prop === 'querySelector') return () => null;
        if (prop === 'addEventListener' || prop === 'appendChild' || prop === 'remove') return () => {};
        return undefined;
      },
      set() {
        return true;
      },
    }
  );
};

const warnedMissing = new Set();
const main = $('main');
let current = null;      // { fields, ratio, ... }
let engine = 'nanobanana';
let pristine = '';       // 切换引擎时的原始文本，用于「恢复原版」
let consumedAt = 0;      // 已消费的状态时间戳，避免重复渲染
let lastSource = '';     // 最近一次结果的来源标记
let historyReturn = null; // 查看历史前的现场，供「返回」还原
let dupImage = '';        // 重复确认页的大图，供点击放大

// 当前主视图对应的「同图其他记录」。返回时用它还原现场 ——
// 不存这个就无法还原上一张图的结果网格（会串到刚看的那张图上）。
let currentSiblings = [];


// 收藏相关状态
let favItems = [];      // listFavorites() 的缓存

// 历史记录的筛选与多选状态
let hItems = [];          // 按指纹聚合后的历史项
let hFilter = 'all';      // 'all' | 'multi'
let pickMode = false;     // 多选模式开关
let picked = new Set();   // 已选的指纹集合
let running = false;     // 本地反推是否进行中

/* 粘贴触发：跟随设置页的开关与自定义组合键。
   没有这两行，面板里的粘贴监听就会退化成「什么键都响应」。 */
let pasteEnabled = false;
let pasteShortcut = '';

/* 面板行为设置：跟随设置页，改了立刻生效。 */
let autoCopy = false;
let nameFormat = '';
let favOpen = false;
let histOpen = false;

/**
 * 收藏/历史的折叠状态。
 *
 * 参数 force=true 时无视 foldStateApplied 闸门。
 *
 * 闸门存在的原因：用户手动点开/收起后，以他的操作为准——
 * 每次重绘都按设置覆盖回去的话，他刚展开就被代码收起来，会以为是坏了。
 *
 * 但「改了设置页的勾选」不属于「用户手动操作」，那次必须强制生效。
 * 面板窗口是复用的（doOpenPanel 只聚焦不新建），boot 只跑一次，
 * 没有 force 就等于设置改了永远不生效 —— 用户会看到「明明取消了还是展开的」。
 */
let foldStateApplied = false;

function applyFoldDefaults(force = false) {
  if (foldStateApplied && !force) return;
  foldStateApplied = true;
  // 双向赋值而不是「只在为 true 时展开」：
  // 单向写等于「false 时什么都不做」，一旦窗口内残留展开状态就清不掉。
  $('favorites').open = favOpen;
  $('history').open = histOpen;
}

/* ══════ 删除确认 ══════
 *
 * 删除不可撤销，所以一律走二次确认。但每天都删的人不该被同一句
 * 提示反复拦住 —— 「不再提示」的选择持久化到 storage。
 *
 * 用自绘弹窗而非原生confirm()：原生对话框没法加勾选框，
 * 样式也和面板完全脱节。
 */

/** 已选择跳过确认的操作类型：'history' | 'clearAll' | 'favorite' */
let skipConfirm = new Set();

/** 弹窗当前的 resolver 与操作类型。同一时刻只允许一个待决确认 */
let cfResolve = null;
let cfKind = null;

/**
 * 询问确认。
 *
 * @param {{title:string, body:string, kind:string}} opt
 *        kind 用于记忆「不再提示」；命中记录则直接 resolve(true)
 * @returns {Promise<boolean>}
 */
function askConfirm({ title, body, kind }) {
  if (skipConfirm.has(kind)) return Promise.resolve(true);

  cfKind = kind;
  $('cfTitle').textContent = title;
  $('cfBody').textContent = body;
  // 已经选过「不再提示」的用户不该每次都看见这个勾选框
  $('cfKeepWrap').hidden = skipConfirm.has(kind);
  $('cfKeep').checked = false;
  $('confirmModal').hidden = false;
  $('cfOk').focus();

  return new Promise((resolve) => {
    cfResolve = resolve;
  });
}

function closeConfirm(answer) {
  // 只在「确定」时记忆选择 —— 点了取消却说以后别问，是错的
  if (answer && cfKind && $('cfKeep').checked && !$('cfKeepWrap').hidden) {
    skipConfirm.add(cfKind);
    chrome.storage.local
      .set({ prSkipConfirm: [...skipConfirm] })
      .catch(() => {});
  }
  $('confirmModal').hidden = true;
  const r = cfResolve;
  cfResolve = null;
  cfKind = null;
  if (r) r(answer);
}

$('cfOk').addEventListener('click', () => closeConfirm(true));
$('cfCancel').addEventListener('click', () => closeConfirm(false));
// 点遮罩空白处 = 取消。误点遮罩不该丢一条历史记录
$('confirmModal').addEventListener('click', (e) => {
  if (e.target === $('confirmModal')) closeConfirm(false);
});
document.addEventListener('keydown', (e) => {
  if ($('confirmModal').hidden) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeConfirm(false);
  }
});

/** 选本地图片：面板是扩展页面，可直接处理 File，不经content script */
$('pick').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) reverseLocalFile(f);
  };
  input.click();
});

/**
 * 面板内粘贴。
 *
 * 早先这里是`window.addEventListener('paste')` 无条件生效，
 * 所以面板里按什么键都能触发、永远是 Ctrl+V —— 与设置里
 * 选的组合键完全无关，用户反馈的第二个 bug 就是这个。
 *
 * 现在与网页端对齐：只在用户设定的组合键命中时才取图，
 * 且默认走 clipboard.read()，不依赖焦点落在可编辑元素上
 * （面板里没有输入框，焦点在 body，paste 事件本身就不稳）。
 */
async function handlePasteShortcut() {
  if (running) return;
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await it.getType(type);
      if (blob && blob.size) {
        reverseLocalFile(new File([blob], 'clipboard.' + type.split('/')[1], { type }));
        return;
      }
    }
    toast('剪贴板里没有图片', '', 'err');
  } catch {
    toast('无法读取剪贴板', '请检查扩展权限', 'err');
  }
}

window.addEventListener('keydown', (e) => {
  if (!pasteEnabled || !pasteShortcut) return;
  if (!matches(e, pasteShortcut)) return;
  // 面板里没有需要保留的默认粘贴行为，直接吞掉
  e.preventDefault();
  e.stopPropagation();
  handlePasteShortcut();
});

// 面板内也支持拖放
main.addEventListener('dragover', (e) => {
  e.preventDefault();
  main.classList.add('dragging');
});
main.addEventListener('dragleave', () => main.classList.remove('dragging'));
main.addEventListener('drop', (e) => {
  e.preventDefault();
  main.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('image/')) reverseLocalFile(f);
});

async function reverseLocalFile(file) {
  if (running) return;
  running = true;
  showBusy('正在读取图片…');

  try {
    const dataUrl = await fileToDataUrl(file);

    // 尺寸
    const dims = await probeSize(dataUrl);
    const ratio = resolveRatio(dims.width, dims.height);

    showBusy('正在反推…');
    const settings = await chrome.storage.local.get({
      provider: 'agnes',
      keys: {},
      model: '',
      engine: 'nanobanana',
    });
    const p = resolveProvider(settings);
    const { fields, provider } = await reverseImage({
      imageBase64: dataUrl.split(',')[1],
      mimeType: file.type,
    });

    const normalized = normalizeFields(fields);
    // 指纹必须基于**像素内容**，不能用 file.name ——
    // 不同图的文件名完全可能相同（image.png、screenshot.png、
    // 从网页另存的默认名…），撞名会让不同图被聚成一组，
    // 表现为结果网格里冒出与当前图无关的记录。
    const fp = await contentFingerprint(dataUrl);
    const createdAt = Date.now();
    const record = {
      thumbnail: await shrinkDataUrl(dataUrl, 220),
      fullImage: dataUrl,
      fields: normalized,
      ratio,
      dims,
      fingerprint: fp,
      originUrl: 'local',
      // 本地图片没有域名，统一标为「本地」；序号同样在保存时定死
      siteName: '本地',
      nameSeq: nextLocalSeq(createdAt),
      // 与主路径同一个标记：自定义提示词只返回单语时据此提示
      singleLang: !!fields.__singleLang,
      engine: settings.engine || 'nanobanana',
      provider,
      via: p.label,
      createdAt,
    };
    const newId = await saveRecord(record);

    // 同图的历史结果一并展示，方便对比不同模型/引擎的输出
    const all = await listRecords(500);
    const siblings = all.filter(
      (r) => r.fingerprint === fp && String(r.id) !== String(newId)
    );

    showRecord(newId ? { ...record, id: newId } : record, 'local', siblings);
    await renderHistory();
  } catch (e) {
    $('state').innerHTML = `<p class="err">${escapeHtml(String(e?.message || e))}</p>`;
  } finally {
    running = false;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * 基于**像素内容**的指纹。
 *
 * 为什么不用 file.name：不同图的文件名完全可能撞车
 * （image.png、screenshot.png、网页另存的默认名……），
 * 一旦撞名，几张不相干的图会被聚成「同一张图」，
 * 表现为结果网格里冒出与当前图无关的记录。
 *
 * 做法：缩到 32×32 后对全部采样像素做 FNV-1a。
 * 三通道揉成一个值再推进，避免只取单通道时
 * 「灰度相近、色彩不同」的图撞在一起。
 *
 * 已知取舍：同一张图若经不同缩放路径再采样，像素级会有差异，
 * 可能被算成两张图。代价是历史里多一格，**比串图轻得多** ——
 * 串图会让用户看到完全无关的内容，多一格只是多点一次。
 */
async function contentFingerprint(dataUrl) {
  try {
    const KEY = 32;
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });

    const c = document.createElement('canvas');
    c.width = KEY;
    c.height = KEY;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, KEY, KEY);
    const px = ctx.getImageData(0, 0, KEY, KEY).data;

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
    // 画布被污染等极端情况 → 退回长度+首尾片段，至少不会全撞
    const body = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
    return `data:${body.length}:${body.slice(0, 24)}`;
  }
}

function probeSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

async function shrinkDataUrl(dataUrl, edge) {
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch {
    return dataUrl;
  }
}

// 版本标记：用于确认用户加载的确实是最新代码。
// 改版后移进「图片信息与说明」折叠层，不再占用首屏空间。
const BUILD = 'v1.0.0-拾光';

async function boot() {
  // 自注册窗口 id + 心跳。用 local 而非 session ——
  // session 在 service worker 回收后可能丢内容，那正是
  // 「加载时开一个面板、完成后再开一个」的根因。
  const heartbeat = async () => {
    try {
      const win = await chrome.windows.getCurrent();
      if (win?.id) {
        await chrome.storage.local.set({
          prPanelWindowId: win.id,
          prPanelAlive: Date.now(),
        });
      }
    } catch {}
  };
  await heartbeat();
  // 每30 秒刷新一次，让 SW侧能据此判断面板是否还开着
  setInterval(heartbeat, 30_000);

  // 状态推送：面板开着时接收新结果。
  //
  // 原先只有 3 秒轮询，而轮询**只在 loading 期间运行**（见 startPolling），
  // 反推一完成就停了。于是第二次右键页面上的另一张图时，
  // 面板完全不知情，继续显示上一次的结果 ——
  // 表现为「换了图，提示词还是上一个」。
  //
  // storage.onChanged 是事件驱动，SW 写入即触发，不依赖轮询时机。
  // handleState 内部已经负责轮询的启停，这里不再重复干预。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.prPanel) return;
    const next = changes.prPanel.newValue;
    if (!next?.at || next.at === consumedAt) return;
    handleState(next);
  });

  await renderHistory();

  // 渲染失败绝不能拖垮后面的流程。
  // 之前 renderFavorites() 抛错（元素缺失/存储异常）会直接中断 boot()，
  // 导致 consume() 不执行 —— 表现为「反推后没有返回按钮、收藏无效、
  // 历史只显示一条」三个症状同时出现。
  await renderFavorites().catch((e) => {
    console.warn('[拾光] 渲染收藏失败', e);
  });

  // 读回「不再提示」的删除确认选择
  await chrome.storage.local
    .get('prSkipConfirm')
    .then((s) => {
      skipConfirm = new Set(
        (Array.isArray(s.prSkipConfirm) ? s.prSkipConfirm : []).filter((x) =>
          ['history', 'clearAll', 'favorite'].includes(x)
        )
      );
    })
    .catch(() => {});

  // 读粘贴触发设置。失败也保持关闭 —— 读不到就不响应粘贴，
  // 比退化成「什么键都触发」安全。
  await chrome.storage.local
    .get(['paste', 'pasteShortcut'])
    .then((s) => {
      pasteEnabled = s.paste === true;
      pasteShortcut = s.pasteShortcut || '';
    })
    .catch(() => {
      pasteEnabled = false;
      pasteShortcut = '';
    });

  // 面板行为设置。读失败一律走保守默认（不自动复制、默认折叠、
  // 默认命名模板）—— 这几个默认值都是「不改变用户既有习惯」的那一侧。
  await chrome.storage.local
    .get(['autoCopy', 'nameFormat', 'favOpen', 'histOpen', 'foldsOpen'])
    .then((s) => {
      autoCopy = s.autoCopy === true;
      nameFormat = s.nameFormat || '';
      // 兼容旧的 foldsOpen 总开关：它在时视作两个都展开
      const old = s.foldsOpen === true;
      favOpen = old || s.favOpen === true;
      histOpen = old || s.histOpen === true;
    })
    .catch(() => {
      autoCopy = false;
      nameFormat = '';
      favOpen = false;
      histOpen = false;
    });
  applyFoldDefaults();

  // 设置在面板开着时被改，立刻跟上 —— 否则用户得关掉重开面板才生效，
  // 会以为是设置没保存成功。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.autoCopy) autoCopy = changes.autoCopy.newValue === true;
    if (changes.nameFormat) nameFormat = changes.nameFormat.newValue || '';
    if (changes.favOpen || changes.histOpen) {
      // 不处理 foldsOpen：它是迁移前的总开关，由 popup 负责翻译成两个新键。
      // popup 保存时会 remove 掉它，那次变更 newValue 是 undefined，在这里
      // 反而会把两个开关的状态覆盖掉。
      if (changes.favOpen) favOpen = changes.favOpen.newValue === true;
      if (changes.histOpen) histOpen = changes.histOpen.newValue === true;
      // force：这是用户在设置页的明确意图，优先于面板内的手动展开状态
      applyFoldDefaults(true);
    }
  });

  const { prPanel } = await chrome.storage.local.get('prPanel');
  if (prPanel?.at && prPanel.at !== consumedAt) consume(prPanel);

  // 版本标记放页脚，确认加载的是最新代码
  $('buildTag').textContent = BUILD;
}

/** 空态：状态文案 + 使用指引。howto 独立于 state，不会被 innerHTML 覆盖 */
function showState(inner) {
  $('state').hidden = false;
  $('result').hidden = true;
  $('dup').hidden = true;
  // 提示条在 #result 里，会随它一起隐藏；
  // 这里再清一次是冗余的保险 —— 万一将来把它挪到外面，
  // 「空态上挂着『这张图此前反推过N 次』」是极难发现的显示错误。
  $('rehit').hidden = true;
  $('state').innerHTML = inner;
  $('state').classList.remove('plain');
  $('howto').hidden = false;
  // 空态下没有可返回的内容
  $('back').hidden = true;
}

/**
 * 标准空态：图标 + 标题 + 一行说明。
 *
 * 之前所有空态都是一句裸 <p>，居中飘在空旷的页面上方，
 * 没有层级也没有重点。这里统一成三段式，视觉重心落在上 1/3。
 */
function showEmpty(title, sub, glyph) {
  showState(
    `<div class="glyph">${glyph || '✦'}</div>` +
    `<h2>${escapeHtml(title || '等待图片')}</h2>` +
    `<p>${escapeHtml(sub || '右键网页上的任意图片，即可开始反推')}</p>`
  );
}

/** 进行中：转圈 + 文案。不用空态那套图形，避免和「已完成」混淆 */
/** 各阶段的副标题。key 是主标题里出现的词，不再单独传参 */
const BUSY_SUB = {
  读取: '正在从页面取原图',
  重新: '沿用这张图，重新看一遍',
  反推: '视觉模型正在看图，通常 5~10 秒',
};

function showBusy(text) {
  const title = text || '正在反推…';
  const sub =
    BUSY_SUB[Object.keys(BUSY_SUB).find((k) => title.includes(k))] || '';
  showState(
    `<div class="busy">` +
      `<div class="scan"><i>✦</i></div>` +
      `<div class="steps"><span></span><span></span><span></span></div>` +
      `<b>${escapeHtml(title)}</b>` +
      (sub ? `<em>${escapeHtml(sub)}</em>` : '') +
    `</div>`
  );
  $('state').classList.add('plain');
}

/**
 * 消费一份面板状态。
 * 面板可能被复用（第二次右键不再新建窗口），所以每次都以 storage 为准，
 * 不能只在首次加载时读一次。
 */
function consume(state) {
  if (!state || state.at === consumedAt) return;
  consumedAt = state.at;

  // 重复反推确认
  if (state.duplicate) {
    showDuplicate(state);
    return;
  }

  $('dup').hidden = true;

  if (state.error) {
    let html = `<p class="err">${escapeHtml(state.error)}</p>`;
    // 诊断明细：让用户知道每一级取图方式各自为什么失败
    if (Array.isArray(state.diag) && state.diag.length) {
      html +=
        '<div class="diag">' +
        state.diag
          .map(
            (d) =>
              `<div class="drow"><span class="dot ${d.ok ? 'ok' : 'no'}"></span>` +
              `<b>${escapeHtml(d.name)}</b> ${escapeHtml(d.note || '')}</div>`
          )
          .join('') +
        '</div>';
    }
    showState(html);
    return;
  }

  if (state.loading) {
    showBusy('正在反推…');
    return;
  }

  if (state.record) {
    // isFresh=true：这条是刚反推出来的，不是用户从历史里点开的
    showRecord(state.record, state.source, state.siblings, true);
    // 必须立刻刷新历史：右键反推是面板最主要的入口，
    // 之前这里没有 renderHistory()，导致新记录要等面板重开才出现在历史里。
    // （本地拖拽路径一直有调，所以只有右键这条路会漏）
    renderHistory().catch((e) => {
      console.warn('[拾光] 刷新历史失败', e);
    });
  }
}

/** 展示「这张图之前反推过」的确认界面 */
function showDuplicate(state) {
  const recs = state.duplicate.records || [];
  $('state').hidden = true;
  $('howto').hidden = true;
  $('result').hidden = true;
  $('dup').hidden = false;
  if (state.thumbnail) {
    $('dupImg').src = state.thumbnail;
    dupImage = state.thumbnail;
  }

  // 诊断：显示指纹与时间，便于确认去重是否命中
  const latestTime = recs[0]?.createdAt
    ? new Date(recs[0].createdAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  $('dupSub').textContent = recs.length
    ? `已有 ${recs.length} 条记录${latestTime ? `，最近 ${latestTime}` : ''}。要查看还是重新反推？`
    : '已有反推记录。要查看还是重新反推？';

  if (state.duplicate.fp) {
    $('dupFp').textContent = `指纹 ${state.duplicate.fp}`;
    $('dupFp').hidden = false;
  }

  // 「查看」= 把最近一条当主结果展示，并列出全部历史
  const viewLatest = () => {
    const latest = recs[0];
    if (!latest) return;
    showRecord(latest, state.source, recs.slice(1));
  };

  $('dupView').onclick = viewLatest;
  $('dupView').textContent = recs.length > 1
    ? `查看之前的 ${recs.length} 条结果`
    : '查看之前的反推结果';

  $('dupAgain').onclick = async () => {
    const btn = $('dupAgain');
    btn.disabled = true;
    btn.textContent = '正在重新反推…';
    showBusy('正在重新反推…');
    const res = await chrome.runtime
      .sendMessage({ type: 'PR_FORCE_REVERSE' })
      .catch(() => ({ ok: false, error: '通信失败，请重新右键一次' }));
    if (!res?.ok) {
      showState(`<p class="err">${escapeHtml(res?.error || '重新反推失败')}</p>`);
      btn.disabled = false;
      btn.textContent = '重新反推一次';
    }
  };

  $('dupCancel').onclick = () => showEmpty();

  // 直接展示全部历史供对比（即使有记录也不强迫用户二选一）
  if (recs.length) viewLatest();
}

/**
 * 展示一条记录。
 *
 * @param {boolean} isFresh 是否为**刚反推出来**的结果。
 *   只有 fresh 才会触发「反推后自动复制」——
 *   从历史/收藏点开旧记录也走这里，那时不该动用户的剪贴板。
 */
function showRecord(record, source, siblings, isFresh = false) {
  current = record;
  engine = record.engine || 'nanobanana';
  lastSource = source || '';
  // 同步当前视图的兄弟列表，供「返回」原样还原
  currentSiblings = Array.isArray(siblings) ? siblings : [];

  $('state').hidden = true;
  $('howto').hidden = true;
  $('dup').hidden = true;
  $('result').hidden = false;
  // 只要显示了结果，返回按钮就该可用 ——
  // 不只是「从历史点进来」才有。直接反推出来的结果
  // 同样需要能退回空态去选别的图。
  $('back').hidden = false;

  // 图片优先：预览置顶
  $('heroImg').src = record.thumbnail || '';

  // 居中说明行：主体 + 比例 + 取图方式
  //
  // 原来下面还有个「图片信息与说明」折叠层展示尺寸/模型/时间，
  // 用户要求去掉了 —— 这些信息在这一行里已经够了。

  // 自定义提示词没产出内容：说明白原因和怎么修，
  // 而不是丢一句「未命名图片」让人以为插件坏了
  if (record.empty) {
    showState(
      '<div class="err" style="max-width:360px">' +
        '<div style="font-weight:500;margin-bottom:6px;">自定义提示词没有产出内容</div>' +
        '<div style="font-size:12px;line-height:1.7;">' +
        '模型按你的提示词写了内容，但没有返回可用的提示词。' +
        '可能的原因：提示词太短、描述了图片内容而非描述方式，' +
        '或指向的字段不存在。' +
        '</div>' +
        '<div style="font-size:12px;line-height:1.7;margin-top:8px;">' +
        '建议写法：告诉模型<strong style="font-weight:500">要输出什么</strong>，' +
        '而不只是<strong style="font-weight:500">这张图里有什么</strong>。' +
        '例如「详细描述主体、光线与色调，输出一段可直接用于文生图的提示词」。' +
        '</div>' +
        '<div style="margin-top:12px;font-size:12px;color:var(--ink-3)">' +
        '在设置里把方案切回「默认」可以立刻恢复。' +
        '</div>' +
      '</div>'
    );
    return;
  }

  // 记录名：日期时间-网站名-序号
  //
  // 序号与缩略图角标**必须同源**，否则会出现
  // 「大图标题写…-002，左下角角标却是003」这种自相矛盾。
  // record.nameSeq 是按「分钟 + 站点」递增的（服务于文件命名），
  // 跨分钟会重置，同一张图可能出现两个 001 ——
  // 所以这里不用它，改用 seqOf() 按这张图在同图记录中的位置算。
  const siteName = record.siteName || siteNameFromUrl(record.originUrl);
  // seqOf 要的是**含自身**的完整记录集，而 siblings 按约定不含当前记录
  const allSame = [record, ...currentSiblings];
  const title = makeRecordName({ ...record, nameSeq: seqOf(record, allSame) }, siteName);

  // 说明行只放记录名。
  //
  // 原先还拼了比例与取图方式（如「· 3:4 · 右键目标」），两个问题：
  // 比例已经写进提示词正文（渲染层会追加「画面比例 xx」），
  // 在这里再显示一遍是纯冗余；取图方式对用户没有意义 ——
  // 他关心的是「这张图叫什么」，不是「插件怎么取到的」。
  $('picCap').textContent = title;
  $('picCap').title = title;

  // 自定义提示词没返回双语时说明原因。
  // 不说的话，用户看到中文栏是英文只会以为插件坏了。
  const lh = $('langHint');
  if (lh) {
    lh.hidden = !record.singleLang;
    lh.textContent = record.singleLang
      ? '这次模型只返回了一种语言，中文栏显示的是原文。' +
        '换一张图或重试通常就能得到双语结果。'
      : '';
  }

  // 重复反推提示条：只在**刚反推出来**且这张图有旧结果时出现。
  //
  // 从历史/收藏点开旧记录时不显示 —— 那时用户就是主动去看历史，
  // 再提醒一句「这张图有旧结果」是废话。
  if (isFresh && currentSiblings.length) {
    $('rehit').innerHTML =
      `<b>这张图此前反推过 ${currentSiblings.length} 次，当前显示的是新结果</b>` +
      `<span>旧结果在下方缩略图里，点击可切换。</span>`;
    $('rehit').hidden = false;
  } else {
    $('rehit').hidden = true;
  }

  update();

  // 结果网格：当前结果 + 同图其他历史，缩略图平铺
  renderStream(record, siblings);

  // 收藏按钮状态随当前记录变化
  paintStar();

  // 反推后自动复制。
  //
  // 只在**新反推出来**的结果上触发，不是每次显示记录都触发 ——
  // 从历史/收藏点开一条旧记录时也走showRecord，
  // 那时复制等于「我只是在看历史，剪贴板却被改了」。
  // 所以由调用方显式声明这是不是一次新的反推。
  if (isFresh) maybeAutoCopy(record);
}

/**
 * 自动复制去重键。
 *
 * 同一张图反复反推、或面板反复收到同一个 at，
 * 都不该重复写剪贴板。只拦「同一次结果被消费多次」，
 * 不永久记住 —— 用户可能隔很久再反推同一张图，那次应该照常复制。
 */
let lastAutoCopyKey = '';

function maybeAutoCopy(record) {
  if (!autoCopy) return;
  const text = $('prompt').value;
  if (!text) return;

  const key = `${record.id || ''}|${record.createdAt || 0}|${engine}`;
  if (key === lastAutoCopyKey) return;
  lastAutoCopyKey = key;

  copyText(text, '已自动复制提示词', record.presetName ? `来自方案「${record.presetName}」` : '')
    .catch(() => {});
}

/**
 * 结果网格：同一张图的多次反推，纯缩略图 + 序号。
 *
 * 当前记录在首位（最新在前），其余同图历史紧随其后。
 *
 * 原先是卡片形态（缩略图 + 两段提示词摘要），占掉大半屏。
 * 但这里只需回答「这是第几次、想看哪次」—— 摘要文字在下方
 * textarea 里已经完整可见，重复一遍是冗余，还把对比对象挤小了。
 */
/**
 * 这张图是第几次反推。
 *
 * 大图标题的后缀与缩略图角标**必须用同一个算法**，
 * 否则会出现「标题写 …-002、角标却是 003」的自相矛盾。
 * 两处共用本函数，不各自算一遍。
 *
 * 序号 = 同图记录里比它旧的条数 + 1。
 *
 * @param record 目标记录
 * @param allList **同图的完整记录集（含 record 自身）**。
 *   必须是全集：早先传的是不含 main 的 siblings，于是除 main 之外的每条
 *   都少算了一个「比自己旧的那条」，角标出现两个 002。
 *   自身按 id 排除，不会把自己算进「比自己旧的」里。
 *
 * 刻意不用 record.nameSeq —— 那个按「分钟 + 站点」递增，
 * 跨分钟会重置，同一张图会出现两个 001。
 */
function seqOf(record, allList) {
  const t = record.createdAt || 0;
  const older = (Array.isArray(allList) ? allList : [])
    .filter((r) => !sameId(r.id, record.id) && (r.createdAt || 0) < t)
    .length;
  return older + 1;
}

function renderStream(main, siblings) {
  const box = $('vlist');

  // 统一按时间倒序排一次，序号与选中态都从这份顺序推导。
  //
  // 原来直接 [main, ...siblings]：main 是「当前查看的那条」，
  // 而 siblings 是时间倒序的历史 —— 两者拼起来并不是全局有序的。
  // 用户点开一条较早的记录（比如 002）时，main 被硬塞在第 0 位，
  // 于是序号算成 003、选中态也落在第一条 —— 表现为
  // 「大图标题写002，左下角角标却是 003 且高亮的那格不是它」。
  const all = Array.isArray(siblings) ? [main, ...siblings] : [main];
  const list = all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const mainIdx = list.findIndex((r) => sameId(r.id, main.id));

  if (list.length < 2) {
    // 只有一条结果时不必平铺，直接显示提示词区
    box.hidden = true;
    $('promptWrap').hidden = false;
    return;
  }

  box.hidden = false;
  $('promptWrap').hidden = false;

  box.innerHTML = list
    .map((r, i) => {
      // 序号用与标题同一个函数，两处不可能算出不同结果。
      // seqOf 按「比它旧的条数 + 1」，与时间倒序排列严格对应。
      const seq = seqOf(r, all);
      const tag = String(seq).padStart(3, '0');
      const site = r.siteName || siteNameFromUrl(r.originUrl) || '';
      const tip = site ? `第 ${seq} 次 · ${site}` : `第 ${seq} 次`;

      const thumb = r.thumbnail
        ? `<img src="${r.thumbnail}" alt="" />`
        : '<div class="ph"></div>';

      return `<button class="vitem${i === mainIdx ? ' active' : ''}" data-i="${i}" title="${escapeHtml(tip)}">
        ${thumb}
        <span class="seq">${escapeHtml(tag)}</span>
      </button>`;
    })
    .join('');

  box.querySelectorAll('.vitem').forEach((el) =>
    el.addEventListener('click', () => {
      const rec = list[+el.dataset.i];
      if (!rec) return;
      if (+el.dataset.i === mainIdx) return; // 当前这条不必重载
      showRecord(rec, lastSource, list.filter((x) => x !== rec));
      $('main').scrollTop = 0;
    })
  );
}

/**
 * 从图片 URL 提取网站名，用于记录命名。
 *
 * 与 background.js 里的同名函数保持一致：去掉 www. 与后缀，
 * 「www.pinterest.com」→「Pinterest」。二级后缀（co.uk）
 * 要连同主域一起判断，否则 example.co.uk 会只剩「Co」。
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

    const tail2 = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'];
    const second = parts[parts.length - 2];
    const main = tail2.includes(second) && parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
    if (!main || /^\d/.test(main)) return '';

    return main.charAt(0).toUpperCase() + main.slice(1);
  } catch {
    return '';
  }
}

/** 本地图片的序号：同样按「本分钟」分组 */
let localSeqMap = new Map();
function nextLocalSeq(createdAt) {
  const d = new Date(createdAt || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  const key =
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `${p2(d.getHours())}${p2(d.getMinutes())}`;
  const next = (localSeqMap.get(key) || 0) + 1;
  localSeqMap.set(key, next);
  if (localSeqMap.size > 500) localSeqMap = new Map([...localSeqMap].slice(-200));
  return next;
}

/**
 * 记录名。格式由用户在设置页配置，模板与占位符见 core/naming.js。
 *
 * 原来这里硬编码了三段拼接，background.js 还有一份几乎相同的实现 ——
 * 改格式要改两处，漏一处就出现「文件名和界面标题不一致」。
 */
function makeRecordName(record, siteName) {
  return formatRecordName(record, siteName, nameFormat);
}

function sourceLabel(s) {
    // 来源串可能带 @f3 frame 后缀和 +画布像素 这样的取图方式后缀
    const main = String(s || '').split('@')[0].split('+')[0];
    return {
      browser: '右键目标',
      attr: '原图属性',
      dom: 'DOM 匹配',
      cursor: '右键位置',
      background: '背景图',
      picture: 'picture 源',
      'video-poster': '视频封面',
      scan: '页面扫描（不精确）',
      local: '本地',
      sniffed: '网络嗅探',
      passthrough: '直传',
      hit: '坐标命中',
      history: '历史记录',
      favorite: '我的收藏',
    }[main] || main;
  }

function update() {
  // 收藏的原始记录已被清掉时，fields 是空的，
  // 直接展示收藏时存下的那段文本，引擎切换失去意义（已禁用）。
  if (current?.savedText != null) {
    if ($('prompt').value !== current.savedText) $('prompt').value = current.savedText;
    pristine = current.savedText;
    $('copy').disabled = !current.savedText;
    $('reset').disabled = !current.savedText;
    $('engines').hidden = true;
    paintLen();
    return;
  }

  $('engines').hidden = false;
  const r = RENDERERS[engine];
  const out = r.render(current.fields, current.ratio);

  // 切引擎时重填文本，但**不覆盖用户自己的编辑** ——
  // 切引擎只该改渲染方式，不该把他手改的内容冲掉。
  // 判据：当前内容是否还等于上一个引擎渲染出来的原版。
  const edited = $('prompt').value !== pristine;
  if (!edited) {
    $('prompt').value = out.text;
  }
  pristine = out.text;
  paintLen();

  $('copy').disabled = !!out.empty;
  $('reset').disabled = !!out.empty;
  document.querySelectorAll('#engines button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.engine === engine));
  });
}

$('engines').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !current) return;
  engine = btn.dataset.engine;
  chrome.storage.local.set({ engine });
  update();
});

$('copy').addEventListener('click', async () => {
  await copyText($('prompt').value, '已复制提示词');
});

$('reset').addEventListener('click', () => {
  $('prompt').value = pristine;
  paintLen();
  // 重置会改变文本，已收藏的条目要跟着更新
  syncFavText();
});

/**
 * 主界面的编辑 → 同步进收藏（自动保存）。
 *
 * 去抖 600ms：连续打字不该每敲一下就写一次 IndexedDB。
 */
let mainEditTimer = null;
$('prompt').addEventListener('input', () => {
  paintLen();
  clearTimeout(mainEditTimer);
  mainEditTimer = setTimeout(() => {
    syncFavText();
  }, 600);
});

/** 字符数：编辑时给一个轻量反馈，也让长提示词有量化的存在感 */
function paintLen() {
  const n = $('prompt').value.length;
  $('pLen').textContent = n ? n + ' 字符' : '';
}

/* ══════════════ 收藏 ══════════════ */

/**
 * recordId 比较。
 *
 * 不能用 `===`：DOM 的 dataset 永远是字符串，而 IndexedDB 主键可能是数字
 * （saveRecord 是 autoIncrement）。`Number()` 转换能让数字 key 对上，
 * 但遇到字符串 key（fallbackKey 生成的）就变 NaN，两边都匹配不上。
 * 统一按字符串比，两种 key 都能正确匹配。
 */

/* ══════════════ 轻提示 ══════════════ */

/**
 * 页面内轻提示。
 *
 * 这个函数以前**根本不存在** —— 收藏逻辑里 6 处调用 toast()，
 * 一收藏就在那一行抛 ReferenceError，后面的 renderFavorites() 和
 * paintStar() 全都不执行，表现为「按钮不变、没有任何提示」。
 * 根因是加了调用却忘了实现，属于典型的静默半途失败。
 */
let toastTimer = null;
function toast(msg, sub, kind) {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.className = 'toast show' + (kind ? ' ' + kind : '');
  box.innerHTML =
    '<b>' + escapeHtml(msg) + '</b>' +
    (sub ? '<span>' + escapeHtml(sub) + '</span>' : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.remove('show');
  }, 1900);
}

/**
 * 复制到剪贴板，附提示。
 *
 * navigator.clipboard 在扩展页里偶尔会被权限拒掉，
 * 所以留一条 execCommand 兜底 —— 用户点了按钮就有用户手势，
 * 这条路通常能过。两条都失败要明确告诉他，不能静默。
 */
async function copyText(text, okMsg, sub) {
  const t = String(text || '');
  if (!t) {
    toast('没有可复制的提示词', '', 'err');
    return false;
  }
  try {
    await navigator.clipboard.writeText(t);
    toast(okMsg || '已复制', sub);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) {
        toast(okMsg || '已复制', sub);
        return true;
      }
    } catch {}
    toast('复制失败', '请手动选中后复制', 'err');
    return false;
  }
}

const sameId = (a, b) => String(a) === String(b);

/** 当前记录是否已收藏 */
async function currentIsFav() {
  const id = current?.id;
  if (id == null) return false;
  return favItems.some((f) => sameId(f.recordId, id));
}

/** 刷新收藏按钮的显示状态 */
async function paintStar() {
  const on = await currentIsFav();
  const btn = $('star');
  btn.classList.toggle('on', on);
  btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
}

/**
 * 收藏/取消收藏当前提示词。
 *
 * 存的是 textarea 里的**当前文本** —— 用户编辑过就存编辑后的版本，
 * 而不是原始反推结果。
 */
$('star').addEventListener('click', async () => {
  const rec = current;
  const id = rec?.id;
  if (id == null) {
    toast('无法收藏', '当前结果尚未保存，请重新反推一次', 'err');
    return;
  }

  // 整段包错误边界 —— 存储异常时要有反馈，
  // 不能静默失败让用户以为按钮坏了
  try {
    if (await currentIsFav()) {
      await removeFavorite(id);
      await renderFavorites();
      await paintStar();
      toast('已取消收藏');
    } else {
      await addFavorite(rec, $('prompt').value);
      await renderFavorites();
      await paintStar();
      toast('已收藏', '可在下方「我的收藏」中右键直接复制');
    }
  } catch (e) {
    console.warn('[拾光] 收藏操作失败', e);
    toast('操作失败', String(e?.message || e).slice(0, 60), 'err');
    // 按钮状态要与事实同步，否则会一直显示错的
    try {
      await renderFavorites();
      await paintStar();
    } catch {}
  }
});

/* ══════════════ 收藏 ══════════════ */

/**
 * 渲染收藏列表：**只展示图片网格**。
 *
 * 交互与历史记录一致：
 *   左键 → 打开该收藏对应的提示词界面
 *   右键 → 直接复制提示词（不需要打开界面）
 *
 * 收藏条目不再内嵌 textarea。原来每条都挂一个编辑框，
 * 列表一长就是一屏文字墙，图片反而看不见了 ——
 * 编辑能力保留在「打开后的提示词界面」里，改动照样自动存回收藏。
 */
/* 单击 / 双击的分流延迟。
 *
 * 直接把放大绑在 click 上行不通：第一下就弹出大图遮罩，用户的第二下
 * 落在遮罩上（被 closeLightbox 吃掉），dblclick 永远不触发。反过来只绑
 * dblclick 也不行 —— 没人愿意为一个动作等两下。
 *
 * 所以单击延迟一小段再执行：这段里若等到 dblclick，就取消延迟走详情。
 * 单人双击间隔通常在 200~300ms 内，260ms 够用；超过就当单击，
 * 用户不会有明显感觉。 */
const SINGLE_MS = 260;

/** 收藏网格的延迟单击计时器。与历史各自一份，互不干扰 */
let favClickTimer = 0;

/** 历史网格的延迟单击计时器 */
let clickTimer = null;

/**
 * 取消尚未执行的延迟单击。
 *
 * 网格重绘时必须调它：用户点了一下缩略图、紧接着点叉号删除，删除会
 * 重绘列表，但那一击的延迟仍在计时，260ms 后会弹出一张已被删掉的图。
 */
function clearClickTimer() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
}

async function renderFavorites() {
  // 同 paintHistory：重绘作废未执行的延迟单击
  clearTimeout(favClickTimer);
  favClickTimer = 0;

  favItems = await listFavorites();

  $('favorites').hidden = false;
  $('fTitle').textContent = `我的收藏 · ${favItems.length}`;
  $('fEmpty').hidden = favItems.length > 0;
  if (!favItems.length) {
    $('flist').innerHTML = '';
    return;
  }

  $('flist').innerHTML = favItems
    .map((f, i) => {
      const inner = f.thumbnail
        ? `<img src="${f.thumbnail}" alt="" />`
        : '<div class="ph"></div>';
      const tag = f.edited ? '<span class="ftag">已编辑</span>' : '';
      return `<div class="fitem" data-i="${i}" title="单击看大图 · 双击打开提示词 · 右键复制">
        <span class="tick"></span>${inner}${tag}
        <button class="fx" data-act="del" data-i="${i}" title="取消收藏">✕</button>
      </div>`;
    })
    .join('');

  const items = $('flist').querySelectorAll('.fitem');

  items.forEach((el) => {
    const f = favItems[+el.dataset.i];
    if (!f) return;

    // 单击 → 看大图。延迟执行以区分双击，理由同历史网格。
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-act="del"]')) return;
      const src = f.fullImage || f.thumbnail || '';
      clearTimeout(favClickTimer);
      favClickTimer = setTimeout(() => {
        favClickTimer = 0;
        openLightbox(src);
      }, SINGLE_MS);
    });

    // 右键 → 直接复制
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      copyText(f.text, '已复制这条收藏的提示词');
    });

    // 双击 → 进提示词界面
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.target.closest('[data-act="del"]')) return;
      clearTimeout(favClickTimer);
      favClickTimer = 0;
      closeLightbox();
      openFavorite(f);
    });
  });

  // 取消收藏 —— 删除不可撤销，走二次确认
  $('flist').querySelectorAll('[data-act="del"]').forEach((btn) =>
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const f = favItems[+btn.dataset.i];
      if (!f) return;
      const ok = await askConfirm({
        title: '取消这条收藏？',
        body: '收藏里的提示词会一并删除，原始历史记录不受影响。',
        kind: 'favorite',
      });
      if (!ok) return;
      await removeFavorite(f.recordId);
      await renderFavorites();
      await paintStar();
      toast('已取消收藏');
    })
  );
}

/**
 * 打开某条收藏的提示词界面。
 *
 * 优先回历史库找原始记录 —— 有它就能像点历史一样左右切换引擎、
 * 看同图的其他反推结果。历史被清掉时（收藏独立存储，不会跟着清），
 * 退化为只读展示收藏时存下的那段文本。
 */
async function openFavorite(f) {
  const recs = await listRecords(500);
  const rec = recs.find((r) => sameId(r.id, f.recordId));

  historyReturn = { record: current, source: lastSource, siblings: currentSiblings };

  if (rec) {
    const siblings = recs.filter(
      (r) => r.fingerprint && r.fingerprint === rec.fingerprint && !sameId(r.id, rec.id)
    );
    showRecord(rec, 'favorite', siblings);
    $('main').scrollTop = 0;
    return;
  }

  // 原始记录不在了：直接展示收藏的文本，引擎切换失去意义
  showRecord(
    {
      id: f.recordId,
      thumbnail: f.thumbnail,
      fullImage: f.fullImage,
      ratio: f.ratio,
      engine: f.engine,
      createdAt: f.createdAt,
      fields: {},
      subject: f.subject || '',
      savedText: f.text,
    },
    'favorite',
    []
  );
  $('main').scrollTop = 0;
}

/** 把当前 textarea 的文本同步进收藏（用户编辑主界面后调用） */
async function syncFavText() {
  const id = current?.id;
  if (id == null) return;
  const fav = favItems.find((f) => sameId(f.recordId, id));
  if (!fav) return;
  const val = $('prompt').value;
  if (val === fav.text) return;
  await updateFavoriteText(id, val);
  fav.text = val;
  fav.edited = true;
}

/* ===== 历史的筛选与多选 ===== */

// 筛选：全部 / 多次反推
$('hFilters')
  .querySelectorAll('[data-filter]')
  .forEach((btn) =>
    btn.addEventListener('click', () => {
      if (hFilter === btn.dataset.filter) return;
      hFilter = btn.dataset.filter;
      paintHistory();
    })
  );

// 多选模式开关
$('pickToggle').addEventListener('click', () => {
  pickMode = !pickMode;
  if (!pickMode) picked.clear();
  $('pickToggle').classList.toggle('on', pickMode);
  $('pickToggle').textContent = pickMode ? '退出多选' : '多选';
  $('hlist').classList.toggle('pickmode', pickMode);
  paintHistory();
});

// 全选 / 取消
$('selAll').addEventListener('click', () => {
  const visible = hFilter === 'multi' ? hItems.filter((g) => g.length > 1) : hItems;
  for (const grp of visible) {
    const r = grp[0];
    picked.add(r.fingerprint || `id:${r.id}`);
  }
  paintHistory();
});

$('selNone').addEventListener('click', () => {
  picked.clear();
  paintHistory();
});

/**
 * 删除选中项。
 *
 * 原先是「两次点击」式确认：第一次把按钮变成「确认删除 N 张」，
 * 选择一变就复位。现在统一走弹窗 —— 按钮位置在多选条上，用户点它
 * 时手已经在那个位置了，再点一次同一按钮容易漏点或误点；
 * 弹窗把「删什么」写清楚，也顺带能承载「不再提示」。
 */
$('clearOne').addEventListener('click', async () => {
  if (!picked.size) return;

  const keys = new Set(picked);
  const ids = [];
  for (const key of keys) ids.push(...idsForKey(key));

  if (!ids.length) {
    picked.clear();
    paintHistory();
    return;
  }

  const ok = await askConfirm({
    title: `删除选中的 ${keys.size} 张图？`,
    body:
      keys.size === 1
        ? '这张图的全部反推记录都会删除，无法撤销。已收藏的提示词不受影响。'
        : `共 ${keys.size} 张图、${ids.length} 条记录，全部删除后无法撤销。已收藏的提示词不受影响。`,
    kind: 'history',
  });
  if (!ok) return;

  await dropRecords(ids, keys);
  picked.clear();
  await renderHistory();
  toast(`已删除 ${keys.size} 张`);
});

$('clear').addEventListener('click', async () => {
  if (!hItems.length) return;
  // 清空全部不可撤销，必须二次确认
  const total = hItems.reduce((n, g) => n + g.length, 0);
  const ok = await askConfirm({
    title: '清空全部历史记录？',
    body: `共 ${hItems.length} 张图、${total} 条记录，删除后无法恢复。已收藏的提示词不受影响。`,
    kind: 'clearAll',
  });
  if (!ok) return;

  await clearRecords();
  picked.clear();
  pickMode = false;
  $('pickToggle').classList.remove('on');
  $('pickToggle').textContent = '多选';
  $('hlist').classList.remove('pickmode');
  $('vlist').hidden = true;
  current = null;
  currentSiblings = [];
  historyReturn = null;
  $('back').hidden = true;
  await renderHistory();
  toast('历史记录已清空');
});

/* ===== 图片点击放大 ===== */
// 方案 4 的大图预览只有 148px 高，看不清细节，所以点一下能看完整图。
// 用记录里已存的 dataURL，不需要额外请求。
function openLightbox(src) {
  // 没有有效图片就别开 —— 否则会显示一个空遮罩挡住整个界面
  if (!src || src === 'undefined' || src === 'null') return;
  $('lbImg').src = src;
  $('lightbox').hidden = false;
}

function closeLightbox() {
  $('lightbox').hidden = true;
  $('lbImg').src = '';
}

$('heroImg').addEventListener('click', () => {
  // 优先看当前记录的完整 dataURL；只有缩略图时退回缩略图
  openLightbox(current?.fullImage || current?.thumbnail || '');
});

// 重复反推确认页的大图也支持放大
$('dupImg').addEventListener('click', () => {
  openLightbox(dupImage || '');
});

/**
 * 关闭放大层：点遮罩任意位置、点关闭按钮、按 Esc 都可以。
 *
 * 原来只认 `e.target.id === 'lightbox'`（遮罩空白）和关闭按钮，
 * 所以点在大图正中间反而关不掉 —— 那里恰恰是用户最想关的地方。
 * 直接在遮罩上收click，不再判断具体目标。
 */
$('lightbox').addEventListener('click', () => {
  closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox();
});

async function renderHistory() {
  let recs = [];
  try {
    recs = await listRecords(200);
  } catch (e) {
    // 历史库不可用不应阻塞主流程，静默隐藏历史区
    $('history').hidden = true;
    return;
  }

  const box = $('history');
  if (!recs.length) {
    box.hidden = true;
    hItems = [];
    return;
  }
  box.hidden = false;

  // 按指纹聚合：同一张图的多次反推合并为一格。
  //
  // 但要防「历史脏指纹」：早期版本本地图片一律用字符串 'local'
  // 当指纹，于是几张不相干的图被聚成一格，结果网格里会冒出
  // 与当前图无关的记录。存量数据已经这样了，所以这里额外做一次
  // 冲突拆分：把可疑指纹（'local' 或非内容哈希）的记录按
  // 自己的 fullImage 重新算出像素指纹再分桶。
  const groups = new Map();
  const suspect = [];

  for (const r of recs) {
    const fp = r.fingerprint || '';
    // 可靠指纹：内容哈希（px: 前缀）或 http 图片文件名
    const reliable = fp.startsWith('px:') || /^https?:/i.test(fp);
    if (reliable) {
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp).push(r);
    } else {
      suspect.push(r);
    }
  }

  // 可疑记录按 fullImage 重新分桶（只算一次，避免重复解码）
  const byContent = new Map();
  for (const r of suspect) {
    const src = r.fullImage || r.thumbnail || '';
    let key = '';
    try {
      key = src ? await contentFingerprint(src) : '';
    } catch {
      key = '';
    }
    // 算不出内容指纹就退回 id，保证绝不合并无关记录
    const bucket = key || `id:${r.id}`;
    if (!byContent.has(bucket)) byContent.set(bucket, []);
    byContent.get(bucket).push(r);
  }
  for (const [k, v] of byContent) {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(...v);
  }

  hItems = [...groups.values()].sort(
    (a, b) => (b[0].createdAt || 0) - (a[0].createdAt || 0)
  );

  paintHistory();
}

/** 按当前筛选条件重绘网格。筛选/选中状态变化时只重绘，不重查存储。 */
function paintHistory() {
  // 重绘会让旧格子连同它们的点击处理一起失效，
  // 未执行的延迟单击必须作废，否则它会对着一张已删的图弹放大层
  clearClickTimer();

  $('hTitle').textContent = `历史记录 · ${hItems.length}`;

  const visible = hFilter === 'multi' ? hItems.filter((g) => g.length > 1) : hItems;

  // 选中项可能因筛选切换而不可见，但仍保留在picked 里
  // （删除时按 picked 全量执行，符合直觉：我选了就删）
  $('hlist').innerHTML = visible
    .map((grp, i) => {
      const r = grp[0];
      const key = r.fingerprint || `id:${r.id}`;
      const inner = r.thumbnail ? `<img src="${r.thumbnail}" alt="" />` : '<div class="ph"></div>';
      const badge = grp.length > 1 ? `<span class="badge">${grp.length}</span>` : '';
      const on = picked.has(key) ? ' picked' : '';
      return `<button class="hitem${on}${pickMode ? ' pick' : ''}" data-i="${i}" data-key="${escapeHtml(key)}" title="单击看大图 · 双击打开提示词 · 右键复制">
        <span class="tick"></span>${inner}${badge}
        ${pickMode ? '' : '<span class="hx" title="删除这张图的全部反推记录">✕</span>'}
      </button>`;
    })
    .join('');

  $('hEmpty').hidden = visible.length > 0;

  // 筛选按钮状态
  $('hFilters')
    .querySelectorAll('[data-filter]')
    .forEach((b) => b.classList.toggle('on', b.dataset.filter === hFilter));

  // 多选相关显隐
  $('selInfo').hidden = !pickMode || picked.size === 0;
  $('selCount').textContent = `已选 ${picked.size} 张`;
  $('clearOne').hidden = picked.size === 0;

  const cells = $('hlist').querySelectorAll('.hitem');

  // 单格叉号：删除这张图的全部反推记录
  $('hlist').querySelectorAll('.hitem .hx').forEach((hx) => {
    hx.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const el = hx.closest('.hitem');
      const grp = visible[+el.dataset.i];
      if (!grp?.length) return;
      const key = el.dataset.key;
      const ids = grp.map((r) => r.id).filter((x) => x != null);
      if (!ids.length) return;

      const ok = await askConfirm({
        title: grp.length > 1 ? `删除这 ${grp.length} 条反推记录？` : '删除这条历史记录？',
        body:
          grp.length > 1
            ? '这张图反推过多次，将全部删除。此操作无法撤销。'
            : '删除后无法恢复。此操作不会影响已收藏的提示词。',
        kind: 'history',
      });
      if (!ok) return;

      await dropRecords(ids, new Set([key]));
      picked.delete(key);
      await renderHistory();
      toast('已删除');
    });
  });

  /** 打开某张图的提示词详情 */
  const openDetail = (grp) => {
    // 记住打开前的完整现场，返回时原样还原。
    //
    // 必须存currentSiblings —— 存「刚点开那张图的组」是错的：
    // 返回时要还原的是**上一张图**的兄弟列表，
    // 拿另一张图的组去填，结果网格就会显示与主视图无关的内容。
    historyReturn = {
      record: current,
      source: lastSource,
      siblings: currentSiblings,
      // 记下点开前历史区是不是展开的，返回时原样还原。
      // 不能无脑 open = true —— 用户是在「默认折叠」下工作的，
      // 无条件展开等于每次看历史都被强制打开折叠区。
      historyWasOpen: $('history').open,
    };

    // 跳到该图最近一次的结果，同图其他记录作为结果网格一并展示
    // 返回按钮由 showRecord 内部统一开启，这里不再重复控制
    showRecord(grp[0], 'history', grp.slice(1));
    // 回到顶部，让用户看到的是这张图的大图与提示词
    $('main').scrollTop = 0;
    // 历史区收起，避免点击后还占着位置
    $('history').open = false;
  };

  // 单击 → 看大图（延迟执行，给双击留出判定窗口）
  cells.forEach((el) =>
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // 点了叉号就不要再触发放大
      if (ev.target.closest('.hx')) return;
      const grp = visible[+el.dataset.i];
      if (!grp?.length) return;

      // 多选模式：只切换选中，不看图
      if (pickMode) {
        const key = el.dataset.key;
        if (picked.has(key)) picked.delete(key);
        else picked.add(key);
        paintHistory();
        return;
      }

      const src = grp[0].fullImage || grp[0].thumbnail || '';
      clearClickTimer();
      clickTimer = setTimeout(() => {
        clickTimer = null;
        openLightbox(src);
      }, SINGLE_MS);
    })
  );
  // 双击 → 进详情页读提示词
  cells.forEach((el) =>
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (pickMode) return;
      // 取消还没执行的延迟单击 —— 否则它会在我们进详情后再弹放大层
      clearClickTimer();
      const grp = visible[+el.dataset.i];
      if (!grp?.length) return;
      closeLightbox();
      openDetail(grp);
    })
  );

  // 右键 → 直接复制这张图的提示词，省掉「打开→找到→点复制」三步。
  //
  // 多选模式下不劫持右键：这时候右键属于浏览器默认（另存图片等），
  // 用户的心智是「我在管理条目」，不是在取内容。
  cells.forEach((el) =>
    el.addEventListener('contextmenu', (ev) => {
      if (pickMode) return;
      ev.preventDefault();
      ev.stopPropagation();
      const grp = visible[+el.dataset.i];
      const rec = grp?.[0];
      if (!rec) return;
      const text = promptTextOf(rec);
      copyText(text, '已复制提示词', rec.fields?.subject?.zh || '');
    })
  );
}

/**
 * 取一条记录对应的提示词文本。
 *
 * 用记录自己的引擎渲染 —— 用户当初是按哪个引擎存的，就复制哪个，
 * 不跟着面板当前选的引擎变。
 */
function promptTextOf(rec) {
  if (rec.savedText != null) return rec.savedText;
  const r = RENDERERS[rec.engine || 'nanobanana'];
  return r.render(rec.fields || {}, rec.ratio).text;
}

/** 从 hItems 里按 key 找出整组记录的全部 id */
function idsForKey(key) {
  const grp = hItems.find((g) => (g[0].fingerprint || `id:${g[0].id}`) === key);
  return grp ? grp.map((r) => r.id).filter((x) => x != null) : [];
}

/**
 * 删掉一批记录，并处理「正在看的就是它们」的情况。
 * 单格删除与批量删除共用，避免两边行为不一致。
 *
 * @param {any[]} ids 要删的记录 id
 * @param {Set<string>} keys 这些记录对应的分组键，用于判断当前视图是否失效
 */
async function dropRecords(ids, keys) {
  await deleteRecords(ids);
  const curKey = current?.fingerprint || (current?.id != null ? `id:${current.id}` : '');
  if (curKey && keys.has(curKey)) {
    current = null;
    currentSiblings = [];
    historyReturn = null;
    $('back').hidden = true;
    $('vlist').hidden = true;
    showEmpty('历史记录已删除', '去下方「历史记录」重新选一张，或右键网页图片');
  }
}

/** 返回上一次查看的内容，没有可返回的就重新拉取最新一条 */
$('back').addEventListener('click', async () => {
  const prev = historyReturn;
  historyReturn = null;
  $('back').hidden = true;

  // 恢复历史区的展开状态 —— 点开详情时它会自动收起，返回时原样还原。
  // 还原成点开前的样子，而不是无脑展开：默认折叠的用户不该被强制打开。
  if (!$('history').hidden && prev?.historyWasOpen) $('history').open = true;

  if (prev?.record) {
    current = prev.record;
    lastSource = prev.source;
    // 还原**这张图自己的**兄弟列表（存的是点开前的现场，不是刚看的那张图的）
    showRecord(current, lastSource, prev.siblings || []);
    // 还原主视图，滚动位置也一并复位
    $('main').scrollTop = 0;
    return;
  }

  // 没有上一层：真正回到空态，让用户能去选别的图。
  // 原来这里会重新拉取 prPanel，结果刚退掉的结果又回来了 ——
  // 退无可退正是这个意思。
  current = null;
  currentSiblings = [];
  pristine = '';
  $('prompt').value = '';
  $('vlist').hidden = true;
  showEmpty('已回到空白', '在下方选一张历史，或重新右键网页图片');
  $('main').scrollTop = 0;
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// service worker 写入结果时即时渲染；onChanged 对 session storage 未必触发，
// 所以再配一个低频轮询兜底（3 秒一次，仅在等待中才开）。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.prPanel?.newValue) {
    handleState(changes.prPanel.newValue);
  }
});

let pollTimer = null;

/**
 * 全局快捷键（manifest commands）转发过来的动作。
 *
 * 复制必须由面板执行 —— 只有它知道当前 textarea 里是什么，
 * 而用户可能手动改过内容。SW 那边拿不到也不该拿。
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'PR_COPY_PROMPT') return;
  copyText($('prompt').value, '已复制提示词').then(sendResponse);
  return true; // 异步响应
});

function handleState(state) {
  if (state?.loading) startPolling();
  else stopPolling();
  consume(state);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const { prPanel } = await chrome.storage.local.get('prPanel');
    if (!prPanel || prPanel.at === consumedAt) return;
    handleState(prPanel);
    if (prPanel.record || prPanel.error) stopPolling();
  }, 3000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

boot().then(handleState);