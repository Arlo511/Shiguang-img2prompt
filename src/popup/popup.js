import { getSettings, saveSettings, resolveProvider } from '../core/api.js';
import { PROVIDERS, DEFAULT_PROVIDER, pingVision } from '../core/providers.js';
import { fromEvent, isAcceptable, isRisky, display } from '../core/shortcut.js';
import {
  listPresets, savePreset, deletePreset,
  getActiveId, setActiveId, newPresetId, getBuiltinBody,
} from '../core/presets.js';
import { DEFAULT_NAME_FORMAT, NAME_TOKENS, validateNameFormat } from '../core/naming.js';

const $ = (id) => document.getElementById(id);
let provider = DEFAULT_PROVIDER;
/**
 * 用户是否动过 API Key 输入框。
 *
 * 这个标记区分两种「输入框是空的」：
 *   a) 用户没碰过，保存后代码主动清空了（正常状态）
 *   b) 用户自己把已存的 key 删掉了，想清除它（明确意图）
 *
 * 没有它就会出这个 bug：保存成功后 `$('apiKey').value = ''` 清空输入框，
 * 下一次再点保存时空值 + 已配置 = 被当成 b)，刚存好的 key 被自己删掉 ——
 * 用户看到的现象是「保存一次就没了」。
 *
 * 声明放在模块顶部：provider 切换处（早于下面的定义）也要写它。
 */
let keyTouched = false;
/** 用户自定义的粘贴组合键，规范化串如 'Ctrl+Alt+V'；空 = 未设置 */
let pasteShortcut = '';

/**
 * 打开面板。
 *
 * 实际的绑定在 popup.html 的**内联脚本**里 —— popup.js 是 type="module"，
 * 静态 import 先于一切执行，任一依赖在加载期抛错就整个模块不执行，
 * 这里的绑定会跟着落空，表现是「按钮在、点了没反应」。
 * 那个内联脚本不依赖任何 import，是打开面板的唯一可靠入口。
 *
 * 这里仅作兜底：内联脚本已绑定时就不重复绑，避免一次点击开两个窗口。
 */
const openBtn = $('openPanel');
if (openBtn && openBtn.dataset.inlined !== '1') {
  openBtn.addEventListener('click', async () => {
    const btn = $('openPanel');
    const msg = $('opMsg');
    btn.disabled = true;
    if (msg) msg.hidden = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'PR_OPEN_PANEL' });
      if (res && res.ok === false) throw new Error(res.error || '未知错误');
      window.close();
    } catch (e) {
      btn.disabled = false;
      if (msg) {
        msg.hidden = false;
        msg.textContent = '打开面板失败：' + String((e && e.message) || e);
      }
      console.warn('[拾光] 打开面板失败', e);
    }
  });
}

/* 服务商说明只讲**选择理由**，不讲使用方法（那是官方文档的事）。
   原先写的是「默认推荐。Agnes 2.5 Flash 原生支持图像理解，且它家图像
   模型当前免费」—— 三个短句都在讲同一件事，且「当前免费」是会过期的
   信息，写死在代码里迟早变成假话。 */
const PROVIDER_HINTS = {
  agnes: '图像理解原生支持',
  deepseek: '视觉模型 ID 以控制台为准',
  gemini: '与 Nano Banana 同一个 key',
};

/** 旧版的枚举值 → 规范化串。升级后自动平替，用户不必重设 */
const LEGACY_SHORTCUT = {
  ctrlShiftV: 'Ctrl+Shift+V',
  altV: 'Alt+V',
  ctrlV: 'Ctrl+V',
};

