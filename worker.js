/**
 * AI 随身翻译 —— 单文件 Cloudflare Worker（v2.1 加固版）
 *
 * 部署：连接 GitHub（Workers Builds）或本地 `npx wrangler deploy`
 * 依赖：wrangler.jsonc 中的 `ai.binding = "AI"`（无需创建任何资源）
 *
 * 路由：
 *   POST /api/translate       翻译接口（支持流式 SSE）
 *   POST /api/tts             语音合成接口（Workers AI TTS，返回音频流）
 *   GET  /api/health          健康检查（不调用模型，零 token 成本）
 *   GET  /manifest.json       PWA manifest
 *   GET  /sw.js               Service Worker
 *   GET  /icon.svg            应用图标（普通）
 *   GET  /icon-maskable.svg   应用图标（maskable）
 *   GET  /icon.png            旧路径别名，返回同一份 SVG
 *   GET  /favicon.ico         地址栏图标（返回 SVG，省一个 404）
 *   GET  /                    应用页面
 *
 * 安全说明：API 有意不开放跨域（CORS），仅同源页面可调用；
 * 如需跨域使用，请自行添加来源白名单，不要图省事写 `Access-Control-Allow-Origin: *`。
 *
 * Changelog v2.1（本次加固）
 *   - 限流：每 IP 滑动窗口（isolate 内存态，近似精确，配合 CF 全局限额使用）
 *   - 请求体先读文本再解析，带大小闸门，杜绝超大/畸形 JSON 拖垮 isolate
 *   - 模型故障转移：主模型额度/容量不足时自动切换备选模型
 *   - 按模型上下文动态压缩 max_tokens，输入超长时不再触发 context 溢出
 *   - 错误响应不再透传内部细节；统一写入 Workers 日志（observability）
 *   - 新增 CSP / HSTS / COOP / X-Robots-Tag 安全响应头
 *   - 源语言缺省改为 auto；语种扩到 15 种（朗读 / OCR / 语种检测同步补齐）
 *   - 修复语种检测优先级：含日文汉字的句子不再被误判为中文
 *   - TTS 整体替换：浏览器 speechSynthesis → Workers AI TTS；
 *     英文原用 Deepgram Aura-2 出现音频拼接异常（读得很乱），
 *     现全语种统一 MeloTTS，并补 ReadableStream 读取合并与空音频防护
 *   - 前端：流式光标、debounce 定时器清理、OCR 降采样与防重复拍照、
 *           文本域高度封顶、SW 更新提示、历史面板 inert / 焦点管理
 *
 * Changelog v2.0（相对初版）
 *   - 修复历史记录 innerHTML 注入导致的存储型 XSS
 *   - 修复快速输入时旧响应覆盖新响应的竞态（AbortController + 请求序号）
 *   - 补上 max_tokens / temperature，长文本不再被默认 256 token 截断
 *   - 输入长度上限与前后端一致的校验
 *   - 流式输出，译文逐字出现
 *   - Service Worker 改为白名单 + 版本化 + activate 清旧缓存 + 跳过非 GET
 *   - 图标与 manifest 类型修正，补 maskable 图标
 *   - 朗读/OCR 语言表补全，源语言支持「自动检测」
 *   - Toast 动画与定时器、复制兜底、摄像头错误分类、OCR 进度
 */

// 主模型：默认走 wrangler.jsonc 里 vars.MODEL，未配置时用这个
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// 主模型不可用或额度不足时的降级备选（均为当前 Workers AI 在线模型）
const FALLBACK_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/zai-org/glm-4.7-flash'
];

// 语音合成（TTS）模型：
//   主路径：全语种统一 @cf/myshell-ai/melotts，处理路径只有一条、行为可预期
//   （注意：它的必填参数叫 prompt 不是 text，默认 lang=en；曾因传错参数整条链路 502）
//   降级链：melotts 失败时，英文自动换 @cf/deepgram/aura-2-en（speaker=luna）
//   （Aura-2 此前表现「读得很乱」，疑似分块流未合并所致，toAudioBytes 已支持读全合并）
const TTS_MODEL = '@cf/myshell-ai/melotts';
const TTS_MODEL_AURA_EN = '@cf/deepgram/aura-2-en';
const TTS_SPEAKER_AURA = 'luna';
const TTS_MAX_CHARS = 1000;            // 单次合成字符上限（兼顾时长与延迟）

const MAX_INPUT_CHARS = 3000;      // 单次翻译字符上限（前后端一致）
const MAX_BODY_BYTES = 32 * 1024;  // 请求体大小闸门
const MAX_TOKENS = 4096;           // 单次生成上限
const CONTEXT_TOKENS = 8192;       // 主模型的保守上下文窗口，用于动态压缩 max_tokens
const RESERVED_TOKENS = 512;       // 给 system prompt 与采样余量留的缓冲
const TEMPERATURE = 0.2;           // 翻译任务低温求稳
const SW_VERSION = 'ai-trans-v3';
const HISTORY_LIMIT = 50;

// 每 IP 限流（内存态，接近精确；跨 isolate 不共享，属于第一道闸门而非硬限制）
const RATE_LIMIT = { WINDOW_MS: 60000, MAX_REQUESTS: 30 };
const rateBuckets = new Map(); // ip -> { count, resetAt }
let lastSweepAt = 0;

// 语言 key -> 给模型看的英文名。key 同时是前端 select 的 value。
// 新增语言时同步维护前端两个 select、SPEECH_LANG、OCR_LANG 四张表。
const LANG_NAMES = {
  chinese: 'Simplified Chinese',
  english: 'English',
  japanese: 'Japanese',
  korean: 'Korean',
  french: 'French',
  german: 'German',
  spanish: 'Spanish',
  russian: 'Russian',
  italian: 'Italian',
  portuguese: 'Portuguese',
  arabic: 'Arabic',
  hindi: 'Hindi',
  thai: 'Thai',
  vietnamese: 'Vietnamese'
};

// 页面安全响应头。CSP 需要放行三个 CDN：tailwind（含内联 config）、
// remixicon 字体、tesseract（blob worker + wasm + CDN 语言包）。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "child-src 'self' blob: https://cdn.jsdelivr.net",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

const HTML_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-cache'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/translate') {
      if (request.method !== 'POST') return jsonResponse({ error: '该接口只接受 POST' }, 405);
      return handleTranslate(request, env);
    }

    if (path === '/api/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return jsonResponse({ error: '该接口只接受 GET' }, 405);
      }
      return healthResponse(env);
    }

    if (path === '/api/tts') {
      if (request.method !== 'POST') return jsonResponse({ error: '该接口只接受 POST' }, 405);
      return handleTts(request, env);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
    }

    if (path === '/manifest.json') return manifestResponse();
    if (path === '/sw.js') return swResponse();
    if (path === '/icon.svg' || path === '/icon.png' || path === '/favicon.ico') return iconResponse(false);
    if (path === '/icon-maskable.svg') return iconResponse(true);
    if (path === '/' || path === '/index.html') return htmlResponse();

    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      // 翻译结果可能包含用户隐私内容，禁止任何中间层缓存
      'Cache-Control': 'no-store'
    }, extraHeaders || {})
  });
}

// 结构化日志：只记元数据，绝不记录用户文本（隐私）
function log(level, msg, extra) {
  try {
    console[level](JSON.stringify(Object.assign(
      { level: level, msg: msg, ts: new Date().toISOString() },
      extra || {}
    )));
  } catch (e) { /* 日志失败不能影响主流程 */ }
}

function safeErr(err) {
  if (!err) return null;
  return {
    name: err.name || null,
    code: err.code || null,
    message: String((err && err.message) || err).slice(0, 300)
  };
}

function getClientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (now - lastSweepAt >= RATE_LIMIT.WINDOW_MS) {
    for (const [key, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(key);
    }
    lastSweepAt = now;
  }
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT.WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return {
    ok: bucket.count <= RATE_LIMIT.MAX_REQUESTS,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

/* ------------------------------------------------------------------ */
/* 翻译接口                                                            */
/* ------------------------------------------------------------------ */

function buildMessages(text, source, target) {
  const targetName = LANG_NAMES[target] || LANG_NAMES.chinese;
  const sourceName = source === 'auto' ? null : (LANG_NAMES[source] || LANG_NAMES.english);

  const lines = [
    'You are a professional translator.',
    sourceName
      ? 'Translate the user message from ' + sourceName + ' into ' + targetName + '.'
      : 'Detect the language of the user message, then translate it into ' + targetName + '.',
    'Rules:',
    '1. Output ONLY the translation. No explanations, no notes, no surrounding quotation marks.',
    '2. Preserve the original line breaks, paragraph structure and markdown formatting exactly.',
    '3. Keep numbers, URLs, email addresses, code identifiers and proper nouns unchanged.',
    '4. Match the register and tone of the source text.',
    '5. If the text is already in ' + targetName + ', return it unchanged.'
  ];

  return [
    { role: 'system', content: lines.join('\n') },
    { role: 'user', content: text }
  ];
}

// 粗略 token 估计：CJK/韩/泰/阿拉伯等约 1 字符 1 token，拉丁等约 4 字符 1 token
function estimateTokens(text) {
  let wide = 0, narrow = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const isWide =
      (c >= 0x2E80 && c <= 0x9FFF) ||   // CJK 部首/统一表意
      (c >= 0xAC00 && c <= 0xD7AF) ||   // 韩文音节
      (c >= 0xF900 && c <= 0xFAFF) ||   // CJK 兼容表意
      (c >= 0xFF00 && c <= 0xFFEF) ||   // 全角形式
      (c >= 0x0400 && c <= 0x04FF) ||   // 西里尔
      (c >= 0x0600 && c <= 0x06FF) ||   // 阿拉伯文
      (c >= 0x0900 && c <= 0x097F) ||   // 天城文
      (c >= 0x0E00 && c <= 0x0E7F);     // 泰文
    if (isWide) wide++; else narrow++;
  }
  return Math.ceil(wide + narrow / 4);
}

// 输入越长，给生成留的空间越小；保证 input + output 不超出模型上下文
function computeMaxTokens(text) {
  const est = estimateTokens(text) + 200; // system prompt 开销
  return Math.max(512, Math.min(MAX_TOKENS, CONTEXT_TOKENS - RESERVED_TOKENS - est));
}

// Workers AI 不同模型返回结构略有差异，这里统一兜底取文本
function extractText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  const choiceContent = result.choices
    && result.choices[0]
    && ((result.choices[0].message && result.choices[0].message.content)
      || (result.choices[0].delta && result.choices[0].delta.content));
  const candidates = [
    result.response,
    result.result && result.result.response,
    choiceContent,
    result.output_text,
    result.text
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function isCapacityError(err) {
  const message = String((err && err.message) || err);
  return /neuron|quota|rate.?limit|capacity|too many requests|overload|429|503/i.test(message);
}

// 预读上游 ReadableStream 的首个数据块并包装异常捕获：
// 1. 若模型在吐出首帧前报错，能在返回 HTTP 200 头之前被 try/catch 捕获并触发降级；
// 2. 若流传输中途报错，转为标准错误 SSE 帧并正常结束流，避免连接异常断开导致浏览器报 Failed to fetch。
async function wrapAiStream(upstream) {
  const reader = upstream.getReader();
  const first = await reader.read();
  const enc = new TextEncoder();
  let firstSent = false;

  return new ReadableStream({
    start(controller) {
      if (first.done) {
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      if (first.value && first.value.length) {
        controller.enqueue(first.value);
      }
      firstSent = true;
    },
    async pull(controller) {
      if (!firstSent) return;
      try {
        const step = await reader.read();
        if (step.done) {
          controller.close();
          return;
        }
        if (step.value && step.value.length) {
          controller.enqueue(step.value);
        }
      } catch (err) {
        log('error', 'stream_pull_failed', { error: safeErr(err) });
        const payload = JSON.stringify({ error: '流式传输中断，请稍后重试' });
        controller.enqueue(enc.encode('data: ' + payload + '\n\n'));
        controller.close();
      }
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch (e) {}
    }
  });
}

// 主模型不可用（额度/容量/流初始化失败）时按顺序降级
async function runWithFailover(env, model, params) {
  const models = Array.from(new Set([model, DEFAULT_MODEL].concat(FALLBACK_MODELS))).filter(Boolean);
  let lastError = null;
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    try {
      let result = await env.AI.run(m, params);
      if (params && params.stream && result && typeof result.getReader === 'function') {
        result = await wrapAiStream(result);
      }
      return { model: m, result: result };
    } catch (err) {
      lastError = err;
      const hasNext = i < models.length - 1;
      if (!hasNext) throw err;
      log('warn', 'model_unavailable_try_fallback', {
        model: m, next: models[i + 1], error: safeErr(err)
      });
    }
  }
  throw lastError;
}

// 把纯文本包装成 SSE 帧（仅用于流式接口的异常兜底，正常路径是透传上游流）
function textToSseStream(text) {
  const enc = new TextEncoder();
  const lines = String(text).split('\n');
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < lines.length; i++) {
        const piece = i < lines.length - 1 ? lines[i] + '\n' : lines[i];
        if (!piece) continue;
        controller.enqueue(enc.encode('data: ' + JSON.stringify({ response: piece }) + '\n\n'));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
}

function errorToSseStream(message) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: ' + JSON.stringify({ error: String(message) }) + '\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
}

function sseResponse(upstream) {
  let body = upstream;
  if (typeof upstream === 'string') {
    body = textToSseStream(upstream);
  } else if (upstream && typeof upstream === 'object' && typeof upstream.getReader !== 'function') {
    const extracted = extractText(upstream);
    body = extracted
      ? textToSseStream(extracted)
      : errorToSseStream('模型返回了无法识别的流式响应');
  } else if (!upstream || typeof upstream.getReader !== 'function') {
    body = errorToSseStream('模型返回了无法识别的流式响应');
  }
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    }
  });
}

