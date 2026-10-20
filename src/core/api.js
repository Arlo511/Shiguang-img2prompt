/**
 * API 接入层：两种信任边界
 *   byok用户自带 key，请求直接从插件发出，图片不经过任何第三方
 *   public    公共服务，插件只持用户 token，图片上传到服务方服务器（本版仅预留接口）
 */

import { PROVIDERS, DEFAULT_PROVIDER } from './providers.js';
import { reverseToFields } from './vlm.js';
import { getActiveBody, withLanguageHint } from './presets.js';

const PUBLIC_ENDPOINT = ''; // TODO: 填入公共服务地址后启用

/**
 * 触发方式开关。
 *
 * 三种方式的可靠性与干扰性不同，默认全关除右键外：
 *   - 右键：主推，最可靠，零误触
 *   - 粘贴：Ctrl+V 在任何页面都可能误触（尤其是网页编辑器里），
 *          所以默认关闭，且快捷键可自定义
 *   - 拖拽：容易与手势类扩展冲突（它们也监听 dragover/drop），
 *          默认关闭
 */
export const TRIGGERS = {
  contextMenu: true,
  paste: false,
  dragDrop: false,
  // 规范化快捷键字符串，如 'Ctrl+Shift+V' / 'Alt+V'。
  // 由用户在设置页按下组合键录制，不走预设枚举 —— 枚举表必然漏，
  // 且 Ctrl+Shift+V 在 Chrome 里是「粘贴为纯文本」，取不到图片。
  pasteShortcut: 'none',
};

export function getSettings() {
  return {
    mode: 'byok',
    provider: DEFAULT_PROVIDER,
    keys: {},          // { [providerId]: apiKey }
    model: '',         // 空 = 用该 provider 的默认模型
    publicToken: '',
    publicEndpoint: PUBLIC_ENDPOINT,
    engine: 'nanobanana',

    // 反推成功后立刻把当前引擎的提示词写进剪贴板。
    // 默认关：自动改写用户剪贴板是有副作用的行为，不该默认开启。
    autoCopy: false,

    // 面板打开时收藏/历史各自的折叠状态。
    // 分开而不是一个总开关：收藏通常只有三五张、值得常开，
    // 历史每天几十条，展开会把首屏结果区挤下去 —— 两者偏好常常不一致。
    // 默认全折叠（用户明确要求过）。
    favOpen: false,
    histOpen: false,

    // 记录命名模板，占位符见 core/naming.js
    nameFormat: '{date} {time}-{site}-{seq}',

    ...TRIGGERS,
  };
}

export async function saveSettings(patch) {
  const next = { ...(await chrome.storage.local.get(getSettings())), ...patch };
  await chrome.storage.local.set(next);
  return next;
}

export function resolveProvider(s) {
  const id = s.provider || DEFAULT_PROVIDER;
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

export async function ensureReady() {
  const s = await chrome.storage.local.get(getSettings());
  if (s.mode === 'byok') {
    const p = resolveProvider(s);
    const key = s.keys?.[p.id];
    if (!key) throw new Error(`尚未配置 ${p.label} API Key，请点击插件图标进入设置`);
  }
  if (s.mode === 'public' && !s.publicEndpoint) {
    throw new Error('公共服务尚未启用，请先在设置中切换为自带 Key 模式');
  }
  return s;
}

/**
 * 统一的字段反推入口，按 mode 分发。
 * @returns {Promise<{fields: object, provider: string}>}
 */
export async function reverseImage({ imageBase64, mimeType, signal }) {
  const s = await ensureReady();

  // 取当前激活的提示词方案正文。null = 用内置默认。
  //
  // 自定义方案补一条双语要求：内置提示词本身就要求 en+zh，
  // 自定义的通常不写语言，模型会默认输出英文 —— 中文栏就废了。
  const rawPrompt = await getActiveBody();
  const customPrompt = rawPrompt ? withLanguageHint(rawPrompt) : null;

  if (s.mode === 'byok') {
    const p = resolveProvider(s);
    const fields = await reverseToFields({
      provider: p.id,
      apiKey: s.keys?.[p.id],
      model: s.model,
      imageBase64,
      mimeType,
      signal,
    }, customPrompt);
    return { fields, provider: p.id };
  }

  // 公共服务：预留契约，切到public 模式即可用，无需改前端
  const res = await fetch(s.publicEndpoint + '/reverse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.publicToken || ''}`,
    },
    body: JSON.stringify({ image: imageBase64, mimeType }),
    signal,
  });
  if (!res.ok) throw new Error(`公共服务 ${res.status}`);
  return { fields: (await res.json()).fields, provider: 'public' };
}