async function boot() {
  const s = await chrome.storage.local.get(getSettings());
  provider = s.provider || DEFAULT_PROVIDER;

  $('tContextMenu').checked = s.contextMenu !== false;
  $('tDragDrop').checked = s.dragDrop === true;
  $('tPaste').checked = s.paste === true;
  // 存的是任意规范化串（如 'Ctrl+Alt+V'），不再校验是否在枚举内
  pasteShortcut = s.pasteShortcut && s.pasteShortcut !== 'none' ? s.pasteShortcut : '';

  // 旧版本存的是枚举键（ctrlShiftV 等），这里换算成规范化串并回写
  if (LEGACY_SHORTCUT[pasteShortcut]) {
    pasteShortcut = LEGACY_SHORTCUT[pasteShortcut];
    await chrome.storage.local.set({ pasteShortcut });
  }

  paintRecorder();
  syncPasteUI();

  // 开关开了但没设快捷键：明确告诉用户去录一个，
  // 而不是让粘贴功能处于「开着但永不触发」的状态
  if ($('tPaste').checked && !pasteShortcut) {
    scMsg('还未设置快捷键，点击下方按钮录制一个', true);
  }

  syncProvider();
  syncEngine(s.engine || 'nanobanana');
  await initHabits(s);

  // 提示词方案：独立初始化，且自带 catch —— 它挂了不影响其它设置
  await initPresets();

  // 弹窗每次打开都是新文档，但保险起见清一次状态行，
  // 避免上一次会话的残留提示出现在新的设置页里
  say('model', '', '', 0);
  say('trig', '', '', 0);
  say('habit', '', '', 0);
  say('backup', '', '', 0);
}

/**
 * 触发方式：勾选即保存，不依赖「保存设置」按钮。
 *
 * 之前要用户点保存才能生效，但设置弹窗一关就消失，用户很容易
 * 勾完直接关掉弹窗 —— 下次打开发现没勾上，以为"保存失败"。
 * 改成即时保存，并在状态栏明确回显存了什么。
 */
/**
 * 分区提示。提示必须出现在它描述的那块区域里——
 * 之前三处提示共用视觉模型卡片的 #status，勾选触发方式后
 * 「已生效」显示在完全不相干的位置，用户会以为是 API Key 生效了。
 *
 * @param {'trig'|'model'|'habit'|'backup'} zone
 * @param {string} text
 * @param {'ok'|'err'} kind
 * @param {number} ms 多久后自动清空；0 = 不自动清
 */
function say(zone, text, kind, ms) {
  const el = $({
    trig: 'trigStatus',
    model: 'status',
    habit: 'habitStatus',
    backup: 'backupStatus',
  }[zone] || 'status');
  if (!el) return;

  const clear = () => {
    // className 也要一起重置。只清 textContent 的话 ok/err 会一直挂着，
    // 下次打开设置时状态行还带着上一次的底色（用户反馈「保存成功后
    // 提示消失却留了一条绿边」）。
    el.className = 'status';
    el.textContent = '';
  };

  el.className = 'status' + (kind ? ' ' + kind : '');
  el.textContent = text || '';

  const key = '_t_' + zone;
  clearTimeout(say[key]);
  if (ms && text) say[key] = setTimeout(clear, ms);
}

async function persistTriggers() {
  const triggers = readTriggers();

  await chrome.storage.local.set(triggers);

  // 右键菜单开关变了要立刻重建，否则要等 SW 下次唤醒
  if (triggers.contextMenu) {
    chrome.runtime.sendMessage({ type: 'PR_SETTINGS_CHANGED' }).catch(() => {});
  }

  const active = [];
  if (triggers.contextMenu) active.push('右键');
  if (triggers.dragDrop) active.push('拖拽');
  if (triggers.paste) {
    active.push(pasteShortcut ? `粘贴(${display(pasteShortcut)})` : '粘贴（未设快捷键）');
  }

  say(
    'trig',
    active.length
      ? `已生效：${active.join('、')}`
      : '触发方式已全部关闭',
    active.length ? 'ok' : '',
    3200
  );
}

['tContextMenu', 'tDragDrop', 'tPaste'].forEach((id) => {
  $(id).addEventListener('change', () => {
    syncPasteUI();
    persistTriggers();
  });
});

/**
 * 快捷键录制。
 *
 * 交互：点按钮进入待录状态 → 用户按下想用的组合键 → 直接存。
 * 不用下拉预设，因为预设表必然漏（表外组合会静默失效），
 * 而且 Ctrl+Shift+V 在 Chrome 里是「粘贴为纯文本」，压根取不到图。
 *
 * 必须 preventDefault：否则 Ctrl+W 会关掉标签页、
 * Ctrl+T 会在后台开新标签，弹窗在用户设完之前就消失了。
 */
let recording = false;