async function handleTranslate(request, env) {
  // 1) 限流（无论请求是否合法都计数，防止无效请求轰炸）
  const limit = checkRateLimit(getClientIp(request));
  if (!limit.ok) {
    return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429, {
      'Retry-After': String(limit.retryAfter),
      'RateLimit-Limit': String(RATE_LIMIT.MAX_REQUESTS),
      'RateLimit-Remaining': '0'
    });
  }

  // 2) 先读文本再解析：直接 request.json() 会让超大/畸形 body 进入解析器
  let rawBody;
  try {
    rawBody = await request.text();
  } catch (e) {
    return jsonResponse({ error: '无法读取请求体' }, 400);
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: '请求体过大（上限 ' + MAX_BODY_BYTES + ' 字节）' }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse({ error: '请求体必须是合法的 JSON' }, 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ error: '请求体格式不正确' }, 400);
  }

  const raw = typeof payload.text === 'string' ? payload.text : '';
  const text = raw.trim();

  if (!text) return jsonResponse({ error: '内容不能为空' }, 400);
  if (text.length > MAX_INPUT_CHARS) {
    return jsonResponse({
      error: '文本过长：最多 ' + MAX_INPUT_CHARS + ' 个字符，当前 ' + text.length + ' 个'
    }, 400);
  }

  // 缺省 auto 比缺省 english 更友好：大多数调用方并不会显式传源语言
  const source = payload.source_lang === 'auto' || !LANG_NAMES[payload.source_lang]
    ? 'auto'
    : payload.source_lang;
  const target = LANG_NAMES[payload.target_lang] ? payload.target_lang : 'chinese';
  const wantStream = payload.stream === true;

  if (!env.AI || typeof env.AI.run !== 'function') {
    return jsonResponse({
      error: '未绑定 Workers AI：请在 wrangler.jsonc 中声明 "ai": { "binding": "AI" }'
    }, 500);
  }

  const model = (typeof env.MODEL === 'string' && env.MODEL) || DEFAULT_MODEL;
  const messages = buildMessages(text, source, target);
  const params = { messages: messages, max_tokens: computeMaxTokens(text), temperature: TEMPERATURE };

  try {
    if (wantStream) {
      try {
        const run = await runWithFailover(env, model, Object.assign({ stream: true }, params));
        return sseResponse(run.result);
      } catch (streamErr) {
        log('warn', 'stream_failed_fallback_to_non_stream', { error: safeErr(streamErr) });
        const run = await runWithFailover(env, model, params);
        const translated = extractText(run.result);
        if (!translated) throw streamErr;
        return sseResponse(translated);
      }
    }

    const run = await runWithFailover(env, model, params);
    const translated = extractText(run.result);
    if (!translated) {
      return jsonResponse({ error: '模型没有返回内容，请稍后重试或换一段更短的文本' }, 502);
    }
    return jsonResponse({
      translated_text: translated,
      source_lang: source,
      target_lang: target,
      model: run.model
    });
  } catch (err) {
    log('error', 'translate_failed', { error: safeErr(err) });
    const busy = isCapacityError(err);
    return jsonResponse({
      error: busy ? '模型额度不足或暂时繁忙，请稍后重试' : '翻译服务出错，请稍后重试'
    }, 502);
  }
}

/* ------------------------------------------------------------------ */
/* 健康检查                                                            */
/* ------------------------------------------------------------------ */

function healthResponse(env) {
  return jsonResponse({
    ok: true,
    service: 'ai-translate',
    ai_bound: !!(env && env.AI),
    default_model: (env && env.MODEL) || DEFAULT_MODEL,
    fallback_models: FALLBACK_MODELS,
    max_input_chars: MAX_INPUT_CHARS,
    rate_limit: { window_ms: RATE_LIMIT.WINDOW_MS, max_requests: RATE_LIMIT.MAX_REQUESTS }
  }, 200);
}

/* ------------------------------------------------------------------ */
/* 语音合成（TTS）                                                      */
/* ------------------------------------------------------------------ */

// Workers AI 各 TTS 模型的返回结构不一：可能是 Uint8Array / ArrayBuffer /
// Response-like / base64 字符串 / { audio: base64 }，这里统一成 Uint8Array
async function toAudioBytes(result) {
  if (!result) return null;
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (typeof result === 'string') return base64ToBytes(result);
  if (typeof result.getReader === 'function') {
    // 上游返回分块流：必须读完整并拼接成单段音频再下发。
    // 若把流直接透传而不处理，前端拿到的可能是「多个音频分段」，
    // 播放出来就是片段反复/杂音，即「读得很乱」。
    const reader = result.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (step.value && step.value.length) {
        chunks.push(step.value);
        total += step.value.length;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return total ? out : null;
  }
  if (typeof result.arrayBuffer === 'function') {
    return new Uint8Array(await result.arrayBuffer()); // Response-like
  }
  if (result.audio) {
    if (typeof result.audio === 'string') return base64ToBytes(result.audio);
    if (result.audio instanceof Uint8Array) return result.audio;
  }
  return null;
}

function base64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) { return null; }
}

async function handleTts(request, env) {
  // 与翻译接口一致的限流与请求体防护
  const limit = checkRateLimit(getClientIp(request));
  if (!limit.ok) {
    return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429, {
      'Retry-After': String(limit.retryAfter)
    });
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch (e) {
    return jsonResponse({ error: '无法读取请求体' }, 400);
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse({ error: '请求体过大（上限 ' + MAX_BODY_BYTES + ' 字节）' }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse({ error: '请求体必须是合法的 JSON' }, 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse({ error: '请求体格式不正确' }, 400);
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return jsonResponse({ error: '内容不能为空' }, 400);
  if (text.length > TTS_MAX_CHARS) {
    return jsonResponse({
      error: '文本过长：朗读最多 ' + TTS_MAX_CHARS + ' 个字符，当前 ' + text.length + ' 个'
    }, 400);
  }

  if (!env.AI || typeof env.AI.run !== 'function') {
    return jsonResponse({
      error: '未绑定 Workers AI：请在 wrangler.jsonc 中声明 "ai": { "binding": "AI" }'
    }, 500);
  }

  // lang 由前端传 BCP-47（en-US / zh-CN ...），取两位语种码
  const prefix = String(payload.lang || 'en-US').toLowerCase().split('-')[0] || 'en';
  let lastErr = null;

  // 主路径：MeloTTS 全语种。注意参数名是 prompt（不是 text）
  try {
    const result = await env.AI.run(TTS_MODEL, { prompt: text, lang: prefix });
    const bytes = await toAudioBytes(result);
    if (bytes && bytes.length) {
      return new Response(bytes, {
        headers: {
          'Content-Type': 'audio/wav',
          'Cache-Control': 'no-store',
          // 关掉中间层缓冲，避免音频被分段缓冲后拼接异常
          'X-Accel-Buffering': 'no'
        }
      });
    }
    log('warn', 'tts_empty_audio', { model: TTS_MODEL, lang: prefix });
  } catch (err) {
    lastErr = err;
    log('error', 'tts_failed', { error: safeErr(err), model: TTS_MODEL, lang: prefix });
  }

  // 降级：melotts 不可用（模型下线/额度/参数变更）时，英文换 Aura-2 兜底
  if (prefix === 'en') {
    try {
      const result = await env.AI.run(TTS_MODEL_AURA_EN, {
        text: text,
        speaker: TTS_SPEAKER_AURA,
        encoding: 'mp3',
        container: 'none'
      });
      const bytes = await toAudioBytes(result);
      if (bytes && bytes.length) {
        return new Response(bytes, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no'
          }
        });
      }
      log('warn', 'tts_empty_audio', { model: TTS_MODEL_AURA_EN, lang: prefix });
    } catch (err) {
      if (!lastErr) lastErr = err;
      log('error', 'tts_failed', { error: safeErr(err), model: TTS_MODEL_AURA_EN, lang: prefix });
    }
  }

  // TTS_DEBUG=1 时下发模型真实报错，便于排障（前端 toast 会一并显示）
  const detail = env.TTS_DEBUG === '1' ? safeErr(lastErr) : undefined;
  return jsonResponse(
    { error: '语音合成失败，请稍后重试', detail: detail },
    502
  );
}

/* ------------------------------------------------------------------ */
/* PWA                                                                 */
/* ------------------------------------------------------------------ */

function manifestResponse() {
  const manifest = {
    id: '/',
    name: 'AI 随身翻译',
    short_name: 'AI 翻译',
    description: '基于 Cloudflare Workers AI 的多语言随身翻译，支持拍照识别与朗读。',
    lang: 'zh-CN',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#ffffff',
    theme_color: '#4f46e5',
    categories: ['utilities', 'productivity'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
    ]
  };
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

function swResponse() {
  const code = `/* AI 随身翻译 Service Worker —— 由 Worker 动态生成 */
const VERSION = '${SW_VERSION}';
const PRECACHE = ['/', '/manifest.json', '/icon.svg', '/icon-maskable.svg'];
/* 只有白名单里的同源静态资源才会进入 Cache。
   用「白名单」而不是「排除法」：接口路径一旦改名，排除法就会静默缓存到 JSON 响应。 */
const STATIC_PATHS = ['/manifest.json', '/icon.svg', '/icon-maskable.svg'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 第三方 CDN 一律不拦截、不缓存

  // 页面导航：网络优先，断网时回退到预缓存的主页
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  if (STATIC_PATHS.indexOf(url.pathname) === -1) return;

  // 静态资源：stale-while-revalidate
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())).catch(() => {});
      return res;
    }).catch(() => null);

    if (cached) {
      network.catch(() => {});
      return cached;
    }
    return (await network) || new Response('', { status: 504 });
  })());
});
`;
  return new Response(code, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/'
    }
  });
}

