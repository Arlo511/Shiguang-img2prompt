/**
 * Provider 注册表 —— 理解层（视觉反推）的可切换后端。
 *
 * 两类协议：
 *   openai  OpenAI 兼容系（Agnes / DeepSeek）—— messages + image_url
 *   gemini  Gemini 系—— contents + inline_data + responseSchema
 *
 * 字段层只依赖本文件导出的 callVision()，新增服务商只需在这里加一条。
 */

export const PROVIDERS = {
  agnes: {
    id: 'agnes',
    label: 'Agnes',
    protocol: 'openai',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    endpoint: '/chat/completions',
    defaultModel: 'agnes-2.5-flash',
    models: ['agnes-2.5-flash', 'agnes-2.5-pro-beta', 'agnes-2.5-pro-alpha'],
    supportsJsonMode: true,
    supportsSchema: false,
    keyHint: 'Agnes AI 控制台创建', // Base URL 已内置，不用配
    docs: 'https://agnes-ai.com/doc/agnes-25-flash',
  },

  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    endpoint: '/chat/completions',
    defaultModel: 'deepseek-v4-flash-vision-exp',
    models: ['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
    supportsJsonMode: true,
    supportsSchema: false,
    keyHint: 'DeepSeek 开放平台创建', // 模型 ID 的说明已放到上方服务商说明
    docs: 'https://api-docs.deepseek.com/guides/vision',
  },

  gemini: {
    id: 'gemini',
    label: 'Nano Banana (Gemini)',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    endpoint: '',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    supportsJsonMode: true,
    supportsSchema: true,
    keyHint: 'Google AI Studio 创建',
    docs: 'https://ai.google.dev/gemini-api/docs',
  },
};

export const DEFAULT_PROVIDER = 'agnes';

/** 探测用：轻量请求，验证 key 与模型可用 */
export async function pingVision({ provider, apiKey, model }) {
  const p = resolve(provider, apiKey, model);
  if (!p) throw new Error('未配置 API Key');

  if (p.protocol === 'gemini') {
    const res = await fetch(`${p.baseUrl}/${p.model}?key=${p.apiKey}`);
    if (!res.ok) throw new Error(`Gemini 返回 ${res.status}`);
    return { ok: true, model: p.model };
  }

  const res = await fetch(`${p.baseUrl}${p.endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.apiKey}`,
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${p.label} 返回 ${res.status}${t ? ' · ' + t.slice(0, 160) : ''}`);
  }
  return { ok: true, model: p.model };
}

function resolve(provider, apiKey, model) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  return {
    ...p,
    apiKey,
    model: model || p.defaultModel,
  };
}

/**
 * 调用视觉模型完成字段反推。
 *
 * @param {object} cfg
 * @param {string} cfg.provider    provider id
 * @param {string} cfg.apiKey
 * @param {string} cfg.model
 * @param {string} cfg.imageBase64
 * @param {string} cfg.mimeType
 * @param {string} cfg.prompt      字段层提示词
 * @param {object} cfg.schema      响应 JSON Schema（仅 gemini 用）
 * @param {AbortSignal} [cfg.signal]
 */
export async function callVision(cfg) {
  const p = resolve(cfg.provider, cfg.apiKey, cfg.model);
  if (!p) throw new Error(`未知的 provider：${cfg.provider}`);
  if (!p.apiKey) throw new Error(`尚未配置 ${p.label} API Key`);

  return p.protocol === 'gemini'
    ? callGemini({ ...cfg, p })
    : callOpenAICompatible({ ...cfg, p });
}

async function callGemini({ p, imageBase64, mimeType, prompt, schema, signal }) {
  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      // 关键：responseMimeType 必须跟着 schema 走，不能写死。
      //
      // 用户自定义提示词时 schema 为 null，而自定义的内容并不要求 JSON 输出 ——
      // 此时若仍声明 application/json，Gemini 会被强制返回 JSON，
      // 于是得到一个空对象 {}，所有字段为空，界面显示「未命名图片」。
      // 下发给 schema 才同时下发 mimeType，两者必须成对。
      ...(schema
        ? { responseMimeType: 'application/json' }
        : {}),
      ...(p.supportsSchema && schema ? { responseSchema: schema } : {}),
    },
  };

  const res = await fetch(`${p.baseUrl}/${p.model}:generateContent?key=${p.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status} · ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || '';
  return extractJson(text);
}

async function callOpenAICompatible({ p, imageBase64, mimeType, prompt, schema, signal }) {
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;

  // 自定义提示词时不开JSON 模式 ——
  // 否则模型被迫返回 JSON，而用户的指令并不要求这个结构，
  // 结果多半是空对象。
  const wantJson = !!schema && p.supportsJsonMode;

  const send = async (useJsonMode) => {
    const body = {
      model: p.model,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    };
    if (useJsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${p.baseUrl}${p.endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const t = await res.text();
      const err = new Error(`${p.label} ${res.status} · ${t.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  };

  let text;
  try {
    text = await send(wantJson);
  } catch (e) {
    // 部分兼容实现不支持 response_format，降级重试一次
    if (e.status === 400 && wantJson) text = await send(false);
    else throw e;
  }
  return extractJson(text);
}

/**
 * 模型偶尔会在JSON 外包一层代码块或加前后缀，做一次稳健提取
 *
 * 允许「非 JSON 也算成功」：用户可以完全自定义提示词，
 * 那么模型返回一段纯文本是**预期内**的结果，不是错误。
 * 这时把全文塞进 composition —— 渲染层照样能出一份可用的提示词，
 * 好过整个反推失败、白跑一次 API。
 */
function extractJson(raw) {
  if (!raw) throw new Error('模型未返回内容');
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(text);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* 落到下面的自由文本处理 */
    }
  }
  // 自由文本兜底：当作已写好的描述直接用
  const free = text.trim();
  if (!free) throw new Error('模型未返回内容');
  console.warn('[拾光] 模型返回非 JSON，按自由文本处理');

  // 按实际语种归位，不要把英文硬塞进 zh。
  //
  // 原写法是 { en: free, zh: free } —— 中文栏因此显示英文，
  // 而用户看不出那是英文，只以为插件坏了。
  // 现在：检测到中文就填 zh（en 也填一份），纯英文就只填 en。
  // 渲染层已有 zh → en 的回落，所以只填 en 时中文栏也能显示内容，
  // 不会空白；差别在于不再谎称那是中文。
  const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(free);
  if (hasCjk) {
    return { composition: { en: free, zh: free } };
  }
  return {
    composition: { en: free },
    // 标记出来，界面据此提示「自定义提示词没按双语要求返回」
    __singleLang: true,
  };
}