function paintRecorder() {
  const rec = $('scRec');
  if (!rec) return;
  rec.dataset.armed = recording ? '1' : '0';
  $('scVal').textContent = recording ? '按下组合键…' : pasteShortcut ? display(pasteShortcut) : '未设置';
  $('scHint').textContent = recording ? 'Esc 取消' : '点击后按下组合键';
}

function scMsg(text, warn) {
  const el = $('scMsg');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'hint' + (warn ? ' warn' : '');
}

$('scRec')?.addEventListener('click', () => {
  recording = true;
  paintRecorder();
  scMsg('');
});

document.addEventListener('keydown', (e) => {
  if (!recording) return;

  // Esc / 失焦取消，且不写任何设置
  if (e.key === 'Escape') {
    recording = false;
    paintRecorder();
    scMsg('');
    e.preventDefault();
    return;
  }

  const combo = fromEvent(e);
  if (!combo) {
    // 只按了修饰键，等下一击
    e.preventDefault();
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  if (!isAcceptable(combo)) {
    recording = false;
    paintRecorder();
    scMsg('这个组合太容易误触，请至少带 Ctrl / Alt / Shift 中的一项', true);
    return;
  }

  if (isRisky(combo)) {
    recording = false;
    paintRecorder();
    scMsg('这个组合被浏览器占用，网页里收不到，换一个', true);
    return;
  }

  pasteShortcut = combo;
  recording = false;
  paintRecorder();
  scMsg(`已保存：${display(combo)}`);
  // 设了快捷键就顺手把开关打开，否则用户录完还要再去勾一次
  if (!$('tPaste').checked) $('tPaste').checked = true;
  syncPasteUI();
  persistTriggers();
});

// 点到别处就结束录制状态，避免用户录完忘了点回来
document.addEventListener('click', (e) => {
  if (!recording) return;
  if ($('scRec')?.contains(e.target)) return;
  recording = false;
  paintRecorder();
});

/**
 * 粘贴开关与快捷键联动。
 *
 * 关键：不要在这里清空 pasteShortcut。
 * 之前 select 版本写成「关闭时强制设为 none」，结果用户关一次再开，
 * 之前设好的组合就被抹掉了 —— 表现为「勾选后无法保存」。
 */
function syncPasteUI() {
  const on = $('tPaste').checked;
  const rec = $('scRec');
  if (rec) {
    rec.disabled = !on;
    rec.style.opacity = on ? '' : '.45';
    rec.title = on ? '' : '需先开启「快捷键粘贴图片」';
  }
}

/** 读取触发设置（关闭粘贴时保留快捷键值，不抹掉用户的输入） */
function readTriggers() {
  return {
    contextMenu: $('tContextMenu').checked,
    dragDrop: $('tDragDrop').checked,
    paste: $('tPaste').checked,
    pasteShortcut: $('tPaste').checked ? pasteShortcut || 'none' : 'none',
  };
}

function syncProvider() {
  const p = PROVIDERS[provider];

  document.querySelectorAll('#provider button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.p === provider))
  );

  $('provHint').textContent = PROVIDER_HINTS[provider] || '';
  $('keyHint').textContent = p.keyHint;
  $('keyLabel').textContent = `${p.label} API Key`;
  $('docs').href = p.docs;

  const sel = $('model');
  sel.innerHTML = p.models
    .map((m) => `<option value="${m}">${m}</option>`)
    .join('');
  if (p.models.includes(p.defaultModel)) sel.value = p.defaultModel;

  // 切provider 时载入已存的 key（不回显明文，只显示是否已配置）。
  // 占位符顺带说明「怎么清除」——清除不再是「留空自动删」，
  // 必须明确告诉用户「框里删干净再保存」，否则他找不到清掉的入口。
  chrome.storage.local.get(getSettings()).then((s) => {
    $('apiKey').placeholder = s.keys?.[provider]
      ? '已配置 · 粘贴可覆盖，清空后保存可删除'
      : '粘贴 API Key';
  });
}
function syncEngine(engine) {
  document.querySelectorAll('#engine button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.engine === engine))
  );
}

$('provider').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  provider = b.dataset.p;
  $('apiKey').value = '';
  // 切服务商时清空输入框是我们做的，不是用户想删这个服务商的 key
  keyTouched = false;
  syncProvider();
});