// 同一份图标按用途生成两版：maskable 版需要满幅背景 + 内缩的安全区
function iconSvg(maskable) {
  const radius = maskable ? 0 : 120;
  const scale = maskable ? 0.62 : 1;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#06b6d4"/>'
    + '</linearGradient></defs>'
    + '<rect width="512" height="512" rx="' + radius + '" fill="url(#g)"/>'
    + '<g transform="translate(256 256) scale(' + scale + ') translate(-256 -256)">'
    + '<text x="256" y="270" text-anchor="middle" dominant-baseline="middle" '
    + 'font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-weight="800" '
    + 'font-size="220" fill="#ffffff">AI</text>'
    + '</g></svg>';
}

function iconResponse(maskable) {
  return new Response(iconSvg(maskable), {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

function htmlResponse() {
  return new Response(HTML, {
    headers: Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8' },
      HTML_SECURITY_HEADERS
    )
  });
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* 注意：整页 HTML 位于模板字面量内，客户端脚本一律不使用反引号与模板  */
/* 字面量，避免截断外层模板。                                          */
/* ------------------------------------------------------------------ */

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="基于 Cloudflare Workers AI 的多语言随身翻译，支持拍照识别与朗读。">
<title>AI 随身翻译</title>

<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="theme-color" content="#ffffff">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="AI 翻译">
<meta name="apple-mobile-web-app-status-bar-style" content="default">

<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>

<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { darkMode: 'class' };
</script>
<link href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js" defer></script>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');

  body { font-family: 'Noto Sans SC', system-ui, sans-serif; transition: background-color .3s, color .3s; }
  .bg-light { background: linear-gradient(135deg, #fdfbfb 0%, #ebedee 100%); }
  .bg-dark  { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); }

  .glass-card { background: rgba(255,255,255,.85); backdrop-filter: blur(12px); transition: background-color .3s; }
  .dark .glass-card { background: rgba(30,41,59,.72); border: 1px solid rgba(255,255,255,.05); }

  /* 高度封顶：长文本时文本域内部滚动，不再把页面顶翻 */
  textarea { resize: none; overflow-y: auto; min-height: 120px; max-height: 45vh; }
  textarea:focus { outline: none; }
  /* 干掉移动端双击缩放，按钮/下拉手感更接近原生 */
  button, select, label, textarea { touch-action: manipulation; }
  * { -webkit-tap-highlight-color: transparent; }

  /* 原来引用了 pt-safe-top / pb-safe-bottom 但从未定义，这里补上，刘海屏才真的生效 */
  .pt-safe-top { padding-top: env(safe-area-inset-top); }
  .pb-safe-bottom { padding-bottom: env(safe-area-inset-bottom); }

  .spinner { width: 18px; height: 18px; border: 2px solid currentColor; border-bottom-color: transparent; border-radius: 50%; animation: rotation 1s linear infinite; }
  @keyframes rotation { to { transform: rotate(360deg); } }

  .speaking { animation: pulse 1s infinite; color: #6366f1; }
  @keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: .75; } }

  #outputText.is-empty::before { content: '译文会实时显示在这里'; color: #94a3b8; }
  .dark #outputText.is-empty::before { color: #64748b; }

  /* 流式输出时的闪烁光标，让「正在生成」有明确反馈 */
  #outputText.is-streaming::after { content: '\\2589'; margin-left: 2px; color: #6366f1; animation: caretBlink 1s steps(2, start) infinite; }
  .dark #outputText.is-streaming::after { color: #a5b4fc; }
  @keyframes caretBlink { 50% { opacity: 0; } }

  @keyframes scan { 0% { top: 0; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { top: 100%; opacity: 0; } }
  .scan-line { animation: scan 2.5s linear infinite; }

  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: .001ms !important; transition-duration: .001ms !important; }
  }
</style>
</head>
<body class="bg-light min-h-screen text-slate-800 dark:text-slate-100 flex justify-center">

<noscript>
  <div style="padding:24px;text-align:center;font-size:15px;line-height:1.8;">本应用需要启用 JavaScript 才能使用翻译功能。</div>
</noscript>

<div class="w-full max-w-4xl min-h-screen md:min-h-[800px] md:my-10 md:rounded-3xl glass-card flex flex-col shadow-2xl relative">

  <header class="sticky top-0 z-40 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center pt-safe-top md:rounded-t-3xl">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md">
        <i class="ri-translate-2 text-lg"></i>
      </div>
      <h1 class="font-bold text-lg tracking-wide">AI 翻译</h1>
      <span id="netBadge" class="hidden text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">离线</span>
    </div>
    <div class="flex gap-1">
      <button id="btnHistory" type="button" aria-label="历史记录" title="历史记录" class="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition text-slate-500 dark:text-slate-400">
        <i class="ri-history-line text-xl"></i>
      </button>
      <button id="btnTheme" type="button" aria-label="切换深色模式" title="切换主题" class="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition text-slate-500 dark:text-slate-400">
        <i id="themeIcon" class="ri-moon-line text-xl"></i>
      </button>
    </div>
  </header>

  <main class="flex flex-col md:flex-row flex-1">

    <section class="flex-1 flex flex-col border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700 relative">
      <div class="sticky top-[72px] md:top-0 z-30 px-5 py-3 flex justify-between items-center bg-white/50 dark:bg-slate-800/50 backdrop-blur-sm">
        <div class="flex items-center gap-1">
          <label for="sourceLang" class="sr-only">源语言</label>
          <select id="sourceLang" class="appearance-none bg-transparent font-bold text-slate-700 dark:text-slate-200 py-1 cursor-pointer outline-none">
            <option value="auto" selected>自动检测</option>
            <option value="chinese">中文</option>
            <option value="english">英语</option>
            <option value="japanese">日语</option>
            <option value="korean">韩语</option>
            <option value="french">法语</option>
            <option value="german">德语</option>
            <option value="spanish">西语</option>
            <option value="russian">俄语</option>
            <option value="italian">意大利语</option>
            <option value="portuguese">葡萄牙语</option>
            <option value="arabic">阿拉伯语</option>
            <option value="hindi">印地语</option>
            <option value="thai">泰语</option>
            <option value="vietnamese">越南语</option>
          </select>
          <i class="ri-arrow-down-s-line text-slate-400 -ml-1 pointer-events-none"></i>
          <button id="btnSwap" type="button" aria-label="互换语言" title="互换语言" class="ml-1 p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-indigo-500 transition">
            <i class="ri-arrow-left-right-line"></i>
          </button>
        </div>

        <div class="flex gap-1">
          <button id="btnSpeakSource" type="button" aria-label="朗读原文" title="朗读原文" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-volume-up-line text-lg"></i></button>
          <button id="btnCamera" type="button" aria-label="拍照识别" title="拍照识别" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-camera-line text-lg"></i></button>
          <button id="btnClear" type="button" aria-label="清空输入" title="清空" class="p-2 text-slate-400 hover:text-red-500 transition"><i class="ri-delete-bin-line text-lg"></i></button>
        </div>
      </div>

      <div class="flex-1 p-5">
        <label for="inputText" class="sr-only">要翻译的文字</label>
        <textarea id="inputText" rows="5" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"
          class="w-full bg-transparent text-xl leading-relaxed placeholder-slate-400 dark:placeholder-slate-600 text-slate-800 dark:text-slate-100"
          placeholder="输入文字，或点右上角拍照识别…"></textarea>
      </div>

      <div class="px-5 py-4 flex justify-between items-center gap-3 bg-white/30 dark:bg-slate-800/30">
        <div class="flex items-center gap-3 min-w-0">
          <span id="charCount" class="text-xs text-slate-400 whitespace-nowrap">0 / ${MAX_INPUT_CHARS}</span>
          <label class="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none whitespace-nowrap" title="停止输入后自动翻译">
            <input id="autoTranslate" type="checkbox" checked class="w-3.5 h-3.5 accent-indigo-600 cursor-pointer">
            自动翻译
          </label>
        </div>
        <button id="translateBtn" type="button" title="翻译（快捷键 Ctrl/⌘ + Enter）" class="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl shadow-lg shadow-indigo-500/30 transition-transform active:scale-95 flex items-center gap-2 font-medium">
          <span id="btnText">翻译</span>
          <span id="loader" class="spinner hidden" aria-hidden="true"></span>
        </button>
      </div>
    </section>

    <section class="flex-1 flex flex-col bg-slate-50/50 dark:bg-slate-900/50 min-h-[300px] md:rounded-br-3xl">
      <div class="sticky top-[72px] md:top-0 z-30 px-5 py-3 flex justify-between items-center bg-slate-50/80 dark:bg-slate-900/80 backdrop-blur-sm">
        <div class="flex items-center gap-1">
          <label for="targetLang" class="sr-only">目标语言</label>
          <select id="targetLang" class="appearance-none bg-transparent font-bold text-indigo-600 dark:text-indigo-400 py-1 cursor-pointer outline-none">
            <option value="chinese" selected>中文</option>
            <option value="english">英语</option>
            <option value="japanese">日语</option>
            <option value="korean">韩语</option>
            <option value="french">法语</option>
            <option value="german">德语</option>
            <option value="spanish">西语</option>
            <option value="russian">俄语</option>
            <option value="italian">意大利语</option>
            <option value="portuguese">葡萄牙语</option>
            <option value="arabic">阿拉伯语</option>
            <option value="hindi">印地语</option>
            <option value="thai">泰语</option>
            <option value="vietnamese">越南语</option>
          </select>
          <i class="ri-arrow-down-s-line text-indigo-300 -ml-1 pointer-events-none"></i>
        </div>
        <div class="flex gap-1">
          <button id="btnSpeakTarget" type="button" aria-label="朗读译文" title="朗读译文" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-volume-up-line text-lg"></i></button>
          <button id="btnCopy" type="button" aria-label="复制译文" title="复制译文" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-file-copy-line text-lg"></i></button>
        </div>
      </div>

      <div id="outputText" aria-live="polite" class="flex-1 w-full px-5 py-4 text-xl leading-relaxed text-indigo-900 dark:text-indigo-100 whitespace-pre-wrap break-words pb-20 select-text is-empty"></div>
    </section>
  </main>

</div>

<div id="historyPanel" role="dialog" aria-label="历史记录" aria-modal="true" class="fixed inset-y-0 right-0 w-80 max-w-[85vw] bg-white dark:bg-slate-800 shadow-2xl transform translate-x-full transition-transform duration-300 z-50 flex flex-col">
  <div class="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center">
    <h2 class="font-bold text-lg dark:text-white">历史记录</h2>
    <button id="btnCloseHistory" type="button" aria-label="关闭历史记录" class="p-1 text-slate-400 hover:text-red-500"><i class="ri-close-line text-2xl"></i></button>
  </div>
  <div id="historyList" class="flex-1 overflow-y-auto p-2 space-y-2"></div>
  <div class="p-4 border-t border-slate-100 dark:border-slate-700">
    <button id="btnClearHistory" type="button" class="w-full py-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-sm transition">清空全部记录</button>
  </div>
</div>
<div id="historyBackdrop" class="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 hidden"></div>

<div id="toast" role="status" aria-live="polite" class="fixed top-6 left-1/2 -translate-x-1/2 -translate-y-2 px-4 py-2 bg-slate-800 dark:bg-white text-white dark:text-slate-900 rounded-full shadow-lg opacity-0 transition-all duration-300 pointer-events-none z-[60] flex items-center gap-2 text-sm font-medium max-w-[90vw]">
  <i class="ri-information-line shrink-0"></i><span id="toastMsg" class="truncate"></span>
</div>

<div id="cameraModal" class="fixed inset-0 bg-black z-[100] hidden flex-col">
  <div class="relative flex-1 bg-black overflow-hidden">
    <video id="cameraVideo" autoplay playsinline muted class="w-full h-full object-cover"></video>
    <div class="absolute left-0 w-full h-1 bg-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.8)] scan-line"></div>
    <div id="ocrStatus" class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-sm bg-black/70 px-4 py-2 rounded-lg hidden"></div>
  </div>
  <div class="h-32 bg-black flex items-center justify-between px-10 pb-safe-bottom">
    <button id="btnCloseCamera" type="button" aria-label="关闭相机" class="text-white opacity-80 hover:opacity-100"><i class="ri-close-circle-line text-4xl"></i></button>
    <button id="btnCapture" type="button" aria-label="拍照并识别" class="w-16 h-16 rounded-full border-4 border-white bg-white/20 flex items-center justify-center active:scale-95 transition disabled:opacity-40">
      <span class="block w-12 h-12 bg-white rounded-full"></span>
    </button>
    <span class="w-9"></span>
  </div>
</div>
<canvas id="canvas" class="hidden"></canvas>

<script>
(function () {
  'use strict';

  // 与服务端保持同源的两个常量，由 Worker 在生成页面时注入
  var MAX_INPUT_CHARS = ${MAX_INPUT_CHARS};
  var HISTORY_LIMIT = ${HISTORY_LIMIT};
  var HISTORY_KEY = 'trans_history';
  var THEME_KEY = 'trans_theme';
  var AUTO_KEY = 'trans_auto';
  var DEBOUNCE_MS = 1200;

  // 语种表与 worker.js 的 LANG_NAMES 一一对应，新增语言时同步
  var SPEECH_LANG = {
    chinese: 'zh-CN', english: 'en-US', japanese: 'ja-JP', korean: 'ko-KR',
    french: 'fr-FR', german: 'de-DE', spanish: 'es-ES', russian: 'ru-RU',
    italian: 'it-IT', portuguese: 'pt-BR', arabic: 'ar-SA', hindi: 'hi-IN',
    thai: 'th-TH', vietnamese: 'vi-VN'
  };
  var OCR_LANG = {
    chinese: 'chi_sim', english: 'eng', japanese: 'jpn', korean: 'kor',
    french: 'fra', german: 'deu', spanish: 'spa', russian: 'rus',
    italian: 'ita', portuguese: 'por', arabic: 'ara', hindi: 'hin',
    thai: 'tha', vietnamese: 'vie'
  };
  var CAMERA_ERRORS = {
    NotAllowedError: '摄像头权限被拒绝，请在浏览器设置中允许后重试',
    NotFoundError: '没有找到可用的摄像头',
    NotReadableError: '摄像头被其他程序占用，请关闭后重试',
    OverconstrainedError: '摄像头不支持所需的分辨率'
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    input: $('inputText'), output: $('outputText'), source: $('sourceLang'), target: $('targetLang'),
    loader: $('loader'), btnText: $('btnText'), translateBtn: $('translateBtn'), charCount: $('charCount'),
    auto: $('autoTranslate'), toast: $('toast'), toastMsg: $('toastMsg'), netBadge: $('netBadge'),
    historyPanel: $('historyPanel'), historyBackdrop: $('historyBackdrop'), historyList: $('historyList'),
    cameraModal: $('cameraModal'), cameraVideo: $('cameraVideo'), ocrStatus: $('ocrStatus'), canvas: $('canvas')
  };

  var busy = false;
  var controller = null;
  var seq = 0;
  var debounceTimer = null;
  var toastTimer = null;
  var mediaStream = null;
  var speakingBtn = null;
  var lastFocus = null;

  function clearDebounce() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  /* ---------- 存储 ---------- */

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  /* ---------- 主题 ---------- */

  var mql = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    var dark = saved ? saved === 'dark' : mql.matches;
    document.documentElement.classList.toggle('dark', dark);
    document.body.classList.toggle('bg-dark', dark);
    document.body.classList.toggle('bg-light', !dark);
    var icon = $('themeIcon');
    icon.classList.toggle('ri-moon-line', !dark);
    icon.classList.toggle('ri-sun-line', dark);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f172a' : '#ffffff');
  }

  function toggleTheme() {
    var dark = document.documentElement.classList.contains('dark');
    try { localStorage.setItem(THEME_KEY, dark ? 'light' : 'dark'); } catch (e) {}
    applyTheme();
  }

  applyTheme();
  if (mql.addEventListener) {
    mql.addEventListener('change', function () {
      try { if (!localStorage.getItem(THEME_KEY)) applyTheme(); } catch (e) {}
    });
  }

  /* ---------- Toast ---------- */

  function showToast(msg) {
    els.toastMsg.textContent = String(msg || '');
    els.toast.classList.remove('opacity-0', '-translate-y-2');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.add('opacity-0', '-translate-y-2');
    }, 2800);
  }

  /* ---------- 输出与状态 ---------- */

  function setOutput(text) {
    els.output.textContent = text || '';
    els.output.classList.toggle('is-empty', !text);
  }

  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.max(120, els.input.scrollHeight) + 'px';
  }

  function refreshControls() {
    var over = els.input.value.length > MAX_INPUT_CHARS;
    els.translateBtn.disabled = busy || over;
    els.btnText.textContent = busy ? '翻译中' : '翻译';
    els.loader.classList.toggle('hidden', !busy);
    els.charCount.textContent = els.input.value.length + ' / ' + MAX_INPUT_CHARS;
    els.charCount.classList.toggle('text-red-500', over);
    els.charCount.classList.toggle('text-slate-400', !over);
  }

  /* ---------- 翻译 ---------- */

  function isAutoTranslate() {
    return !!els.auto.checked;
  }

  function scheduleTranslate() {
    clearDebounce();
    if (!isAutoTranslate()) return;
    if (!els.input.value.trim()) return;
    debounceTimer = setTimeout(function () { doTranslate(); }, DEBOUNCE_MS);
  }

  function readErrorResponse(res) {
    return res.json().then(function (data) {
      return (data && data.error) || ('请求失败（HTTP ' + res.status + '）');
    }).catch(function () {
      return '服务端返回了非 JSON 内容（HTTP ' + res.status + '）';
    });
  }

  function parseSseChunk(buffer, onPiece) {
    var lines = buffer.split('\\n');
    var rest = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      var obj;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      if (obj && obj.error) throw new Error(String(obj.error));
      var piece = (obj && typeof obj.response === 'string')
        ? obj.response
        : (obj && obj.choices && obj.choices[0] && obj.choices[0].delta && typeof obj.choices[0].delta.content === 'string'
          ? obj.choices[0].delta.content
          : null);
      if (piece !== null) onPiece(piece);
    }
    return rest;
  }

  function fallbackNonStreamTranslate(text, signal, mySeq, stopCaret) {
    return fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal,
      body: JSON.stringify({
        text: text,
        source_lang: els.source.value,
        target_lang: els.target.value,
        stream: false
      })
    }).then(function (res) {
      if (!res.ok) {
        return readErrorResponse(res).then(function (msg) {
          throw new Error(msg);
        });
      }
      return res.json();
    }).then(function (data) {
      if (mySeq !== seq) return;
      stopCaret();
      var finalText = ((data && data.translated_text) || '').trim();
      if (!finalText) { setOutput(''); showToast('模型没有返回内容，请重试'); return; }
      setOutput(finalText);
      saveToHistory(text, finalText);
    });
  }

  function formatFetchError(err) {
    var msg = (err && err.message) ? String(err.message) : '网络异常';
    if (/failed to fetch|load failed|networkerror/i.test(msg)) {
      if (location.protocol === 'file:') {
        return '请通过 Worker 地址访问，不能直接双击打开 HTML';
      }
      if (/\.workers\.dev$/i.test(location.hostname)) {
        return '网络无法连接 workers.dev（建议绑定自定义域名或检查网络代理）';
      }
      return '无法连接后端服务（请确认 Worker 正在运行且网络正常）';
    }
    return msg;
  }

  function doTranslate() {
    var text = els.input.value.trim();
    var mySeq = ++seq;

    if (!text) { setOutput(''); return Promise.resolve(); }
    if (text.length > MAX_INPUT_CHARS) { showToast('文本过长，最多 ' + MAX_INPUT_CHARS + ' 个字符'); return Promise.resolve(); }

    if (controller) controller.abort();
    controller = new AbortController();
    var signal = controller.signal;

    busy = true;
    refreshControls();

    var acc = '';
    var started = false;

    function stopCaret() { els.output.classList.remove('is-streaming'); }

    return fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal,
      body: JSON.stringify({
        text: text,
        source_lang: els.source.value,
        target_lang: els.target.value,
        stream: true
      })
    }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (!res.ok || type.indexOf('text/event-stream') === -1) {
        return readErrorResponse(res).then(function (msg) {
          if (mySeq === seq) { showToast(msg); setOutput(''); stopCaret(); }
        });
      }
      if (!res.body || !res.body.getReader) {
        // 老浏览器没有流式 reader：整段收完再一次性渲染
        return res.text().then(function (raw) {
          parseSseChunk(raw.replace(/\\r/g, ''), function (p) { acc += p; });
          if (mySeq === seq) {
            setOutput(acc.trim());
            stopCaret();
            if (acc.trim()) saveToHistory(text, acc.trim());
          }
        });
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function onPiece(piece) {
        acc += piece;
        if (mySeq !== seq) return;
        if (!started) { started = true; els.output.classList.add('is-streaming'); }
        setOutput(acc);
      }

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          buffer = parseSseChunk(buffer, onPiece);
          return pump();
        });
      }

      return pump().then(function () {
        var finalText = acc.trim();
        if (mySeq !== seq) return;
        stopCaret();
        if (!finalText) { setOutput(''); showToast('模型没有返回内容，请重试'); return; }
        setOutput(finalText);
        saveToHistory(text, finalText);
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      if (mySeq !== seq) return;
      stopCaret();
      var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) {
        showToast('当前处于离线状态');
        return;
      }
      // 若流式传输在网络层或首包阶段中断（未产出任何译文），自动回退一次非流式请求
      if (!acc.trim() && /failed to fetch|load failed|networkerror/i.test(String((err && err.message) || ''))) {
        return fallbackNonStreamTranslate(text, signal, mySeq, stopCaret).catch(function (err2) {
          if (err2 && err2.name === 'AbortError') return;
          if (mySeq !== seq) return;
          stopCaret();
          showToast('翻译失败：' + formatFetchError(err2));
        });
      }
      showToast('翻译失败：' + formatFetchError(err));
    }).then(function () {
      if (mySeq !== seq) return;
      busy = false;
      refreshControls();
    });
  }

  /* ---------- 历史记录（全程 textContent，杜绝注入） ---------- */

  function getHistory() {
    var list = readJSON(HISTORY_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function setHistory(list) {
    writeJSON(HISTORY_KEY, list.slice(0, HISTORY_LIMIT));
  }

  function formatTime(item) {
    if (item && item.ts) {
      try {
        return new Date(item.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch (e) {}
    }
    return (item && item.time) || '';
  }

  // 历史记录是附属功能：任何异常都不允许影响翻译主流程，因此整体兜底
  function saveToHistory(src, dst) {
    try {
      var history = getHistory();
      if (history.length && history[0].src === src && history[0].dst === dst) return;
      history.unshift({ src: src, dst: dst, ts: Date.now() });
      setHistory(history);
      renderHistory();
    } catch (e) {}
  }

  function emptyState(text) {
    var box = document.createElement('div');
    box.className = 'text-center text-slate-400 mt-10 text-sm';
    box.textContent = text;
    return box;
  }

  function renderHistory() {
    var history = getHistory();
    els.historyList.replaceChildren();

    if (!history.length) {
      els.historyList.appendChild(emptyState('暂无历史记录'));
      return;
    }

    history.forEach(function (item, index) {
      var row = document.createElement('div');
      row.className = 'group relative p-3 pr-10 bg-slate-50 dark:bg-slate-700/50 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer transition border border-transparent hover:border-indigo-200 dark:hover:border-indigo-800';

      var src = document.createElement('div');
      src.className = 'text-slate-800 dark:text-slate-200 font-medium truncate';
      src.textContent = String(item.src || '');

      var dst = document.createElement('div');
      dst.className = 'text-indigo-600 dark:text-indigo-400 text-sm truncate mt-1';
      dst.textContent = String(item.dst || '');

      var time = document.createElement('div');
      time.className = 'text-[11px] text-slate-400 mt-1';
      time.textContent = formatTime(item);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'absolute top-2 right-2 p-1.5 rounded-md text-slate-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition';
      del.setAttribute('aria-label', '删除这条记录');
      var delIcon = document.createElement('i');
      delIcon.className = 'ri-delete-bin-line';
      del.appendChild(delIcon);
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var list = getHistory();
        list.splice(index, 1);
        setHistory(list);
        renderHistory();
      });

      row.addEventListener('click', function () {
        els.input.value = String(item.src || '');
        setOutput(String(item.dst || ''));
        autoResize();
        refreshControls();
        closeHistory();
      });

      row.appendChild(src);
      row.appendChild(dst);
      row.appendChild(time);
      row.appendChild(del);
      els.historyList.appendChild(row);
    });
  }

  function historyIsOpen() {
    return !els.historyPanel.classList.contains('translate-x-full');
  }

  function openHistory() {
    renderHistory();
    lastFocus = document.activeElement;
    // inert 让关闭状态下的面板退出 Tab 焦点链，屏幕阅读器也读不到
    if ('inert' in HTMLElement.prototype) els.historyPanel.inert = false;
    els.historyPanel.classList.remove('translate-x-full');
    els.historyBackdrop.classList.remove('hidden');
    $('btnCloseHistory').focus();
  }

  function closeHistory() {
    els.historyPanel.classList.add('translate-x-full');
    if ('inert' in HTMLElement.prototype) els.historyPanel.inert = true;
    els.historyBackdrop.classList.add('hidden');
    if (lastFocus && lastFocus.focus) { lastFocus.focus(); lastFocus = null; }
  }

  function toggleHistory() {
    if (historyIsOpen()) closeHistory(); else openHistory();
  }

  function clearHistory() {
    if (!getHistory().length) { showToast('还没有历史记录'); return; }
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
    showToast('历史记录已清空');
  }

  /* ---------- 朗读 / 复制 / 互换 / 清空 ---------- */

  // 自动检测源语言时的朗读语言推断：先扫描全段再按优先级判定，
  // 避免「先出现汉字就判中文」把日文误判（旧版 bug）
  function guessSpeechLang(text) {
    var sample = String(text || '').slice(0, 400);
    var flags = { ja: false, ko: false, zh: false, ru: false, ar: false, hi: false, th: false };
    for (var i = 0; i < sample.length; i++) {
      var c = sample.codePointAt(i);
      if (c >= 0x3040 && c <= 0x30ff) flags.ja = true;        // 平假名/片假名 → 日语最优先
      else if (c >= 0xac00 && c <= 0xd7af) flags.ko = true;    // 韩文音节
      else if (c >= 0x0400 && c <= 0x04ff) flags.ru = true;    // 西里尔
      else if (c >= 0x0600 && c <= 0x06ff) flags.ar = true;    // 阿拉伯文
      else if (c >= 0x0900 && c <= 0x097f) flags.hi = true;    // 天城文
      else if (c >= 0x0e00 && c <= 0x0e7f) flags.th = true;    // 泰文
      else if (c >= 0x4e00 && c <= 0x9fff) flags.zh = true;    // 汉字（含日文汉字，优先级最低）
    }
    if (flags.ja) return 'ja-JP';
    if (flags.ko) return 'ko-KR';
    if (flags.ru) return 'ru-RU';
    if (flags.ar) return 'ar-SA';
    if (flags.hi) return 'hi-IN';
    if (flags.th) return 'th-TH';
    if (flags.zh) return 'zh-CN';
    return 'en-US';
  }

  function resetSpeaking() {
    if (!speakingBtn) return;
    var icon = speakingBtn.querySelector('i');
    if (icon) {
      icon.classList.add('ri-volume-up-line');
      icon.classList.remove('ri-volume-up-fill');
    }
    speakingBtn.classList.remove('speaking');
    speakingBtn = null;
  }

  /* ---------- 朗读（Workers AI TTS：英文 Deepgram Aura-2 / 其他 MeloTTS） ---------- */

  var audioEl = null;

  function stopSpeaking() {
    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
      try { if (audioEl.src) URL.revokeObjectURL(audioEl.src); } catch (e) {}
      audioEl = null;
    }
    resetSpeaking();
  }

  function speak(type) {
    var btn = $(type === 'source' ? 'btnSpeakSource' : 'btnSpeakTarget');
    var wasSpeaking = btn === speakingBtn;

    stopSpeaking(); // 再点一次 = 停止当前朗读
    if (wasSpeaking) return;

    var text = type === 'source' ? els.input.value.trim() : els.output.textContent.trim();
    if (!text) { showToast(type === 'source' ? '没有可朗读的原文' : '还没有译文'); return; }

    var SPEECH_LIMIT = 1000; // 与服务端 TTS_MAX_CHARS 保持一致
    if (text.length > SPEECH_LIMIT) {
      showToast('文本较长，仅朗读前 ' + SPEECH_LIMIT + ' 个字符');
      text = text.slice(0, SPEECH_LIMIT);
    }

    var langKey = type === 'source' ? els.source.value : els.target.value;
    var lang = langKey === 'auto' ? guessSpeechLang(text) : (SPEECH_LANG[langKey] || 'en-US');

    // 先进入「朗读中」视觉状态，请求或播放失败时再复位
    speakingBtn = btn;
    var icon = btn.querySelector('i');
    if (icon) {
      icon.classList.remove('ri-volume-up-line');
      icon.classList.add('ri-volume-up-fill');
    }
    btn.classList.add('speaking');

    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, lang: lang })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (data) {
          var msg = (data && data.error) || ('请求失败（HTTP ' + res.status + '）');
          // 排障模式下（TTS_DEBUG=1）后端会带模型真实报错，一并显示
          if (data && data.detail && data.detail.message) {
            msg += '（' + data.detail.message + '）';
          }
          throw new Error(msg);
        }, function () {
          throw new Error('请求失败（HTTP ' + res.status + '）');
        });
      }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('audio/') !== 0) throw new Error('服务端返回了非音频内容');
      return res.blob();
    }).then(function (blob) {
      // 空 blob / 异常小的数据多半是模型返回损坏，直接提示而不是播放出杂音
      if (!blob || blob.size < 64) {
        stopSpeaking();
        showToast('音频数据异常，请重试');
        return;
      }
      audioEl = new Audio(URL.createObjectURL(blob));
      audioEl.onended = stopSpeaking;
      audioEl.onerror = function () { stopSpeaking(); showToast('播放失败，请重试'); };
      var p = audioEl.play();
      if (p && p.catch) {
        p.catch(function () { stopSpeaking(); showToast('播放失败：浏览器阻止了自动播放'); });
      }
    }).catch(function (err) {
      stopSpeaking();
      showToast('朗读失败：' + ((err && err.message) || '请稍后重试'));
    });
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }

  function copyResult() {
    var text = els.output.textContent.trim();
    if (!text) { showToast('还没有译文'); return; }
    var done = function () { showToast('已复制译文'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        try { legacyCopy(text); done(); } catch (e) { showToast('复制失败，请长按选择文本'); }
      });
      return;
    }
    try { legacyCopy(text); done(); } catch (e) { showToast('复制失败，请长按选择文本'); }
  }

  function clearText() {
    clearDebounce();
    if (controller) controller.abort();
    seq++;
    busy = false;
    els.input.value = '';
    setOutput('');
    els.output.classList.remove('is-streaming');
    autoResize();
    refreshControls();
    els.input.focus();
  }

  function swapLanguages() {
    var s = els.source.value;
    var t = els.target.value;
    var out = els.output.textContent.trim();

    if (s === 'auto') {
      els.source.value = t;
      els.target.value = t === 'english' ? 'chinese' : 'english';
    } else {
      els.source.value = t;
      els.target.value = s;
    }

    if (out) {
      els.input.value = out;
      setOutput('');
      autoResize();
      refreshControls();
      doTranslate();
    }
  }

  /* ---------- 摄像头 OCR ---------- */

  function openCamera() {
    if (cameraIsOpen()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('当前环境不支持摄像头（需要 HTTPS 访问）');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }
    }).then(function (s) {
      mediaStream = s;
      els.cameraVideo.srcObject = s;
      els.cameraModal.classList.remove('hidden');
      els.cameraModal.classList.add('flex');
    }).catch(function (err) {
      showToast(CAMERA_ERRORS[err && err.name] || '无法打开摄像头');
    });
  }

  function closeCamera() {
    els.cameraModal.classList.add('hidden');
    els.cameraModal.classList.remove('flex');
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
  }

  function cameraIsOpen() {
    return !els.cameraModal.classList.contains('hidden');
  }

  function captureAndRecognize() {
    var video = els.cameraVideo;
    if (!video.videoWidth) { showToast('摄像头还没准备好，请稍等一下'); return; }
    if (typeof Tesseract === 'undefined') { showToast('文字识别库未加载成功，请检查网络'); return; }

    var btnCapture = $('btnCapture');
    btnCapture.disabled = true; // 识别期间禁止重复拍照

    var canvas = els.canvas;
    var ctx = canvas.getContext('2d');

    // 降采样到 1600px 宽以内：识别精度几乎无损，耗时和内存大幅下降
    var MAX_OCR_WIDTH = 1600;
    var scale = Math.min(1, MAX_OCR_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    var status = els.ocrStatus;
    status.textContent = '正在准备识别引擎…';
    status.classList.remove('hidden');

    var sourceKey = els.source.value;
    // 自动检测时同时加载英文与简体中文，兼顾最常见的两种场景
    var lang = sourceKey === 'auto' ? 'eng+chi_sim' : (OCR_LANG[sourceKey] || 'eng');

    Tesseract.recognize(canvas.toDataURL('image/jpeg', 0.9), lang, {
      logger: function (m) {
        if (!m) return;
        if (m.status === 'loading tesseract core') status.textContent = '正在加载识别引擎…';
        else if (m.status === 'loading language traineddata') status.textContent = '首次使用，正在下载语言包…';
        else if (m.status === 'recognizing text') status.textContent = '正在识别文字… ' + Math.round((m.progress || 0) * 100) + '%';
      }
    }).then(function (result) {
      var text = ((result && result.data && result.data.text) || '').trim();
      closeCamera();
      if (!text) { showToast('没有识别到文字，换个角度或靠近一点再试'); return; }
      els.input.value = text;
      autoResize();
      refreshControls();
      if (isAutoTranslate()) doTranslate(); else showToast('识别完成，点击「翻译」');
    }).catch(function (err) {
      showToast('文字识别失败：' + ((err && err.message) || '请重试'));
    }).then(function () {
      status.classList.add('hidden');
      btnCapture.disabled = false;
    });
  }

  /* ---------- 事件绑定 ---------- */

  els.input.addEventListener('input', function () {
    autoResize();
    refreshControls();
    if (!els.input.value.trim()) {
      clearDebounce();
      if (controller) controller.abort();
      seq++;
      busy = false;
      setOutput('');
      els.output.classList.remove('is-streaming');
      refreshControls();
      return;
    }
    scheduleTranslate();
  });

  els.input.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); doTranslate(); }
  });

  els.auto.addEventListener('change', function () {
    try { localStorage.setItem(AUTO_KEY, els.auto.checked ? '1' : '0'); } catch (e) {}
    if (els.auto.checked && els.input.value.trim()) scheduleTranslate();
  });

  els.translateBtn.addEventListener('click', function () { doTranslate(); });
  els.source.addEventListener('change', function () { if (els.input.value.trim()) doTranslate(); });
  els.target.addEventListener('change', function () { if (els.input.value.trim()) doTranslate(); });

  $('btnSwap').addEventListener('click', swapLanguages);
  $('btnSpeakSource').addEventListener('click', function () { speak('source'); });
  $('btnSpeakTarget').addEventListener('click', function () { speak('target'); });
  $('btnCamera').addEventListener('click', openCamera);
  $('btnClear').addEventListener('click', clearText);
  $('btnCopy').addEventListener('click', copyResult);
  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnHistory').addEventListener('click', toggleHistory);
  $('btnCloseHistory').addEventListener('click', closeHistory);
  $('btnClearHistory').addEventListener('click', clearHistory);
  els.historyBackdrop.addEventListener('click', closeHistory);
  $('btnCloseCamera').addEventListener('click', closeCamera);
  $('btnCapture').addEventListener('click', captureAndRecognize);

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (cameraIsOpen()) { closeCamera(); return; }
    if (historyIsOpen()) closeHistory();
  });

  window.addEventListener('beforeunload', function () {
    stopSpeaking(); // 离开页面时停止正在播放的合成音频
  });

  function updateNetBadge() {
    els.netBadge.classList.toggle('hidden', navigator.onLine !== false);
  }
  window.addEventListener('online', function () { updateNetBadge(); showToast('网络已恢复'); });
  window.addEventListener('offline', function () { updateNetBadge(); showToast('网络已断开，暂时无法翻译'); });

  /* ---------- 初始化 ---------- */

  try { els.auto.checked = localStorage.getItem(AUTO_KEY) !== '0'; } catch (e) {}
  if ('inert' in HTMLElement.prototype) els.historyPanel.inert = true;
  updateNetBadge();
  autoResize();
  refreshControls();
  renderHistory();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (reg) {
        if (reg && reg.update) reg.update();
        // 新版本 SW 就绪时提示刷新（SW 自身 skipWaiting + claim，刷新即生效）
        if (reg) {
          reg.addEventListener('updatefound', function () {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', function () {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                showToast('发现新版本，刷新页面即可生效');
              }
            });
          });
        }
      }).catch(function () {});
    });
  }
})();
</script>
</body>
</html>
`;