$('engine').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) syncEngine(b.dataset.engine);
});

/**
 * 用户是否动过 API Key 输入框 —— 见文件顶部 keyTouched 的说明。
 */
$('apiKey').addEventListener('input', () => { keyTouched = true; });

$('save').addEventListener('click', async () => {
  // 触发方式已由 persistTriggers 即时保存，这里只处理
  // API Key / 模型等需要显式提交的配置
  const s = await chrome.storage.local.get(getSettings());
  const keys = { ...(s.keys || {}) };
  const typed = $('apiKey').value.trim();
  let cleared = false;

  if (typed) {
    keys[provider] = typed;
  } else if (keyTouched) {
    // 用户确实动过这个框且留空 —— 意图是清除已存的 key
    delete keys[provider];
    cleared = true;
  }
  // else: 输入框是空的且用户没碰过 → 保持已存的 key 不动。
  // 什么都不做才是对的：不能因为「框里没字」就删掉用户的密钥。

  await saveSettings({
    provider,
    keys,
    model: $('model').value,
    engine: document.querySelector('#engine button[aria-pressed="true"]').dataset.engine,
  });

  // 顺带把触发设置也同步一遍（保持数据一致）
  await chrome.storage.local.set(readTriggers());

  $('apiKey').value = '';
  // 保存后重置标记：清空是我们主动做的，不该被算成「用户想删除」
  keyTouched = false;
  syncProvider();
  if (cleared) say('model', '已清除该服务商的 API Key', 'ok', 2600);
  else if (typed) say('model', '已保存设置', 'ok', 2200);
});

$('test').addEventListener('click', async () => {
  // 测试中：不设自动消失。等网络返回，成功或失败后再由下面的分支决定时长
  say('model', '测试中…', '', 0);
  const btn = $('test');
  btn.disabled = true;

  try {
    const typed = $('apiKey').value.trim();
    const s = await chrome.storage.local.get(getSettings());
    const key = typed || s.keys?.[provider];
    if (!key) throw new Error(`请先填写 ${PROVIDERS[provider].label} API Key`);

    const r = await pingVision({ provider, apiKey: key, model: $('model').value });
    // 成功与失败都是「回执」而非状态，停留几秒即可。
    // 早先不传时长（等于永久），用户反馈连接正常四个字一直挂着不走。
    say('model', `连接正常 · ${r.model}`, 'ok', 3000);
  } catch (e) {
    // 报错文本往往较长（缺 Key、401、模型不存在……），给 6 秒让用户读完
    say('model', String(e.message || e), 'err', 6000);
  } finally {
    btn.disabled = false;
  }
});

/* ============================================================
   提示词方案：多套保存与切换
   ============================================================ */
let presets = [];
let currentPresetId = 'builtin';
/** 正文是否已被用户改过 —— 决定切换方案时要不要提示丢弃 */
let bodyDirty = false;
/** 内置提示词的展示副本，供用户在此基础上改 */
let builtinBody = '';

async function refreshPresets() {
  presets = await listPresets();
  currentPresetId = await getActiveId();
  paintPresetKeyHint();

  const sel = $('presetSel');
  if (!sel) return;
  sel.innerHTML = '';
  for (const p of presets) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    if (p.id === currentPresetId) o.selected = true;
    sel.appendChild(o);
  }
  renderPresetEditor();
}

function currentPreset() {
  return presets.find((p) => p.id === currentPresetId) || presets[0];
}

/**
 * 生成一个不与现有方案重名的默认名。
 *
 * 直接用「新方案」会在第二次新建时撞名 —— 而 listPresets 里
 * 允许重名（只按 id 索引），于是下拉框里出现两个「新方案」，
 * 用户分不清哪个是刚建的，删的时候也不知道删的是哪一个。
 */
function nextPresetName() {
  const taken = new Set(presets.map((p) => p.name));
  if (!taken.has('新方案')) return '新方案';
  for (let i = 2; i < 100; i++) {
    const n = `新方案 ${i}`;
    if (!taken.has(n)) return n;
  }
  return `新方案 ${Date.now()}`;
}

/**
 * 显示切换方案的快捷键。
 *
 * 读 chrome.commands 而不是写死字符串：用户可以在
 * chrome://extensions/shortcuts 里改，写死会跟他实际按的不一致。
 * 读不到（老版本 API 缺失）就不显示这一行，不给错信息。
 */
async function paintPresetKeyHint() {
  const el = $('presetKeyHint');
  if (!el) return;
  try {
    const cmds = await chrome.commands?.getAll?.();
    const c = (cmds || []).find((x) => x.name === 'cycle-preset');
    const n = presets.length;
    if (!c || !c.shortcut) {
      el.textContent = n > 1
        ? `可在扩展管理页的「快捷键」里设置切换按键（共 ${n} 套）`
        : '';
      return;
    }
    el.textContent = n > 1
      ? `${display(c.shortcut)} 切换下一个方案（共 ${n} 套）`
      : `${display(c.shortcut)} 切换方案 · 先另存为才有得切`;
  } catch {
    el.hidden = true;
  }
}

function renderPresetEditor() {
  const p = currentPreset();
  const box = $('presetActions');
  if (!box) return;

  const isBuiltin = !!(p && p.builtin);

  // 编辑区始终显示。
  //
  // 原来内置方案时把整个编辑区藏了 —— 结果用户看到「默认」选中，
  // 却找不到任何地方写自己的提示词，形成死路。
  // 现在内置时预填当前默认提示词，用户在此基础上改即可。
  box.hidden = false;

  $('presetName').value = isBuiltin ? '默认' : p.name;
  $('presetBody').value = isBuiltin ? builtinBody : p.body;

  // 内置不可删：它是恢复出厂的锚点。
  // 没有「恢复默认」按钮后，回退路径只剩这一条：
  // 选中「默认」即可看到内置正文，用户照着改回来或另存都行。
  $('presetDelete').disabled = isBuiltin;

  bodyDirty = false;
  updatePresetHint();
}

/** 空正文会被 getActiveBody() 当成「没写」而回落到默认 —— 必须提示 */
function updatePresetHint() {
  const hint = $('presetHint');
  const body = ($('presetBody')?.value || '').trim();
  const name = ($('presetName')?.value || '').trim();

  const problems = [];
  if (!body) problems.push('正文为空，保存后会回落到默认提示词');
  if (!name) problems.push('方案没有名称');

  if (!hint) return;
  hint.textContent = problems.join('；');
  hint.hidden = problems.length === 0;
}

async function commitPreset() {
  const p = currentPreset();
  const body = $('presetBody').value.trim();
  const name = $('presetName').value.trim() || '未命名';

  // 内置方案不可被覆盖 —— 改为另存为新方案并自动切换过去。
  // 这样「改了内置的内容 → 保存」是一个自然动作，不需要用户先懂
  // 「另存为」和「编辑」的区别。
  const isBuiltin = !!(p && p.builtin);
  const id = isBuiltin ? newPresetId() : p.id;

  if (isBuiltin) {
    await savePreset({
      id,
      name: name === '默认' ? '自定义' : name,
      body,
    });
    await setActiveId(id);
  } else {
    await savePreset({ id, name, body });
  }

  bodyDirty = false;
  await refreshPresets();
  flash($('presetSave'), '已保存');
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = old;
    btn.disabled = false;
  }, 1100);
}

async function initPresets() {
  // 方案功能失败绝不能拖垮整个设置页 —— 用户还要改 Key 和快捷键
  try {
    builtinBody = await getBuiltinBody();

    await refreshPresets();

    $('presetSel')?.addEventListener('change', async (e) => {
      const next = e.target.value;
      if (bodyDirty && !confirm('当前提示词还没保存，切换会丢弃修改。继续？')) {
        e.target.value = currentPresetId; // 撤销选择
        return;
      }
      await setActiveId(next);
      currentPresetId = next;
      renderPresetEditor();
    });

  $('presetBody')?.addEventListener('input', () => {
    bodyDirty = true;
    updatePresetHint();
  });
  $('presetName')?.addEventListener('input', updatePresetHint);

  $('presetSave')?.addEventListener('click', () => {
    commitPreset().catch((err) => console.warn('[拾光] 保存方案失败', err));
  });

    // 「新建」= 建一套**空白**方案，不是复制当前这套。
    //
    // 原来的「复制」是「以当前内容另存一份」，但那条路径已经由
    // commitPreset 覆盖了：选中内置时点保存会自动另存为。
    // 再叠一个「复制」就是第三种通往同一结果的按钮。
    $('presetNew')?.addEventListener('click', async () => {
      if (bodyDirty && !confirm('当前提示词还没保存，新建会丢弃修改。继续？')) return;

      const id = newPresetId();
      await savePreset({ id, name: nextPresetName(), body: '' });
      await setActiveId(id);
      await refreshPresets();
      // 直接聚焦名称框：新建完第一件事一定是改名字，
      // 让用户自己去找输入框等于把这一步推给记忆。
      $('presetName')?.focus();
      $('presetName')?.select();
    });

    $('presetDelete')?.addEventListener('click', async () => {
      const p = currentPreset();
      if (!p || p.builtin) return;
      if (!confirm(`删除方案「${p.name}」？`)) return;
      await deletePreset(p.id);
      await refreshPresets();
    });
  } catch (e) {
    console.warn('[拾光] 提示词方案初始化失败', e);
    const hint = $('presetHint');
    if (hint) {
      hint.textContent = '提示词方案功能不可用：' + String(e?.message || e);
      hint.hidden = false;
    }
  }
}

/* ============================================================
   使用习惯：自动复制 / 折叠状态 / 命名格式
   ============================================================ */

/**
 * 读回并绑定「使用习惯」。
 *
 * 与触发方式一致：勾选即保存，不点「保存设置」。
 * 用户勾完直接关弹窗是常态，等他点保存只会以为没生效。
 */
async function initHabits(s) {
  // 旧版本是一个 foldsOpen 总开关。升到两个独立开关时，
  // 照搬它的值 —— 用户当初打开的是「两个都展开」的意图，
  // 静默丢成一个都没开等于设置失效（且他不知道为什么）。
  const oldFolds = s.foldsOpen === true;
  $('tAutoCopy').checked = s.autoCopy === true;
  $('tFavOpen').checked = oldFolds || s.favOpen === true;
  $('tHistOpen').checked = oldFolds || s.histOpen === true;
  $('nameFormat').value = s.nameFormat || DEFAULT_NAME_FORMAT;
  paintTokens();
  paintNameHint();

  const persist = async () => {
    const fmt = validateNameFormat($('nameFormat').value);
    if (!fmt.ok) {
      // 模板不合法时**照存不误**，只是明确告诉他哪里不对。
      // 静默改回默认会让他以为自己打的字生效了。
      await chrome.storage.local.set({ nameFormat: $('nameFormat').value });
      say('habit', `命名格式未保存：${fmt.msg}`, 'err', 5000);
      return;
    }
    await chrome.storage.local.set({
      autoCopy: $('tAutoCopy').checked,
      favOpen: $('tFavOpen').checked,
      histOpen: $('tHistOpen').checked,
      nameFormat: $('nameFormat').value.trim(),
    });
    // 旧的 foldsOpen 清掉：留着的话下次迁移又会把两个开关都打开，
    // 用户已经调过的偏好被历史值覆盖回来。
    await chrome.storage.local.remove('foldsOpen');
    say('habit', '已保存', 'ok', 2000);
  };

  $('tAutoCopy').addEventListener('change', persist);
  $('tFavOpen').addEventListener('change', persist);
  $('tHistOpen').addEventListener('change', persist);

  // 输入框去抖 400ms。
  // 不去抖的话每敲一个字符就写一次 storage、还闪一次提示 ——
  // 而打「{seq}」这种中途必然非法的中间态，会连着弹三条红色报错。
  let fmtTimer = 0;
  $('nameFormat').addEventListener('input', () => {
    paintNameHint();
    clearTimeout(fmtTimer);
    fmtTimer = setTimeout(() => persist().catch(() => {}), 400);
  });

  // 失焦立刻落盘：用户点走时不该还有 400ms 的窗口期丢输入
  $('nameFormat').addEventListener('blur', () => {
    clearTimeout(fmtTimer);
    persist().catch(() => {});
  });
}

function paintNameHint() {
  const v = validateNameFormat($('nameFormat').value);
  const el = $('nameFmtMsg');
  el.textContent = v.ok ? '' : v.msg;
  el.className = 'hint' + (v.ok ? '' : ' warn');
  el.hidden = v.ok;
}

/** 占位符芯片：点一下插到输入框光标处，省得手打 */
function paintTokens() {
  const box = $('nameTokens');
  if (!box) return;
  box.innerHTML = '';
  for (const t of NAME_TOKENS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.token;
    b.dataset.desc = t.desc;
    b.title = `插入 ${t.token}（${t.desc}）`;
    b.addEventListener('click', () => {
      const input = $('nameFormat');
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + t.token + input.value.slice(end);
      const at = start + t.token.length;
      input.focus();
      input.setSelectionRange(at, at);
      paintNameHint();
      input.dispatchEvent(new Event('input'));
    });
    box.appendChild(b);
  }
}

/* ============================================================
   导出 / 导入设置
   ============================================================ */

/** 会一起备份的键。刻意不含历史与收藏 —— 那是 IndexedDB，不是设置。 */
const BACKUP_KEYS = [
  'provider', 'keys', 'model', 'engine',
  'contextMenu', 'dragDrop', 'paste', 'pasteShortcut',
  'autoCopy', 'favOpen', 'histOpen', 'nameFormat',
  'promptPresets', 'promptActiveId', 'prSkipConfirm',
];

const BACKUP_VERSION = 1;

$('btnExport').addEventListener('click', async () => {
  const btn = $('btnExport');
  btn.disabled = true;
  try {
    const all = await chrome.storage.local.get(BACKUP_KEYS);
    const payload = {
      app: 'shiguang-img2prompt',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      data: {},
    };
    for (const k of BACKUP_KEYS) {
      // Key 默认不导出：明文密钥写进文件落在磁盘上，
      // 用户不一定知道。勾了才带。
      if (k === 'keys' && !$('expKeys').checked) continue;
      if (all[k] !== undefined) payload.data[k] = all[k];
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    a.href = url;
    a.download =
      `拾光设置-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
    a.click();
    // 不 revoke 的话 blob 会一直被这个页面引用，内存不释放
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    const n = Object.keys(payload.data).length;
    say('backup', `已导出 ${n} 项${$('expKeys').checked ? '，含 API Key' : ''}`, 'ok', 3500);
  } catch (e) {
    say('backup', '导出失败：' + String(e?.message || e), 'err', 5000);
  } finally {
    btn.disabled = false;
  }
});

$('btnImport').addEventListener('click', () => $('fileImport').click());

$('fileImport').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // 允许重复选同一个文件再次触发
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    say('backup', '这不是有效的 JSON 文件', 'err', 4000);
    return;
  }

  const data = payload?.data;
  if (!data || typeof data !== 'object') {
    say('backup', '文件格式不对：缺少 data 字段', 'err', 5000);
    return;
  }

  // 只接受白名单里的键，避免一个手改的文件往 storage 里塞任意字段
  const patch = {};
  for (const k of BACKUP_KEYS) {
    if (data[k] !== undefined) patch[k] = data[k];
  }
  const n = Object.keys(patch).length;
  if (!n) {
    say('backup', '文件里没有可导入的设置', 'err', 4000);
    return;
  }

  if (!confirm(`将覆盖 ${n} 项当前设置（含提示词方案），确定导入？`)) return;

  try {
    await chrome.storage.local.set(patch);
    say('backup', `已导入 ${n} 项`, 'ok', 1200);
    // 提示词方案换了要重建下拉，右写右键菜单要重建
    chrome.runtime.sendMessage({ type: 'PR_SETTINGS_CHANGED' }).catch(() => {});
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    say('backup', '导入失败：' + String(err?.message || err), 'err', 5000);
  }
});


// boot() 内部已调用 initPresets()，这里不再重复调用
//
// 这一行必须在：它曾是「包装 boot」代码块的一部分，被我误删，
// 结果整个模块加载后什么都不执行 —— 表现为保存设置失效、
// 触发方式不生效、提示词方案下拉框为空。三个症状同一个根因。
boot();