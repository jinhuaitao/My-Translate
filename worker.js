/**
 * AI 随身翻译 —— 单文件 Cloudflare Worker（v3.0 界面重构版）
 *
 * 部署：连接 GitHub（Workers Builds）或本地 `npx wrangler deploy --keep-vars`
 * 环境变量（在 Cloudflare Dashboard -> Settings -> Variables and Secrets 中添加）：
 *   - API_URL : 翻译接口地址（支持 OpenAI 兼容接口，可填完整 /v1/chat/completions、/v1 或域名根路径）
 *   - API_KEY : 翻译接口密钥（建议使用 Secret 加密变量存储）
 *   - MODEL   : 翻译模型名称（支持单模型，也支持英文逗号分隔多个模型按顺序故障转移）
 * 依赖：wrangler.jsonc 中的 `keep_vars: true` 确保每次重新部署不会覆盖或清空已添加的环境变量；
 *       `ai.binding = "AI"` 保留用于 `/api/tts` 语音合成。
 *
 * 路由：
 *   POST /api/translate       翻译接口（支持流式 SSE）
 *   POST /api/tts             语音合成接口（Workers AI TTS，返回音频流）
 *   GET  /api/health          健康检查（不调用模型，零 token 成本）
 *   GET  /                    应用页面
 *   GET  /styles.css          设计令牌与全部样式
 *   GET  /app.js              应用逻辑
 *   GET  /theme.js            首屏主题引导（避免明暗闪色）
 *   GET  /manifest.json       PWA manifest
 *   GET  /sw.js               Service Worker
 *   GET  /icon.svg            应用图标（普通 / favicon / 旧 png 别名）
 *   GET  /icon-maskable.svg   应用图标（maskable）
 *
 * 安全说明：API 有意不开放跨域（CORS），仅同源页面可调用；
 * 如需跨域使用，请自行添加来源白名单，不要图省事写 `Access-Control-Allow-Origin: *`。
 *
 * Changelog v3.0（本次界面重构）
 *   - 前端去依赖：移除 Tailwind CDN（运行时 JIT 阻塞首屏）、Remixicon 图标字体、
 *     Google Fonts @import。图标改为内联 SVG 精灵，字体改为系统栈。
 *     断网时不再出现空白方块图标，也不再被 fonts.googleapis.com 卡住渲染。
 *   - CSP 收紧：客户端脚本改为同源 /app.js，script-src 去掉 'unsafe-inline'。
 *   - 语种单一数据源：LANGS 一张表同时提供模型语言名 / 界面名 / 朗读 locale / OCR 语言包，
 *     前端 select 由页面注入的 boot-data 生成，新增语言只改一处。
 *   - 故障转移只重试「换模型有意义」的错误：401/403/404/400 等配置错误立即失败并给出
 *     可定位的提示，不再把 API_KEY 配错报成「模型额度不足」。
 *   - 限流可感知：响应带 RateLimit-Remaining / Retry-After，撞限后前端暂停自动翻译并倒计时，
 *     而不是继续每 1.2 秒打一发请求。
 *   - SSE 首帧带 {meta:{model}}，前端能显示实际命中的模型与耗时。
 *   - 阿拉伯语 / 印地语译文按 RTL 排版；输入输出统一 dir="auto"。
 *   - 字符计数改按码点，emoji 不再被算成 2 个字符；请求体闸门按字节而非字符判断。
 *   - 新增：译文展示模式（给对方看）、系统分享、从相册选图 OCR、历史搜索/分组/导出、
 *     服务状态面板与快捷键说明、Tesseract 按需加载（不再每次访问都拉识别库）。
 *   - Service Worker 预缓存补齐 /styles.css /app.js /theme.js，版本号统一由 APP_VERSION 驱动。
 *
 * Changelog v2.1
 *   - 限流：每 IP 滑动窗口（isolate 内存态，近似精确，配合 CF 全局限额使用）
 *   - 请求体先读文本再解析，带大小闸门，杜绝超大/畸形 JSON 拖垮 isolate
 *   - 按模型上下文动态压缩 max_tokens，输入超长时不再触发 context 溢出
 *   - 错误响应不再透传内部细节；统一写入 Workers 日志（observability）
 *   - 新增 CSP / HSTS / COOP / X-Robots-Tag 安全响应头
 *   - 修复语种检测优先级：含日文汉字的句子不再被误判为中文
 *   - TTS 统一 MeloTTS + 英文 Aura-2 兜底，ReadableStream 读全合并、空音频防护
 */

// 翻译服务通过环境变量 API_URL、API_KEY、MODEL 驱动（OpenAI Chat Completions 兼容接口）
// MODEL 支持单个模型名（如 "gpt-4o-mini"）或逗号分隔的多个主备模型（如 "gpt-4o-mini,deepseek-chat"）
const UPSTREAM_TIMEOUT_MS = 30000; // 上游翻译 API 超时时间（毫秒）

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
const AUTO_DEBOUNCE_MS = 1200;     // 自动翻译：停止输入后多久发起请求
const APP_VERSION = 'v10';          // 每次改动前端资源必须递增：SW 缓存名与 ?v= 都跟着失效
const SW_VERSION = 'ai-trans-' + APP_VERSION;
const HISTORY_LIMIT = 50;

// 每 IP 限流（内存态，接近精确；跨 isolate 不共享，属于第一道闸门而非硬限制）
const RATE_LIMIT = { WINDOW_MS: 60000, MAX_REQUESTS: 30 };
const rateBuckets = new Map(); // ip -> { count, resetAt }
let lastSweepAt = 0;

// 语种唯一数据源。旧版本把语种分散在四张表里（LANG_NAMES、前端两个 select、
// SPEECH_LANG、OCR_LANG），加一门语言要改四个地方，漏一处就在朗读或 OCR 上出错。
// 现在只维护这一张：en 给模型看，zh 给界面看，tts 是 BCP-47 朗读 locale，
// ocr 是 Tesseract 语言包代码。前端 select 选项由 / 页面注入，不再手写。
const LANGS = {
  chinese:    { en: 'Simplified Chinese', zh: '中文',     tts: 'zh-CN', ocr: 'chi_sim' },
  english:    { en: 'English',            zh: '英语',     tts: 'en-US', ocr: 'eng' },
  japanese:   { en: 'Japanese',           zh: '日语',     tts: 'ja-JP', ocr: 'jpn' },
  korean:     { en: 'Korean',             zh: '韩语',     tts: 'ko-KR', ocr: 'kor' },
  french:     { en: 'French',             zh: '法语',     tts: 'fr-FR', ocr: 'fra' },
  german:     { en: 'German',             zh: '德语',     tts: 'de-DE', ocr: 'deu' },
  spanish:    { en: 'Spanish',            zh: '西语',     tts: 'es-ES', ocr: 'spa' },
  russian:    { en: 'Russian',            zh: '俄语',     tts: 'ru-RU', ocr: 'rus' },
  italian:    { en: 'Italian',            zh: '意大利语', tts: 'it-IT', ocr: 'ita' },
  portuguese: { en: 'Portuguese',         zh: '葡萄牙语', tts: 'pt-BR', ocr: 'por' },
  arabic:     { en: 'Arabic',             zh: '阿拉伯语', tts: 'ar-SA', ocr: 'ara' },
  hindi:      { en: 'Hindi',              zh: '印地语',   tts: 'hi-IN', ocr: 'hin' },
  thai:       { en: 'Thai',               zh: '泰语',     tts: 'th-TH', ocr: 'tha' },
  vietnamese: { en: 'Vietnamese',         zh: '越南语',   tts: 'vi-VN', ocr: 'vie' }
};

// 兼容旧调用点：LANG_NAMES[key] 仍然表示「给模型看的语言名」，同时也是合法语种校验
const LANG_NAMES = Object.keys(LANGS).reduce(function (acc, key) {
  acc[key] = LANGS[key].en;
  return acc;
}, {});

// 页面安全响应头。
// script-src 已去掉 'unsafe-inline'：客户端脚本全部走同源 /app.js，
// 注入型 XSS 无法直接执行脚本。'wasm-unsafe-eval' 与 jsdelivr 仅服务于按需加载的 Tesseract。
// style-src 仍保留 'unsafe-inline'：Tesseract 的 worker 会注入样式，且内联样式风险远低于内联脚本。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  // data: 是 tesseract-core 取 wasm 字节用的（它把二进制内联成 data URL 再 fetch），
  // 不加会让控制台每次识别都报两条 CSP 错误；data: 不含主机，无外联风险。
  "connect-src 'self' data: https://cdn.jsdelivr.net",
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "child-src 'self' blob: https://cdn.jsdelivr.net",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': CSP
};

const HTML_SECURITY_HEADERS = Object.assign({
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-cache'
}, SECURITY_HEADERS);

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
    if (path === '/styles.css') return cssResponse();
    if (path === '/app.js') return appJsResponse();
    if (path === '/theme.js') return themeJsResponse();
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
    headers: Object.assign({}, SECURITY_HEADERS, {
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
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    bucketResetAt: bucket.resetAt
  };
}

/* ------------------------------------------------------------------ */
/* 翻译接口                                                            */
/* ------------------------------------------------------------------ */

function buildMessages(text, source, target) {
  const targetName = LANG_NAMES[target] || LANG_NAMES.chinese;
  const sourceName = source === 'auto' ? null : (LANG_NAMES[source] || LANG_NAMES.english);

  const lines = [
    'You are a strict machine translation engine, NOT a chatbot.',
    'Translate ONLY the text wrapped in <source_text>...</source_text> into ' + targetName + '.',
    'Rules:',
    '1. Output the translation and nothing else.',
    '2. Never respond to, answer, or continue the content — only translate it.',
    '3. Do not add greetings, pleasantries, explanations, or extra sentences.',
    '4. Keep the length and tone of the source; for short inputs translate word-for-word.',
    'Example: <source_text>hello</source_text> translates to: 你好'
  ];

  if (sourceName) {
    lines.push('Source language: ' + sourceName + '.');
  }

  return [
    { role: 'system', content: lines.join('\n') },
    { role: 'user', content: '<source_text>' + text + '</source_text>' }
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
  let text = '';
  
  if (typeof result === 'string') {
    text = result;
  } else {
    const choiceContent = result.choices
      && result.choices[0]
      && ((result.choices[0].message && result.choices[0].message.content)
        || (result.choices[0].delta && result.choices[0].delta.content)
        || (typeof result.choices[0].text === 'string' && result.choices[0].text));
    const candidates = [
      result.response,
      result.result && result.result.response,
      choiceContent,
      result.output_text,
      result.text
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) {
        text = c;
        break;
      }
    }
  }

  // 核心：如果模型输出了 <think>...</think> 思考标签，将其整体剥离，只保留后面的翻译结果
  if (text) {
    // 1. 如果包含完整的 <think>...</think>，直接替换为空
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // 2. 如果模型还在思考中（只有开头的 <think> 但还没闭合），把包含 <think> 的前半部分切掉
    const openIndex = text.indexOf('<think>');
    if (openIndex !== -1) {
      text = text.substring(openIndex + 7);
    }
    const closeIndex = text.indexOf('</think>');
    if (closeIndex !== -1) {
      text = text.substring(closeIndex + 8);
    }
    return text.trim();
  }

  return '';
}

function isCapacityError(err) {
  // 先看状态码再看文案：上游的 402 常常只写 "Insufficient Balance"，
  // 只匹配 quota 会让它退化成一句没有信息量的「翻译服务出错」。
  const status = err && err.status;
  if (status === 402 || status === 429 || status === 503) return true;
  const message = String((err && err.message) || err);
  return /neuron|quota|capacity|too many requests|overload|insufficient|balance|credit|arrears|余额|额度/i.test(message);
}

// 配置类错误换模型也没有用：API_KEY 错、地址或模型名错、请求本身不合法。
// 旧版对这类错误也会把备选模型全部试一遍，既慢又贵，还会把真实原因
// 淹没在「模型额度不足」这种误导性提示里。
function isConfigError(err) {
  const status = err && err.status;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) return true;
  return /invalid.?api.?key|authentication|incorrect api key|model.?not.?found|does not exist|not a valid model|unsupported/i
    .test(String((err && err.message) || err));
}

// 预读上游 ReadableStream 的首个数据块并包装异常捕获：
// 1. 若模型在吐出首帧前报错，能在返回 HTTP 200 头之前被 try/catch 捕获并触发降级；
// 2. 若流传输中途报错，转为标准错误 SSE 帧并正常结束流，避免连接异常断开导致浏览器报 Failed to fetch。
async function wrapAiStream(upstream) {
  const reader = upstream.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  let sseBuffer = '';
  let modelTextBuffer = '';
  let thinkClosed = false;

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // 收尾时把残留缓冲一次性放行：短文本（累计 ≤20 字）从未触发放行条件，
            // 不在这里冲掉就会被静默丢弃，前端误报"模型没有返回内容"。
            let tail = '';
            if (!thinkClosed) {
              const closeIdx = modelTextBuffer.indexOf('</think>');
              if (closeIdx !== -1) {
                tail = modelTextBuffer.substring(closeIdx + 8);
              } else if (modelTextBuffer.indexOf('<think>') === -1) {
                // 非推理模型：直接放行残留译文
                tail = modelTextBuffer;
              }
              // 仍在 <think> 中且未闭合：思考未完成，丢弃残留，避免半截思考污染译文
            } else {
              tail = modelTextBuffer;
            }
            if (tail) {
              controller.enqueue(enc.encode('data: ' + JSON.stringify({ response: tail }) + '\n\n'));
            }
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }

          sseBuffer += dec.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop(); // 保留最后一行未完成的片段

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.indexOf('data:') !== 0) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;

            try {
              const obj = JSON.parse(payload);
              const piece = obj.choices && obj.choices[0] && (
                (obj.choices[0].delta && obj.choices[0].delta.content) ||
                (obj.choices[0].message && obj.choices[0].message.content) ||
                obj.choices[0].text
              );

              if (piece) {
                modelTextBuffer += piece;

                // 如果还没检测到思考结束标签 </think>
                if (!thinkClosed) {
                  const closeIdx = modelTextBuffer.indexOf('</think>');
                  if (closeIdx !== -1) {
                    // 找到 </think>！说明思考结束，截取后面的正式译文开始推送
                    thinkClosed = true;
                    const remaining = modelTextBuffer.substring(closeIdx + 8);
                    modelTextBuffer = '';
                    if (remaining) {
                      const outObj = { response: remaining };
                      controller.enqueue(enc.encode('data: ' + JSON.stringify(outObj) + '\n\n'));
                    }
                  } else {
                    // 如果累积了较多字符依然没有 <think> 标签（说明这不是推理模型），则直接放行
                    if (modelTextBuffer.length > 20 && modelTextBuffer.indexOf('<think>') === -1) {
                      thinkClosed = true;
                      const out = modelTextBuffer;
                      modelTextBuffer = '';
                      const outObj = { response: out };
                      controller.enqueue(enc.encode('data: ' + JSON.stringify(outObj) + '\n\n'));
                    }
                  }
                } else {
                  // 已经过了思考阶段，正常流式输出译文
                  const outObj = { response: piece };
                  controller.enqueue(enc.encode('data: ' + JSON.stringify(outObj) + '\n\n'));
                  modelTextBuffer = ''; // 已发出，清空以免收尾时重复发送
                }
              }
            } catch (e) {
              // 忽略解析异常
            }
          }
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

// 规范化 API_URL：支持填写完整 /chat/completions 地址、带版本号的基地址（如 .../v1、.../v4）或纯域名根地址
function normalizeApiUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const p = u.pathname.replace(/\/+$/, '');
    if (!p) {
      u.pathname = '/v1/chat/completions';
    } else if (!/\/(chat\/)?completions$/i.test(p)) {
      u.pathname = p + '/chat/completions';
    } else {
      u.pathname = p;
    }
    return u.toString();
  } catch (e) {
    return '';
  }
}

// 读取并解析环境变量中的 API_URL、API_KEY 和 MODEL
function getTranslateConfig(env) {
  const rawUrl = (env && typeof env.API_URL === 'string') ? env.API_URL.trim() : '';
  const apiKey = (env && typeof env.API_KEY === 'string') ? env.API_KEY.trim() : '';
  const rawModel = (env && typeof env.MODEL === 'string') ? env.MODEL.trim() : '';
  const models = Array.from(new Set(
    rawModel.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
  ));
  const missing = [];
  if (!rawUrl) missing.push('API_URL');
  if (!apiKey) missing.push('API_KEY');
  if (!models.length) missing.push('MODEL');
  const endpoint = rawUrl ? normalizeApiUrl(rawUrl) : '';
  let host = '';
  if (endpoint) {
    try { host = new URL(endpoint).host; } catch (e) { host = ''; }
  }
  return {
    rawUrl: rawUrl,
    endpoint: endpoint,
    host: host,
    // API_KEY 走明文 HTTP 上送等于公开；不阻断（自建网关有内网场景），但要在日志和健康检查里点名
    insecure: !!endpoint && endpoint.indexOf('http://') === 0,
    apiKey: apiKey,
    models: models,
    missing: missing
  };
}

// 调用外部 OpenAI 兼容接口（支持流式 SSE 与非流式 JSON）
async function callExternalAi(endpoint, apiKey, model, params) {
  const wantStream = !!(params && params.stream);
  const body = {
    model: model,
    messages: params.messages,
    max_tokens: params.max_tokens,
    temperature: params.temperature,
    stream: wantStream
  };

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, UPSTREAM_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Accept': wantStream ? 'text/event-stream, application/json' : 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    throw fetchErr;
  }

  if (!res.ok) {
    clearTimeout(timer);
    let detail = '';
    try {
      const errText = await res.text();
      try {
        const errJson = JSON.parse(errText);
        detail = (errJson && errJson.error && (errJson.error.message || errJson.error.code || errJson.error))
          || (errJson && errJson.message)
          || errText;
      } catch (_) {
        detail = errText;
      }
    } catch (_) {}
    const err = new Error('Upstream HTTP ' + res.status + (detail ? ': ' + String(detail).slice(0, 200) : ''));
    err.status = res.status;
    throw err;
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (wantStream) {
    // 兼容部分上游即使传了 stream: true 也直接返回 JSON 的情况
    if (ct.indexOf('application/json') !== -1) {
      clearTimeout(timer);
      const data = await res.json();
      const text = extractText(data);
      if (!text) throw new Error('Empty JSON response from upstream in stream mode');
      return text;
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      clearTimeout(timer);
      return await res.text();
    }
    try {
      const wrapped = await wrapAiStream(res.body);
      clearTimeout(timer);
      return wrapped;
    } catch (streamInitErr) {
      clearTimeout(timer);
      throw streamInitErr;
    }
  }

  try {
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 支持在环境变量 MODEL 中用逗号配置多个模型按顺序故障转移
async function runWithFailover(config, params) {
  const models = config.models;
  let lastError = null;
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    try {
      const result = await callExternalAi(config.endpoint, config.apiKey, m, params);
      return { model: m, result: result };
    } catch (err) {
      lastError = err;
      if (isConfigError(err)) throw err;   // 换模型无意义，立即失败
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

// 在 SSE 流最前面插一帧元信息（实际命中的模型名）。
// 前端据此显示「由哪个模型译出」，故障转移发生时用户也能看到真实来源。
function withMetaFrame(stream, meta) {
  const enc = new TextEncoder();
  const head = 'data: ' + JSON.stringify({ meta: meta }) + '\n\n';
  const reader = stream.getReader();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(head));
      function pump() {
        return reader.read().then(function (step) {
          if (step.done) { controller.close(); return; }
          controller.enqueue(step.value);
          return pump();
        });
      }
      return pump().catch(function (err) {
        log('error', 'meta_pump_failed', { error: safeErr(err) });
        try { controller.close(); } catch (e) {}
      });
    },
    cancel(reason) { try { reader.cancel(reason); } catch (e) {} }
  });
}

function sseResponse(upstream, meta, extraHeaders) {
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
  if (meta && meta.model) body = withMetaFrame(body, meta);
  return new Response(body, {
    headers: Object.assign({}, SECURITY_HEADERS, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store'
    }, extraHeaders || {}, {
      // 关掉中间层缓冲，否则逐字输出会被攒成整段
      'X-Accel-Buffering': 'no'
    })
  });
}

async function handleTranslate(request, env) {
  // 1) 限流（无论请求是否合法都计数，防止无效请求轰炸）
  const limit = checkRateLimit(getClientIp(request));
  if (!limit.ok) {
    return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429, {
      'Retry-After': String(limit.retryAfter),
      'RateLimit-Limit': String(RATE_LIMIT.MAX_REQUESTS),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': String(limit.retryAfter)
    });
  }

  // 2) 先读文本再解析：直接 request.json() 会让超大/畸形 body 进入解析器
  let rawBody;
  try {
    rawBody = await request.text();
  } catch (e) {
    return jsonResponse({ error: '无法读取请求体' }, 400);
  }
  // 闸门按字节算：rawBody.length 是 UTF-16 字符数，中文请求体会被低估约 3 倍
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
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
  // 与前端一致：按码点计数，避免 emoji / 代理对被算成 2 个字符
  const textLen = Array.from(text).length;

  if (!text) return jsonResponse({ error: '内容不能为空' }, 400);
  if (textLen > MAX_INPUT_CHARS) {
    return jsonResponse({
      error: '文本过长：最多 ' + MAX_INPUT_CHARS + ' 个字符，当前 ' + textLen + ' 个'
    }, 400);
  }

  // 缺省 auto 比缺省 english 更友好：大多数调用方并不会显式传源语言
  const source = payload.source_lang === 'auto' || !LANG_NAMES[payload.source_lang]
    ? 'auto'
    : payload.source_lang;
  const target = LANG_NAMES[payload.target_lang] ? payload.target_lang : 'chinese';
  const wantStream = payload.stream === true;

  // 让前端能感知剩余额度，自动翻译可以主动放慢，而不是撞墙后报错
  const quotaHeaders = {
    'RateLimit-Limit': String(RATE_LIMIT.MAX_REQUESTS),
    'RateLimit-Remaining': String(Math.max(0, RATE_LIMIT.MAX_REQUESTS - limit.count)),
    'RateLimit-Reset': String(Math.ceil((limit.bucketResetAt - Date.now()) / 1000))
  };

  const config = getTranslateConfig(env);
  if (config.missing.length > 0) {
    return jsonResponse({
      error: '未配置完整的翻译环境变量：请在 Cloudflare 控制台 Variables and Secrets 中添加 ' + config.missing.join('、')
    }, 500, quotaHeaders);
  }
  if (!config.endpoint) {
    return jsonResponse({
      error: '环境变量 API_URL 格式不正确，请配置合法的 http/https 接口地址'
    }, 500, quotaHeaders);
  }
  if (config.insecure) {
    log('warn', 'insecure_upstream', { host: config.host });
  }

  const messages = buildMessages(text, source, target);
  const params = { messages: messages, max_tokens: computeMaxTokens(text), temperature: TEMPERATURE };

  try {
    if (wantStream) {
      try {
        const run = await runWithFailover(config, Object.assign({ stream: true }, params));
        return sseResponse(run.result, { model: run.model }, quotaHeaders);
      } catch (streamErr) {
        if (isConfigError(streamErr)) throw streamErr;
        log('warn', 'stream_failed_fallback_to_non_stream', { error: safeErr(streamErr) });
        const run = await runWithFailover(config, params);
        const translated = extractText(run.result);
        if (!translated) throw streamErr;
        return sseResponse(translated, { model: run.model }, quotaHeaders);
      }
    }

    const run = await runWithFailover(config, params);
    const translated = extractText(run.result);
    if (!translated) {
      return jsonResponse({ error: '模型没有返回内容，请稍后重试或换一段更短的文本' }, 502, quotaHeaders);
    }
    return jsonResponse({
      translated_text: translated,
      source_lang: source,
      target_lang: target,
      model: run.model
    }, 200, quotaHeaders);
  } catch (err) {
    log('error', 'translate_failed', { error: safeErr(err), status: err && err.status, host: config.host });
    const status = err && err.status;
    let errMsg = '翻译服务出错，请稍后重试';
    if (status === 401 || status === 403) {
      errMsg = '翻译接口鉴权失败（HTTP ' + status + '），请检查环境变量 API_KEY';
    } else if (status === 404) {
      errMsg = '接口或模型不存在（HTTP 404）：' + config.host + ' 上找不到模型 ' + config.models.join('、');
    } else if (status === 400) {
      errMsg = '接口拒绝了本次请求（HTTP 400），请检查 API_URL 是否指向 chat/completions 端点';
    } else if (isCapacityError(err)) {
      errMsg = '模型额度不足或暂时繁忙（已尝试 ' + config.models.length + ' 个模型），请稍后重试';
    } else if (/abort|timeout/i.test(String((err && err.message) || ''))) {
      errMsg = '模型响应超时（' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + ' 秒），请换更短的文本或更快的模型';
    }
    return jsonResponse({ error: errMsg }, 502, quotaHeaders);
  }
}

/* ------------------------------------------------------------------ */
/* 健康检查                                                            */
/* ------------------------------------------------------------------ */

function healthResponse(env) {
  const config = getTranslateConfig(env);
  return jsonResponse({
    ok: config.missing.length === 0 && !!config.endpoint,
    service: 'ai-translate',
    version: APP_VERSION,
    translate_env: {
      configured: config.missing.length === 0 && !!config.endpoint,
      api_url_set: !!config.rawUrl,
      api_url_valid: !!config.endpoint,
      // 只回主机名，不回完整地址和任何密钥内容
      api_url_host: config.host || null,
      api_url_insecure: config.insecure,
      api_key_set: !!config.apiKey,
      model: config.models[0] || null,
      fallback_models: config.models.slice(1),
      missing: config.missing
    },
    tts_ai_bound: !!(env && env.AI),
    max_input_chars: MAX_INPUT_CHARS,
    languages: Object.keys(LANGS),
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
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
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
  const textLen = Array.from(text).length;
  if (!text) return jsonResponse({ error: '内容不能为空' }, 400);
  if (textLen > TTS_MAX_CHARS) {
    return jsonResponse({
      error: '文本过长：朗读最多 ' + TTS_MAX_CHARS + ' 个字符，当前 ' + textLen + ' 个'
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
        headers: Object.assign({}, SECURITY_HEADERS, {
          'Content-Type': 'audio/wav',
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store',
          // 关掉中间层缓冲，避免音频被分段缓冲后拼接异常
          'X-Accel-Buffering': 'no'
        })
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
          headers: Object.assign({}, SECURITY_HEADERS, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': String(bytes.length),
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no'
          })
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
    description: '基于 Cloudflare Workers 的多语言随身翻译，支持拍照 OCR、朗读与离线使用。',
    lang: 'zh-CN',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait-primary',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    categories: ['utilities', 'productivity', 'travel'],
    shortcuts: [
      { name: '拍照识别', short_name: '拍照', url: '/?action=camera', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] },
      { name: '历史记录', short_name: '历史', url: '/?action=history', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }
    ],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
    ]
  };
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: Object.assign({}, SECURITY_HEADERS, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    })
  });
}

function swResponse() {
  const code = `/* AI 随身翻译 Service Worker —— 由 Worker 动态生成，版本 ${SW_VERSION} */
const VERSION = '${SW_VERSION}';
const V = '__APP_VERSION__';
const ASSET = '?v=' + V;
const PRECACHE = ['/', '/manifest.json', '/icon.svg', '/icon-maskable.svg',
  '/styles.css' + ASSET, '/app.js' + ASSET, '/theme.js' + ASSET];
/* 只有白名单里的同源静态资源才会进入 Cache。
   用「白名单」而不是「排除法」：接口路径一旦改名，排除法就会静默缓存到 JSON 响应。 */
const STATIC_PATHS = ['/manifest.json', '/icon.svg', '/icon-maskable.svg',
  '/styles.css', '/app.js', '/theme.js', '/api/health'];

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

  // 静态资源：stale-while-revalidate（版本号变了就是另一个 URL，不会拿到旧资源）
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
`.replace('__APP_VERSION__', APP_VERSION);
  return new Response(code, {
    headers: Object.assign({}, SECURITY_HEADERS, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/'
    })
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
/* ------------------------------------------------------------------ */
/* 前端资源路由                                                        */
/*                                                                     */
/* 为什么拆成 /styles.css + /app.js + /theme.js 而不是内联：           */
/*   1. CSP 的 script-src 可以去掉 'unsafe-inline'，XSS 无法直接执行脚本；*/
/*   2. 去掉 Tailwind CDN（运行时 JIT，几百 KB JS + 每次重排样式），     */
/*      改为手写 CSS 设计令牌，首屏不再被第三方脚本阻塞；                */
/*   3. 去掉 Remixicon 图标字体与 Google Fonts 字体 @import：            */
/*      离线 PWA 断网时图标会全部变成空白方块，且 fonts.googleapis.com   */
/*      在部分网络环境下会长时间阻塞渲染。图标改为内联 SVG 精灵。        */
/*                                                                     */
/* 维护约定：APP_JS / CSS 位于 String.raw 模板中，内部一律不要出现       */
/* 反引号与 ${；需要拼接时用 + 号。HTML 段允许 ${} 注入。               */
/* ------------------------------------------------------------------ */

function assetResponse(body, mime, extraHeaders) {
  return new Response(body, {
    headers: Object.assign({
      'Content-Type': mime,
      // 资源 URL 带版本号（?v=APP_VERSION），因此可以放心让浏览器与 SW 缓存；
      // 但版本号变化必须能立刻拿到，故用 no-cache 做强制协商而不是长 max-age。
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    }, extraHeaders || {})
  });
}

function cssResponse() { return assetResponse(CSS, 'text/css; charset=utf-8'); }
function appJsResponse() { return assetResponse(APP_JS, 'application/javascript; charset=utf-8'); }
function themeJsResponse() { return assetResponse(THEME_JS, 'application/javascript; charset=utf-8'); }

function htmlResponse() {
  const langOptions = Object.keys(LANGS).map(function (key) {
    return { key: key, zh: LANGS[key].zh, tts: LANGS[key].tts, ocr: LANGS[key].ocr, rtl: !!LANGS[key].rtl };
  });
  const boot = {
    version: APP_VERSION,
    maxChars: MAX_INPUT_CHARS,
    historyLimit: HISTORY_LIMIT,
    debounceMs: AUTO_DEBOUNCE_MS,
    ttsMaxChars: TTS_MAX_CHARS,
    langs: langOptions
  };
  // 用函数式替换：避免替换串里的 $ 被当成特殊模式
  const html = HTML_TEMPLATE
    .replace('__BOOT_JSON__', function () { return JSON.stringify(boot); })
    .replace('__ICONS__', function () { return ICONS; })
    .replace(/__ASSET_VERSION__/g, function () { return APP_VERSION; });
  return new Response(html, {
    headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, HTML_SECURITY_HEADERS, { 'Vary': 'Cookie' })
  });
}

/* ------------------------------------------------------------------ */
/* 主题引导脚本：在首屏绘制前决定明暗，避免闪色                          */
/* ------------------------------------------------------------------ */

const THEME_JS = String.raw`
(function () {
  // 必须读应用真正写入的那个键，否则手动选的主题在刷新时会被忽略、先闪一下错误配色
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('ai-trans:prefs') || '{}').theme; } catch (e) {}
  var dark = saved ? saved === 'dark'
    : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
`;

/* ------------------------------------------------------------------ */
/* 图标精灵（Lucide 风格描边图标，24x24，currentColor）                 */
/* ------------------------------------------------------------------ */

const ICONS = `
<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
<defs>
<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/></symbol>
<symbol id="i-swap" viewBox="0 0 24 24"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></symbol>
<symbol id="i-chev-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
<symbol id="i-volume" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></symbol>
<symbol id="i-volume-off" viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/></symbol>
<symbol id="i-camera" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></symbol>
<symbol id="i-eraser" viewBox="0 0 24 24"><path d="M20 20H7l-4-4a1.4 1.4 0 0 1 0-2l9-9a1.4 1.4 0 0 1 2 0l5 5a1.4 1.4 0 0 1 0 2l-8 8"/><path d="M6 12l6 6"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></symbol>
<symbol id="i-share" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></symbol>
<symbol id="i-expand" viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></symbol>
<symbol id="i-history" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></symbol>
<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></symbol>
<symbol id="i-offline" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></symbol>
<symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></symbol>
<symbol id="i-type" viewBox="0 0 24 24"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></symbol>
<symbol id="i-sparkle" viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></symbol>
<symbol id="i-arrow-down" viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></symbol>
<symbol id="i-keyboard" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></symbol>
</defs>
</svg>`;

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

const CSS = String.raw`
:root {
  --brand-1:#4f46e5; --brand-2:#06b6d4;
  --accent:#4f46e5; --accent-hover:#4338ca; --accent-soft:#eef0ff; --accent-line:#dfe2ff;
  --surface:#ffffff; --surface-2:#f7f8fc; --surface-3:#eceef6;
  --text:#0f1729; --text-2:#55617a; --text-3:#8b96ad;
  --line:#e5e8f1; --line-strong:#d5daea;
  --danger:#e11d48; --danger-soft:#fff1f3;
  --ok:#0d9488; --warn:#b45309; --warn-soft:#fff7e8;
  --ring:rgba(79,70,229,.30);
  --shadow-1:0 1px 2px rgba(15,23,41,.05);
  --shadow-pop:0 20px 52px -20px rgba(15,23,41,.36);
  --radius:12px; --radius-lg:18px;
  --blur:saturate(180%) blur(14px);
  --font:-apple-system,BlinkMacSystemFont,'PingFang SC','HarmonyOS Sans SC','Microsoft YaHei','Segoe UI',Roboto,system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
[data-theme="dark"] {
  --accent:#93a1ff; --accent-hover:#b6c0ff; --accent-soft:rgba(147,161,255,.16); --accent-line:rgba(147,161,255,.34);
  --surface:#141a28; --surface-2:#1a2133; --surface-3:#232c42;
  --text:#e9eefb; --text-2:#a3aec6; --text-3:#75809a;
  --line:rgba(255,255,255,.10); --line-strong:rgba(255,255,255,.18);
  --danger:#ff8ba0; --danger-soft:rgba(255,139,160,.14);
  --ok:#5eead4; --warn:#fbbf24; --warn-soft:rgba(251,191,36,.14);
  --ring:rgba(147,161,255,.42);
  --shadow-1:0 1px 2px rgba(0,0,0,.5);
  --shadow-pop:0 28px 70px -24px rgba(0,0,0,.92);
}

*,*::before,*::after { box-sizing:border-box; }
[hidden] { display:none !important; }
html,body { height:100%; }
body {
  margin:0; font-family:var(--font); color:var(--text); background:var(--surface);
  font-size:15px; line-height:1.6; overflow-x:hidden;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  transition:background-color .3s ease, color .3s ease;
}
button,input,select,textarea { font:inherit; color:inherit; }
button { border:0; background:none; cursor:pointer; }
svg.ic { width:1em; height:1em; fill:none; stroke:currentColor; stroke-width:1.9; stroke-linecap:round; stroke-linejoin:round; flex:none; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:8px; }
::selection { background:var(--accent-soft); }
* { -webkit-tap-highlight-color:transparent; }
button,select,label,input,textarea { touch-action:manipulation; }
.sr-only { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.sr { position:absolute; top:0; left:0; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }

/* ---------- 主体 ----------
   全幅铺满视口，不做悬浮卡片：外围留白和背景光晕只会吃掉输入区的高度。 */
.app {
  min-height:100dvh; display:flex; flex-direction:column;
  background:var(--surface);
}

/* ---------- 顶栏 ---------- */
.topbar {
  position:sticky; top:0; z-index:30; display:flex; align-items:center; gap:12px;
  padding:12px 16px calc(12px); padding-top:calc(12px + env(safe-area-inset-top));
  background:var(--surface); border-bottom:1px solid var(--line);
}
@supports (background:color-mix(in srgb,red 50%,blue)) {
  .topbar { background:color-mix(in srgb,var(--surface) 86%,transparent); backdrop-filter:var(--blur); -webkit-backdrop-filter:var(--blur); }
}
.brand { display:flex; align-items:center; gap:10px; min-width:0; }
.mark {
  width:34px; height:34px; border-radius:10px; flex:none; display:grid; place-items:center;
  color:#fff; font-size:19px; background:linear-gradient(135deg,var(--brand-1),var(--brand-2));
  box-shadow:0 6px 16px -6px rgba(79,70,229,.7);
}
.brand-text { display:flex; flex-direction:column; line-height:1.15; min-width:0; }
.brand-text strong { font-size:15px; font-weight:700; letter-spacing:.2px; }
.brand-text small { font-size:10px; color:var(--text-3); letter-spacing:.7px; text-transform:uppercase; }
.top-right { margin-inline-start:auto; display:flex; align-items:center; gap:8px; }
.pill {
  display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 10px; border-radius:999px;
  font-size:11.5px; font-weight:600; white-space:nowrap; border:1px solid transparent;
}
.pill svg.ic { font-size:13px; }
.pill--muted { background:var(--surface-3); color:var(--text-2); border-color:var(--line); }
.pill--warn { background:var(--warn-soft); color:var(--warn); border-color:rgba(180,83,9,.28); }
.pill--bad { background:var(--danger-soft); color:var(--danger); border-color:rgba(225,29,72,.26); }
.seg { display:flex; gap:2px; padding:3px; border-radius:12px; background:var(--surface-3); border:1px solid var(--line); }
.icon-btn {
  width:32px; height:32px; border-radius:9px; display:grid; place-items:center; font-size:17px;
  color:var(--text-2); transition:background .18s, color .18s, transform .12s;
}
.icon-btn:hover { background:var(--surface); color:var(--accent); }
.icon-btn:active { transform:scale(.93); }
.icon-btn.is-on { background:var(--accent-soft); color:var(--accent); }
@media (max-width:560px) { .brand-text small { display:none; } .pill--model { display:none; } }

/* ---------- 语种栏 ---------- */
.langbar {
  display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:6px;
  padding:10px 16px; border-bottom:1px solid var(--line); background:var(--surface-2);
}
.lang { display:flex; align-items:center; gap:8px; min-width:0; }
.lang--end { justify-content:flex-end; }
.lang-label { font-size:10px; font-weight:700; letter-spacing:.8px; color:var(--text-3); text-transform:uppercase; flex:none; }
.select-wrap { position:relative; display:flex; align-items:center; min-width:0; }
.select {
  appearance:none; -webkit-appearance:none; max-width:170px; padding:7px 30px 7px 12px; border-radius:10px;
  font-size:14px; font-weight:600; cursor:pointer;
  background:var(--surface); border:1px solid var(--line-strong); color:var(--text);
  transition:border-color .18s, box-shadow .18s;
}
.select:hover { border-color:var(--accent-line); }
.select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--ring); }
.select--accent { color:var(--accent); border-color:var(--accent-line); background:var(--accent-soft); }
.select-wrap svg.ic { position:absolute; inset-inline-end:9px; font-size:16px; color:var(--text-3); pointer-events:none; }
.swap {
  width:36px; height:36px; border-radius:12px; flex:none; display:grid; place-items:center; font-size:17px;
  background:var(--surface); border:1px solid var(--line-strong); color:var(--accent); box-shadow:var(--shadow-1);
  transition:transform .3s cubic-bezier(.5,1.6,.5,1), background .18s, color .18s;
}
.swap:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
.swap:active { transform:scale(.9); }
.swap.is-flipped { transform:rotate(180deg); }

/* ---------- 双栏 ---------- */
.panes { flex:1; display:grid; grid-template-rows:minmax(200px,.92fr) minmax(220px,1.08fr); min-height:0; }
@media (min-width:900px) { .panes { grid-template-rows:none; grid-template-columns:1fr 1fr; } }
.pane { position:relative; display:flex; flex-direction:column; min-height:0; min-width:0; }
.pane + .pane { border-top:1px solid var(--line); background:var(--surface-2); }
@media (min-width:900px) { .pane + .pane { border-top:0; border-inline-start:1px solid var(--line); } }
.editor {
  flex:1; width:100%; display:block; border:0; background:transparent; resize:none; overflow-y:auto;
  padding:18px 16px 6px; font-size:17px; line-height:1.75; color:var(--text); scrollbar-gutter:stable;
}
.editor:focus { outline:none; }
.editor::placeholder { color:var(--text-3); }
.output {
  flex:1; padding:18px 16px 6px; overflow-y:auto; scrollbar-gutter:stable; user-select:text;
  font-size:18px; line-height:1.75; color:var(--text); white-space:pre-wrap; overflow-wrap:anywhere;
}
.output.is-empty::before { content:attr(data-placeholder); color:var(--text-3); font-size:16px; }
.output.is-streaming::after {
  content:''; display:inline-block; width:8px; height:19px; margin-inline-start:3px; vertical-align:-3px;
  border-radius:2px; background:var(--accent); animation:caret 1.05s steps(1) infinite;
}
@keyframes caret { 50% { opacity:0; } }
.hint {
  display:flex; align-items:center; gap:6px; min-height:20px; padding:4px 16px 0;
  font-size:11.5px; color:var(--text-3);
}
.hint svg.ic { font-size:13px; }
.hint .kbd { font-family:var(--mono); font-size:10px; padding:1px 5px; border-radius:5px; background:var(--surface-3); border:1px solid var(--line); }
@media (max-width:899px) { .hint .desk-only { display:none; } }

/* ---------- 工具栏 ---------- */
.toolbar {
  display:flex; align-items:center; gap:8px; padding:10px 14px;
  padding-bottom:calc(10px + env(safe-area-inset-bottom));
  border-top:1px solid var(--line); background:var(--surface);
}
@media (min-width:900px) { .toolbar { background:var(--surface-2); } }
.toolbar-left { flex:1; display:flex; align-items:center; gap:10px; min-width:0; flex-wrap:wrap; }
.toolset { display:flex; align-items:center; gap:5px; flex:none; }
.counter { font-size:11.5px; color:var(--text-3); font-variant-numeric:tabular-nums; white-space:nowrap; }
.counter.is-over { color:var(--danger); font-weight:700; }
.switch { display:inline-flex; align-items:center; gap:7px; font-size:12px; color:var(--text-2); cursor:pointer; user-select:none; white-space:nowrap; }
.switch input { position:absolute; opacity:0; width:0; height:0; }
.track { width:34px; height:20px; border-radius:999px; background:var(--line-strong); position:relative; flex:none; transition:background .22s; }
.track::after {
  content:''; position:absolute; top:2px; inset-inline-start:2px; width:16px; height:16px; border-radius:50%;
  background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.3); transition:transform .22s cubic-bezier(.4,1.4,.5,1);
}
.switch input:checked + .track { background:var(--accent); }
.switch input:checked + .track::after { transform:translateX(14px); }
.switch input:focus-visible + .track { box-shadow:0 0 0 3px var(--ring); }
.tool {
  width:32px; height:32px; border-radius:10px; display:grid; place-items:center; font-size:17px;
  background:var(--surface); border:1px solid var(--line); color:var(--text-2); box-shadow:var(--shadow-1);
  transition:color .16s, border-color .16s, background .16s, transform .12s;
}
.tool:hover { color:var(--accent); border-color:var(--accent-line); background:var(--accent-soft); }
.tool:active { transform:scale(.92); }
.tool:disabled { opacity:.4; pointer-events:none; }
.tool.is-on { color:#fff; background:var(--accent); border-color:var(--accent); animation:breathe 1.25s ease-in-out infinite; }
@keyframes breathe { 50% { transform:scale(1.08); opacity:.8; } }
.btn-ghost {
  display:inline-flex; align-items:center; justify-content:center; gap:5px; height:32px; padding:0 11px;
  border-radius:10px; font-size:13px; font-weight:600; color:var(--text-2); white-space:nowrap;
  background:var(--surface-3); border:1px solid var(--line); transition:color .16s, border-color .16s, background .16s;
}
.btn-ghost:hover { color:var(--accent); border-color:var(--accent-line); background:var(--accent-soft); }
.btn-ghost svg.ic { font-size:15px; }
.btn-primary {
  display:inline-flex; align-items:center; justify-content:center; gap:7px; height:40px; padding:0 20px; flex:none;
  border-radius:12px; font-size:14.5px; font-weight:700; color:#fff; letter-spacing:.2px;
  background:linear-gradient(135deg,var(--brand-1),#6366f1 55%,var(--brand-2));
  box-shadow:0 8px 22px -10px rgba(79,70,229,.85); transition:filter .18s, transform .12s, box-shadow .18s;
}
.btn-primary:hover { filter:brightness(1.08); }
.btn-primary:active { transform:translateY(1px) scale(.985); }
.btn-primary:disabled { opacity:.5; filter:grayscale(.4); box-shadow:none; cursor:not-allowed; }
.btn-primary svg.ic { font-size:17px; }
.spinner { width:15px; height:15px; border:2px solid rgba(255,255,255,.4); border-bottom-color:#fff; border-radius:50%; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

/* ---------- 遮罩 / 抽屉 ---------- */
.scrim { position:fixed; inset:0; z-index:60; background:rgba(8,12,22,.42); opacity:0; pointer-events:none; transition:opacity .25s; }
.scrim.is-open { opacity:1; pointer-events:auto; }
.drawer {
  position:fixed; top:0; inset-inline-end:0; bottom:0; z-index:70; width:min(400px,92vw);
  display:flex; flex-direction:column; background:var(--surface); border-inline-start:1px solid var(--line);
  box-shadow:var(--shadow-pop); transform:translateX(102%); transition:transform .3s cubic-bezier(.32,.9,.3,1);
}
html[dir="rtl"] .drawer { transform:translateX(-102%); }
.drawer.is-open { transform:translateX(0) !important; }
.drawer-head { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--line); }
.drawer-head h2 { margin:0; font-size:15.5px; font-weight:700; }
.drawer-head .count { font-size:11.5px; color:var(--text-3); }
.search { position:relative; margin:12px 16px 4px; }
.search svg.ic { position:absolute; inset-inline-start:10px; top:10px; font-size:15px; color:var(--text-3); pointer-events:none; }
.search input {
  width:100%; height:36px; padding:0 12px 0 32px; border-radius:10px; font-size:13.5px;
  background:var(--surface-2); border:1px solid var(--line);
}
html[dir="rtl"] .search input { padding:0 32px 0 12px; }
.search input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--ring); }
.list { flex:1; overflow-y:auto; padding:8px 12px 12px; }
.day { padding:12px 6px 6px; font-size:10px; font-weight:700; letter-spacing:.8px; text-transform:uppercase; color:var(--text-3); }
.item {
  position:relative; margin-bottom:8px; padding:11px 12px; border-radius:var(--radius); cursor:pointer;
  background:var(--surface-2); border:1px solid var(--line); transition:border-color .18s, background .18s;
}
.item:hover { border-color:var(--accent-line); background:var(--accent-soft); }
.item-src, .item-dst {
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
  unicode-bidi:plaintext; text-align:start;
}
.item-src { font-size:13.5px; font-weight:600; }
.item-dst { font-size:13px; color:var(--accent); margin-top:3px; }
.item-meta { display:flex; align-items:center; gap:6px; margin-top:7px; font-size:10.5px; color:var(--text-3); flex-wrap:wrap; }
.chip { padding:1px 6px; border-radius:6px; background:var(--surface-3); border:1px solid var(--line); font-weight:600; }
.item-acts { position:absolute; top:8px; inset-inline-end:8px; display:flex; gap:2px; opacity:0; transition:opacity .16s; }
.item:hover .item-acts, .item:focus-within .item-acts { opacity:1; }
@media (hover:none) { .item-acts { opacity:.65; } }
.mini { width:26px; height:26px; border-radius:8px; display:grid; place-items:center; font-size:14px; color:var(--text-3); }
.mini:hover { background:var(--surface); color:var(--accent); }
.mini--danger:hover { color:var(--danger); background:var(--danger-soft); }
.drawer-foot { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--line); padding-bottom:calc(12px + env(safe-area-inset-bottom)); }
.drawer-foot .btn-ghost { flex:1; }
.empty { padding:44px 20px; text-align:center; color:var(--text-3); font-size:13.5px; }
.empty svg.ic { display:block; margin:0 auto 10px; font-size:30px; opacity:.45; }

/* ---------- 弹窗 ---------- */
.modal { position:fixed; inset:0; z-index:80; display:none; place-items:center; padding:20px; background:rgba(8,12,22,.42); }
.modal.is-open { display:grid; }
.box {
  width:min(470px,100%); max-height:84dvh; overflow-y:auto; padding:20px;
  background:var(--surface); border:1px solid var(--line); border-radius:var(--radius-lg); box-shadow:var(--shadow-pop);
  animation:pop .2s cubic-bezier(.3,1.3,.5,1);
}
@keyframes pop { from { opacity:0; transform:translateY(10px) scale(.985); } }
.box h3 { margin:0 0 4px; font-size:16px; font-weight:700; }
.box .sub { margin:0 0 14px; font-size:12.5px; color:var(--text-3); }
.kv { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:9px 0; border-bottom:1px dashed var(--line); font-size:13px; }
.kv:last-of-type { border-bottom:0; }
.kv dt { color:var(--text-2); }
.kv dd { margin:0; font-weight:600; text-align:end; word-break:break-all; }
.dot { width:7px; height:7px; border-radius:50%; display:inline-block; margin-inline-end:7px; vertical-align:1px; }
.dot--ok { background:var(--ok); } .dot--bad { background:var(--danger); }
.box-actions { display:flex; gap:8px; margin-top:16px; }
.box-actions .btn-ghost, .box-actions .btn-primary { flex:1; }
.shortcut { display:flex; justify-content:space-between; gap:10px; padding:6px 0; font-size:12.5px; color:var(--text-2); }
.shortcut .kbd { font-family:var(--mono); font-size:11px; padding:2px 6px; border-radius:6px; background:var(--surface-3); border:1px solid var(--line); }

/* ---------- 提示条 ---------- */
.toasts {
  position:fixed; top:calc(14px + env(safe-area-inset-top)); inset-inline:0; z-index:90;
  display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none; padding:0 12px;
}
.toast {
  display:flex; align-items:flex-start; gap:9px; max-width:min(560px,94vw); padding:10px 14px; border-radius:12px;
  font-size:13px; font-weight:600; background:var(--surface); color:var(--text); border:1px solid var(--line);
  box-shadow:var(--shadow-pop); opacity:0; transform:translateY(-10px) scale(.97); transition:opacity .22s, transform .22s;
}
.toast.is-show { opacity:1; transform:none; }
.toast svg.ic { font-size:16px; margin-top:1px; }
.toast--err { background:var(--danger-soft); color:var(--danger); border-color:rgba(225,29,72,.26); }
.toast--warn { background:var(--warn-soft); color:var(--warn); border-color:rgba(180,83,9,.24); }
.toast .t-act { color:var(--accent); font-weight:700; white-space:nowrap; pointer-events:auto; }
.toast--err .t-act, .toast--warn .t-act { color:inherit; text-decoration:underline; }

/* ---------- 相机 ---------- */
.camera { position:fixed; inset:0; z-index:100; display:none; flex-direction:column; background:#05070c; }
.camera.is-open { display:flex; }
.cam-view { position:relative; flex:1; overflow:hidden; background:#000; }
.cam-view video { width:100%; height:100%; object-fit:cover; }
.guides { position:absolute; inset:0; pointer-events:none; }
.guides::before {
  content:''; position:absolute; inset:14% 8%; border-radius:14px;
  border:1px solid rgba(255,255,255,.3); box-shadow:0 0 0 200vmax rgba(5,7,12,.5);
}
.scan {
  position:absolute; left:8%; right:8%; height:2px;
  background:linear-gradient(90deg,transparent,var(--brand-2),var(--brand-1),transparent);
  box-shadow:0 0 14px rgba(6,182,212,.9); animation:scan 2.6s ease-in-out infinite;
}
@keyframes scan { 0%,100% { top:16%; opacity:.25; } 50% { top:82%; opacity:1; } }
.ocr {
  position:absolute; inset-inline-start:50%; bottom:22px; transform:translateX(-50%);
  display:flex; align-items:center; gap:9px; padding:9px 15px; border-radius:999px; white-space:nowrap;
  background:rgba(10,14,22,.84); color:#fff; font-size:12.5px; font-weight:600; border:1px solid rgba(255,255,255,.14);
}
.ocr .bar { width:74px; height:4px; border-radius:2px; background:rgba(255,255,255,.22); overflow:hidden; }
.ocr .bar span { display:block; height:100%; width:0; background:linear-gradient(90deg,var(--brand-1),var(--brand-2)); transition:width .2s; }
.cam-bar {
  display:flex; align-items:center; justify-content:space-between; padding:0 26px;
  height:calc(96px + env(safe-area-inset-bottom)); padding-bottom:env(safe-area-inset-bottom);
}
.cam-btn { width:44px; height:44px; border-radius:50%; display:grid; place-items:center; font-size:22px; color:#fff; background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.18); }
.shutter { width:66px; height:66px; border-radius:50%; display:grid; place-items:center; border:3px solid rgba(255,255,255,.9); transition:transform .14s; }
.shutter span { width:52px; height:52px; border-radius:50%; background:#fff; }
.shutter:active { transform:scale(.9); }
.shutter:disabled { opacity:.45; }
.flash { position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none; }
.flash.is-go { animation:flash .35s ease-out; }
@keyframes flash { 0% { opacity:.85; } 100% { opacity:0; } }

/* ---------- 展示模式 ---------- */
.present {
  position:fixed; inset:0; z-index:95; display:none; flex-direction:column; overflow-y:auto; background:var(--surface);
  padding:calc(20px + env(safe-area-inset-top)) 22px calc(24px + env(safe-area-inset-bottom));
}
.present.is-open { display:flex; }
.present-lang { font-size:11.5px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:var(--text-3); }
.present-text {
  flex:1; display:grid; align-content:center; padding:20px 0; font-weight:700; color:var(--text);
  font-size:var(--present-size,34px); line-height:1.35; white-space:pre-wrap; overflow-wrap:anywhere; text-align:start;
}
.present-bar { display:flex; align-items:center; gap:10px; }
.present-bar .btn-primary { margin-inline-start:auto; }

/* 触屏没有 hover，手指要按得中：命中区放大到 40~44px，图标本身只略微变大。
   放在文件末尾，确保能覆盖上面各组件的基础尺寸。 */
@media (pointer:coarse) {
  .icon-btn { width:44px; height:44px; font-size:19px; }
  .mini { width:40px; height:40px; font-size:17px; }
  .langbar { padding-block:12px; }
}
@media (hover:none) {
  .icon-btn:hover { background:transparent; color:var(--text-2); }
  .mini:hover { background:transparent; color:var(--text-3); }
}

@media (prefers-reduced-motion:reduce) {
  *,*::before,*::after { animation-duration:.001ms !important; animation-iteration-count:1 !important; transition-duration:.001ms !important; }
}
@media print { .topbar,.langbar,.toolbar,.hint { display:none; } }
`;

/* ------------------------------------------------------------------ */
/* 结构                                                                */
/* ------------------------------------------------------------------ */

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="基于 Cloudflare Workers 的多语言随身翻译，支持拍照 OCR、朗读与离线使用。">
<title>AI 随身翻译</title>

<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="theme-color" content="#ffffff">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="AI 翻译">
<meta name="apple-mobile-web-app-status-bar-style" content="default">

<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="/styles.css?v=__ASSET_VERSION__">
<script src="/theme.js?v=__ASSET_VERSION__"></script>
<script type="application/json" id="boot-data">__BOOT_JSON__</script>
<script src="/app.js?v=__ASSET_VERSION__" defer></script>
</head>
<body>
__ICONS__
<noscript><div style="padding:24px;text-align:center;font-size:15px">本应用需要启用 JavaScript 才能使用翻译功能。</div></noscript>

<div class="app">
  <header class="topbar">
    <div class="brand">
      <span class="mark"><svg class="ic"><use href="#i-globe"/></svg></span>
      <span class="brand-text"><strong>AI 随身翻译</strong><small>Travel Translate</small></span>
    </div>
    <div class="top-right">
      <span class="pill pill--warn" id="netPill" hidden><svg class="ic"><use href="#i-offline"/></svg>离线</span>
      <span class="pill pill--muted pill--model" id="modelPill" hidden><svg class="ic"><use href="#i-bolt"/></svg><span id="modelName"></span></span>
      <div class="seg">
        <button class="icon-btn" id="btnHistory" type="button" aria-label="历史记录" title="历史记录"><svg class="ic"><use href="#i-history"/></svg></button>
        <button class="icon-btn" id="btnSettings" type="button" aria-label="服务状态与设置" title="服务状态与设置"><svg class="ic"><use href="#i-sliders"/></svg></button>
        <button class="icon-btn" id="btnTheme" type="button" aria-label="切换深色模式" title="切换深色模式"><svg class="ic" id="themeIcon"><use href="#i-moon"/></svg></button>
      </div>
    </div>
  </header>

  <div class="langbar">
    <div class="lang">
      <span class="lang-label">原文</span>
      <div class="select-wrap">
        <select class="select" id="sourceLang" aria-label="源语言"></select>
        <svg class="ic"><use href="#i-chev-down"/></svg>
      </div>
    </div>
    <button class="swap" id="btnSwap" type="button" aria-label="互换语言与内容" title="互换语言与内容"><svg class="ic"><use href="#i-swap"/></svg></button>
    <div class="lang lang--end">
      <span class="lang-label">译文</span>
      <div class="select-wrap">
        <select class="select select--accent" id="targetLang" aria-label="目标语言"></select>
        <svg class="ic"><use href="#i-chev-down"/></svg>
      </div>
    </div>
  </div>

  <main class="panes">
    <section class="pane">
      <label class="sr" for="inputText">要翻译的文字</label>
      <textarea class="editor" id="inputText" dir="auto" rows="3" spellcheck="false"
        autocomplete="off" autocapitalize="off" autocorrect="off"
        placeholder="输入文字，或点相机图标拍照识别…"></textarea>
      <div class="hint"><svg class="ic"><use href="#i-clock"/></svg><span id="srcHint">停止输入后自动翻译</span><span class="desk-only"><span class="kbd">⌘/Ctrl</span>+<span class="kbd">Enter</span> 立即翻译</span></div>
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="counter" id="charCount">0 / 3000</span>
          <label class="switch" title="停止输入后自动翻译">
            <input type="checkbox" id="autoTranslate" checked><span class="track"></span>自动
          </label>
          <div class="toolset">
            <button class="tool" id="btnSpeakSource" type="button" aria-label="朗读原文" title="朗读原文"><svg class="ic"><use href="#i-volume"/></svg></button>
            <button class="tool" id="btnCamera" type="button" aria-label="拍照识别" title="拍照识别"><svg class="ic"><use href="#i-camera"/></svg></button>
            <button class="tool" id="btnClear" type="button" aria-label="清空输入" title="清空"><svg class="ic"><use href="#i-eraser"/></svg></button>
          </div>
        </div>
        <button class="btn-primary" id="translateBtn" type="button">
          <svg class="ic"><use href="#i-sparkle"/></svg><span id="btnText">翻译</span><span class="spinner" id="loader" hidden></span>
        </button>
      </div>
    </section>

    <section class="pane">
      <div class="output is-empty" id="outputText" dir="auto" aria-live="polite"
        data-placeholder="译文会实时显示在这里"></div>
      <div class="hint"><svg class="ic"><use href="#i-sparkle"/></svg><span id="outHint">由大模型逐字译出</span></div>
      <div class="toolbar">
        <div class="toolbar-left"><span class="counter" id="outCount"></span></div>
        <div class="toolset">
          <button class="tool" id="btnSpeakTarget" type="button" aria-label="朗读译文" title="朗读译文"><svg class="ic"><use href="#i-volume"/></svg></button>
          <button class="tool" id="btnCopy" type="button" aria-label="复制译文" title="复制译文"><svg class="ic"><use href="#i-copy"/></svg></button>
          <button class="tool" id="btnPresent" type="button" aria-label="放大展示译文" title="放大展示（给对方看）"><svg class="ic"><use href="#i-expand"/></svg></button>
        </div>
        <button class="btn-ghost" id="btnShare" type="button" title="分享译文"><svg class="ic"><use href="#i-share"/></svg>分享</button>
      </div>
    </section>
  </main>
</div>

<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<div class="scrim" id="scrim"></div>

<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="历史记录" inert>
  <div class="drawer-head">
    <h2>历史记录</h2><span class="count" id="histCount"></span>
    <button class="icon-btn" id="btnCloseHistory" type="button" aria-label="关闭历史记录" style="margin-inline-start:auto"><svg class="ic"><use href="#i-close"/></svg></button>
  </div>
  <div class="search">
    <svg class="ic"><use href="#i-search"/></svg>
    <label class="sr" for="histSearch">搜索历史</label>
    <input id="histSearch" type="search" placeholder="搜索原文或译文" autocomplete="off">
  </div>
  <div class="list" id="histList"></div>
  <div class="drawer-foot">
    <button class="btn-ghost" id="btnExportHistory" type="button"><svg class="ic"><use href="#i-download"/></svg>导出</button>
    <button class="btn-ghost" id="btnClearHistory" type="button"><svg class="ic"><use href="#i-trash"/></svg>清空全部</button>
  </div>
</aside>

<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <div class="box">
    <h3 id="modalTitle">服务状态</h3>
    <p class="sub" id="modalSub">来自 /api/health，用于确认环境变量是否配置成功。</p>
    <div id="modalBody"></div>
    <div class="box-actions" id="modalActions"></div>
  </div>
</div>

<div class="camera" id="camera" role="dialog" aria-modal="true" aria-label="拍照识别">
  <div class="cam-view">
    <video id="cameraVideo" autoplay playsinline muted></video>
    <div class="guides"><div class="scan"></div></div>
    <div class="ocr" id="ocrStatus" hidden><span id="ocrMsg">准备中</span><span class="bar"><span id="ocrBar"></span></span><span id="ocrPct">0%</span></div>
    <div class="flash" id="camFlash"></div>
  </div>
  <div class="cam-bar">
    <button class="cam-btn" id="btnCloseCamera" type="button" aria-label="关闭相机"><svg class="ic"><use href="#i-close"/></svg></button>
    <button class="shutter" id="btnCapture" type="button" aria-label="拍照并识别"><span></span></button>
    <button class="cam-btn" id="btnGallery" type="button" aria-label="从相册选择图片"><svg class="ic"><use href="#i-image"/></svg></button>
  </div>
</div>
<input type="file" id="fileInput" accept="image/*" class="sr">

<div class="present" id="present" role="dialog" aria-modal="true" aria-label="译文展示">
  <div class="present-lang" id="presentLang">译文</div>
  <div class="present-text" id="presentText" dir="auto"></div>
  <div class="present-bar">
    <button class="btn-ghost" id="btnPresentSpeak" type="button"><svg class="ic"><use href="#i-volume"/></svg>朗读</button>
    <button class="btn-ghost" id="btnPresentSize" type="button"><svg class="ic"><use href="#i-type"/></svg>字号</button>
    <button class="btn-primary" id="btnPresentExit" type="button"><svg class="ic"><use href="#i-close"/></svg>退出展示</button>
  </div>
</div>

</body>
</html>`;

/* ------------------------------------------------------------------ */
/* 客户端逻辑                                                          */
/* ------------------------------------------------------------------ */

const APP_JS = String.raw`
(function () {
  'use strict';

  var BOOT = JSON.parse(document.getElementById('boot-data').textContent);
  var LANGS = {};
  BOOT.langs.forEach(function (l) { LANGS[l.key] = l; });
  var RTL = { arabic: true, hindi: true };
  var MAX = BOOT.maxChars;
  var TTS_MAX = BOOT.ttsMaxChars;
  var HKEY = 'ai-trans:history';
  var PREF_KEY = 'ai-trans:prefs';

  function $(id) { return document.getElementById(id); }
  var el = {
    src: $('inputText'), out: $('outputText'), source: $('sourceLang'), target: $('targetLang'),
    loader: $('loader'), btnText: $('btnText'), go: $('translateBtn'), count: $('charCount'),
    outCount: $('outCount'), auto: $('autoTranslate'), netPill: $('netPill'),
    modelPill: $('modelPill'), modelName: $('modelName'), srcHint: $('srcHint'), outHint: $('outHint'),
    scrim: $('scrim'), drawer: $('drawer'), histList: $('histList'), histSearch: $('histSearch'),
    histCount: $('histCount'), modal: $('modal'), modalBody: $('modalBody'), modalActions: $('modalActions'),
    modalTitle: $('modalTitle'), modalSub: $('modalSub'), toasts: $('toasts'),
    camera: $('camera'), video: $('cameraVideo'), ocr: $('ocrStatus'), ocrMsg: $('ocrMsg'),
    ocrBar: $('ocrBar'), ocrPct: $('ocrPct'), capture: $('btnCapture'), flash: $('camFlash'), file: $('fileInput'),
    present: $('present'), presentText: $('presentText'), presentLang: $('presentLang')
  };

  var prefs = loadPrefs();
  var busy = false, seq = 0, controller = null, debounceTimer = null;
  var lastTranslated = null, speaking = null, audioEl = null, mediaStream = null;
  var lastFocus = null, health = null, quotaLeft = null, retryAt = 0;
  var tessLoading = null;

  /* ---------- 偏好存储 ---------- */

  function loadPrefs() {
    var p = { theme: null, auto: true, source: 'auto', target: 'chinese', presentSize: 34 };
    try {
      var raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (raw && typeof raw === 'object') Object.keys(p).forEach(function (k) {
        if (raw[k] !== undefined && raw[k] !== null) p[k] = raw[k];
      });
    } catch (e) {}
    try { if (localStorage.getItem('trans_auto') === '0') p.auto = false; } catch (e) {}
    return p;
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  /* ---------- 主题 ---------- */

  var mql = window.matchMedia('(prefers-color-scheme: dark)');
  function isDark() { return document.documentElement.dataset.theme === 'dark'; }
  function paintTheme() {
    var dark = isDark();
    $('themeIcon').innerHTML = '<use href="#' + (dark ? 'i-sun' : 'i-moon') + '"/>';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#141a28' : '#ffffff');
  }
  function toggleTheme() {
    prefs.theme = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = prefs.theme;
    savePrefs(); paintTheme();
  }
  paintTheme();
  if (mql.addEventListener) {
    mql.addEventListener('change', function () {
      if (prefs.theme) return;
      document.documentElement.dataset.theme = mql.matches ? 'dark' : 'light';
      paintTheme();
    });
  }

  /* ---------- 提示条 ---------- */

  var TOAST_ICON = { ok: 'i-check', err: 'i-alert', warn: 'i-info' };
  function toast(msg, kind, action) {
    var node = document.createElement('div');
    node.className = 'toast toast--' + (kind || 'ok');
    var ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ic.setAttribute('class', 'ic');
    ic.innerHTML = '<use href="#' + (TOAST_ICON[kind] || 'i-check') + '"/>';
    var span = document.createElement('span');
    span.textContent = String(msg);
    node.appendChild(ic); node.appendChild(span);
    if (action) {
      var a = document.createElement('button');
      a.type = 'button'; a.className = 't-act'; a.textContent = action.label;
      a.addEventListener('click', function () { node.remove(); action.run(); });
      node.appendChild(a);
    }
    el.toasts.appendChild(node);
    if (el.toasts.children.length > 3) el.toasts.firstChild.remove();
    requestAnimationFrame(function () { node.classList.add('is-show'); });
    setTimeout(function () {
      node.classList.remove('is-show');
      setTimeout(function () { node.remove(); }, 260);
    }, action ? 6000 : 3000);
    return node;
  }

  /* ---------- 语种 ---------- */

  function fillSelect(node, keys) {
    node.replaceChildren();
    keys.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = k === 'auto' ? '自动检测' : LANGS[k].zh;
      node.appendChild(o);
    });
  }
  fillSelect(el.source, ['auto'].concat(Object.keys(LANGS)));
  fillSelect(el.target, Object.keys(LANGS));
  el.source.value = prefs.source && (prefs.source === 'auto' || LANGS[prefs.source]) ? prefs.source : 'auto';
  el.target.value = LANGS[prefs.target] ? prefs.target : 'chinese';

  function charLen(s) { return Array.from(String(s)).length; }
  function targetIsRtl() { return !!RTL[el.target.value]; }
  function applyTargetDir() {
    el.out.setAttribute('dir', targetIsRtl() ? 'rtl' : 'auto');
    var meta = LANGS[el.target.value];
    if (meta) el.out.setAttribute('lang', meta.tts);
  }

  /* ---------- 状态显示 ---------- */

  function setOutput(text) {
    el.out.textContent = text || '';
    el.out.classList.toggle('is-empty', !text);
    el.outCount.textContent = text ? charLen(text) + ' 字' : '';
  }
  function refresh() {
    var n = charLen(el.src.value);
    var over = n > MAX;
    el.go.disabled = busy || over;
    el.btnText.textContent = busy ? '翻译中' : '翻译';
    el.loader.hidden = !busy;
    el.count.textContent = n + ' / ' + MAX;
    el.count.classList.toggle('is-over', over);
  }
  function setBusy(v) { busy = v; refresh(); }

  /* ---------- 翻译 ---------- */

  function clearDebounce() { if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; } }
  function schedule() {
    clearDebounce();
    if (!prefs.auto || !el.src.value.trim()) return;
    if (Date.now() < retryAt) return;
    debounceTimer = setTimeout(translate, BOOT.debounceMs);
  }

  function readError(res) {
    return res.json().then(function (d) {
      return (d && d.error) || ('请求失败（HTTP ' + res.status + '）');
    }, function () {
      return '服务端返回了非 JSON 内容（HTTP ' + res.status + '）';
    });
  }

  function parseSse(buffer, onPiece) {
    var lines = buffer.split('\n');
    var rest = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      var obj;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      if (obj.error) throw new Error(String(obj.error.message || obj.error));
      if (obj.meta) { onMeta(obj.meta); continue; }
      var piece = typeof obj.response === 'string' ? obj.response : null;
      if (piece === null && obj.choices && obj.choices[0]) {
        var c = obj.choices[0];
        if (c.delta && typeof c.delta.content === 'string') piece = c.delta.content;
        else if (c.message && typeof c.message.content === 'string') piece = c.message.content;
      }
      if (piece !== null) onPiece(piece);
    }
    return rest;
  }

  function onMeta(meta) {
    if (meta && meta.model) {
      el.modelPill.hidden = false;
      el.modelName.textContent = String(meta.model).slice(0, 28);
    }
  }

  function noteQuota(res) {
    var left = res.headers.get('RateLimit-Remaining');
    if (left !== null) {
      quotaLeft = parseInt(left, 10);
      if (!isNaN(quotaLeft) && quotaLeft <= 2) {
        el.srcHint.textContent = '本分钟剩余 ' + quotaLeft + ' 次，稍慢一点';
      }
    }
  }

  function describeFailure(err) {
    var msg = String((err && err.message) || '网络异常');
    if (/failed to fetch|load failed|networkerror/i.test(msg)) {
      if (location.protocol === 'file:') return '请通过 Worker 地址访问，不能直接双击打开 HTML';
      if (!navigator.onLine) return '当前处于离线状态';
      return '无法连接后端服务（请确认 Worker 正在运行）';
    }
    return msg;
  }

  function postTranslate(stream, signal) {
    return fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal,
      body: JSON.stringify({
        text: el.src.value.trim(),
        source_lang: el.source.value,
        target_lang: el.target.value,
        stream: stream
      })
    });
  }

  function translate() {
    clearDebounce();
    var text = el.src.value.trim();
    var mySeq = ++seq;
    if (!text) { setOutput(''); lastTranslated = null; return Promise.resolve(); }
    if (charLen(text) > MAX) { toast('文本过长，最多 ' + MAX + ' 个字符', 'err'); return Promise.resolve(); }
    if (text === lastTranslated && el.out.textContent) return Promise.resolve();

    if (controller) controller.abort();
    controller = new AbortController();
    var signal = controller.signal;
    var acc = '', started = false, t0 = Date.now();

    function stopCaret() { el.out.classList.remove('is-streaming'); }
    function done(finalText) {
      if (mySeq !== seq) return;
      stopCaret();
      if (!finalText) { setOutput(''); el.outHint.textContent = '模型没有返回内容，请重试'; return; }
      setOutput(finalText);
      lastTranslated = text;
      var secs = ((Date.now() - t0) / 1000).toFixed(2);
      el.outHint.textContent = (el.modelName.textContent || '模型') + ' 译出 · ' + secs + ' 秒';
      addHistory(text, finalText, el.source.value, el.target.value);
    }

    setBusy(true);
    applyTargetDir();
    el.outHint.textContent = '正在连接模型…';

    return postTranslate(true, signal).then(function (res) {
      noteQuota(res);
      var type = res.headers.get('content-type') || '';
      if (res.status === 429) {
        var secs = parseInt(res.headers.get('Retry-After') || '60', 10) || 60;
        retryAt = Date.now() + secs * 1000;
        if (mySeq !== seq) return;
        stopCaret(); setBusy(false);
        el.outHint.textContent = '已暂停自动翻译';
        toast('请求过于频繁，' + secs + ' 秒后可重试', 'warn');
        return;
      }
      if (!res.ok || type.indexOf('text/event-stream') === -1) {
        return readError(res).then(function (msg) {
          if (mySeq !== seq) return;
          stopCaret(); setOutput(''); el.outHint.textContent = '翻译失败';
          toast(msg, 'err', { label: '重试', run: function () { translate(); } });
        });
      }
      if (!res.body || !res.body.getReader) {
        return res.text().then(function (raw) {
          parseSse(raw.replace(/\r/g, '') + '\n', function (p) { acc += p; });
          done(acc.trim());
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            var tail = dec.decode();
            if (tail) buffer += tail;
            if (buffer.trim()) parseSse(buffer + '\n', push);
            return;
          }
          buffer += dec.decode(chunk.value, { stream: true });
          buffer = parseSse(buffer, push);
          return pump();
        });
      }
      function push(piece) {
        acc += piece;
        if (mySeq !== seq) return;
        if (!started) { started = true; el.out.classList.add('is-streaming'); el.outHint.textContent = '正在输出…'; }
        setOutput(acc);
      }
      return pump().then(function () { done(acc.trim()); });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      if (mySeq !== seq) return;
      stopCaret();
      if (acc.trim()) { done(acc.trim()); return; }
      var msg0 = String((err && err.message) || '');
      var transport = /failed to fetch|load failed|networkerror|stream/i.test(msg0);
      if (!transport) {
        setOutput(''); el.outHint.textContent = '翻译失败';
        toast(describeFailure(err), 'err', { label: '重试', run: function () { translate(); } });
        return;
      }
      // 流式通道在首包前就断掉：整段回退一次非流式请求
      return postTranslate(false, signal).then(function (res) {
        noteQuota(res);
        if (res.status === 429) {
          var secs = parseInt(res.headers.get('Retry-After') || '60', 10) || 60;
          retryAt = Date.now() + secs * 1000;
          throw new Error('请求过于频繁，' + secs + ' 秒后可重试');
        }
        if (!res.ok) return readError(res).then(function (m) { throw new Error(m); });
        return res.json();
      }).then(function (data) {
        if (mySeq !== seq) return;
        onMeta({ model: data.model });
        done(((data && data.translated_text) || '').trim());
      }).catch(function (err2) {
        if (err2 && err2.name === 'AbortError') return;
        if (mySeq !== seq) return;
        stopCaret(); setOutput(''); el.outHint.textContent = '翻译失败';
        var m = describeFailure(err2);
        if (/频繁/.test(m)) { el.outHint.textContent = '已暂停自动翻译'; return toast(m, 'warn'); }
        toast(m, 'err', { label: '重试', run: function () { translate(); } });
      });
    }).then(function () {
      if (mySeq !== seq) return;
      setBusy(false);
    }, function () {
      if (mySeq === seq) setBusy(false);
    });
  }

  /* ---------- 历史 ---------- */

  function readHistory() {
    try {
      var list = JSON.parse(localStorage.getItem(HKEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function writeHistory(list) {
    try { localStorage.setItem(HKEY, JSON.stringify(list.slice(0, BOOT.historyLimit))); } catch (e) {}
  }
  function addHistory(src, dst, sl, tl) {
    try {
      var list = readHistory();
      if (list.length && list[0].src === src && list[0].dst === dst) return;
      list.unshift({ src: src, dst: dst, sl: sl, tl: tl, ts: Date.now() });
      writeHistory(list);
      renderHistory();
    } catch (e) {}
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function dayLabel(ts) {
    if (!ts) return '更早';
    var d = new Date(ts), now = new Date();
    var hm = d.toTimeString().slice(0, 5);
    if (sameDay(d, now)) return '今天 ' + hm;
    if (sameDay(d, new Date(now.getTime() - 86400000))) return '昨天 ' + hm;
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function dayGroup(ts) {
    if (!ts) return '更早';
    var d = new Date(ts), now = new Date();
    if (sameDay(d, now)) return '今天';
    if (sameDay(d, new Date(now.getTime() - 86400000))) return '昨天';
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function svgIcon(name) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ic');
    s.innerHTML = '<use href="#' + name + '"/>';
    return s;
  }
  function renderHistory() {
    var all = readHistory();
    var q = el.histSearch.value.trim().toLowerCase();
    var list = q ? all.filter(function (h) {
      return String(h.src).toLowerCase().indexOf(q) > -1 || String(h.dst).toLowerCase().indexOf(q) > -1;
    }) : all;
    el.histCount.textContent = all.length ? all.length + ' 条' : '';
    el.histList.replaceChildren();

    if (!list.length) {
      var box = document.createElement('div');
      box.className = 'empty';
      box.appendChild(svgIcon(q ? 'i-search' : 'i-history'));
      box.appendChild(document.createTextNode(q ? '没有匹配的记录' : '还没有翻译记录，译文会自动存在这里'));
      el.histList.appendChild(box);
      return;
    }
    var lastDay = '';
    list.forEach(function (item) {
      var day = dayGroup(item.ts);
      if (day !== lastDay) {
        lastDay = day;
        var h = document.createElement('div');
        h.className = 'day'; h.textContent = day;
        el.histList.appendChild(h);
      }
      var row = document.createElement('div');
      row.className = 'item'; row.tabIndex = 0; row.setAttribute('role', 'button');

      var s = document.createElement('div'); s.className = 'item-src'; s.textContent = String(item.src || '');
      var d = document.createElement('div'); d.className = 'item-dst'; d.textContent = String(item.dst || '');
      var m = document.createElement('div'); m.className = 'item-meta';
      [item.sl === 'auto' ? '自动' : (LANGS[item.sl] ? LANGS[item.sl].zh : '?'),
       '→',
       LANGS[item.tl] ? LANGS[item.tl].zh : '?',
       dayLabel(item.ts)].forEach(function (p, i) {
        var c = document.createElement('span');
        if (i !== 1) c.className = 'chip';
        c.textContent = p; m.appendChild(c);
      });
      var acts = document.createElement('div'); acts.className = 'item-acts';
      [['i-copy', '复制译文', function (ev) { ev.stopPropagation(); copyText(item.dst, '已复制'); }],
       ['i-volume', '朗读译文', function (ev) { ev.stopPropagation(); speak(item.dst, item.tl, ev.currentTarget); }],
       ['i-trash', '删除这条记录', function (ev) {
          ev.stopPropagation();
          var cur = readHistory();
          var real = cur.findIndex(function (x) { return x.ts === item.ts && x.src === item.src; });
          if (real > -1) { cur.splice(real, 1); writeHistory(cur); renderHistory(); }
        }]]
        .forEach(function (a) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'mini' + (a[0] === 'i-trash' ? ' mini--danger' : '');
          b.setAttribute('aria-label', a[1]); b.title = a[1];
          b.appendChild(svgIcon(a[0]));
          b.addEventListener('click', a[2]);
          acts.appendChild(b);
        });
      row.addEventListener('click', function () { restore(item); });
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); restore(item); }
      });
      row.appendChild(s); row.appendChild(d); row.appendChild(m); row.appendChild(acts);
      el.histList.appendChild(row);
    });
  }
  function restore(item) {
    el.src.value = String(item.src || '');
    if (item.sl === 'auto' || LANGS[item.sl]) el.source.value = item.sl;
    if (LANGS[item.tl]) el.target.value = item.tl;
    prefs.source = el.source.value; prefs.target = el.target.value; savePrefs();
    applyTargetDir();
    setOutput(String(item.dst || ''));
    lastTranslated = el.src.value.trim();
    el.outHint.textContent = '来自历史记录';
    autosize(); refresh(); closeDrawer();
  }
  function exportHistory() {
    var list = readHistory();
    if (!list.length) { toast('还没有历史记录', 'warn'); return; }
    var blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ai-translate-history-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('已导出 ' + list.length + ' 条记录');
  }
  function clearHistory() {
    if (!readHistory().length) { toast('还没有历史记录', 'warn'); return; }
    showModal({
      title: '清空历史记录',
      sub: '将删除本机保存的全部 ' + readHistory().length + ' 条翻译记录，无法恢复。',
      rows: [],
      actions: [{ label: '取消', primary: false }, { label: '确认清空', danger: true, run: function () {
        try { localStorage.removeItem(HKEY); } catch (e) {}
        renderHistory(); toast('历史记录已清空');
      } }]
    });
  }

  /* ---------- 抽屉 / 弹窗 ---------- */

  function openDrawer() {
    renderHistory();
    lastFocus = document.activeElement;
    if ('inert' in HTMLElement.prototype) el.drawer.inert = false;
    el.drawer.classList.add('is-open');
    el.scrim.classList.add('is-open');
    el.histSearch.focus();
  }
  function closeDrawer() {
    el.drawer.classList.remove('is-open');
    if ('inert' in HTMLElement.prototype) el.drawer.inert = true;
    if (!el.modal.classList.contains('is-open')) el.scrim.classList.remove('is-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }
  function drawerOpen() { return el.drawer.classList.contains('is-open'); }

  function showModal(cfg) {
    el.modalTitle.textContent = cfg.title;
    el.modalSub.textContent = cfg.sub || '';
    el.modalBody.replaceChildren();
    if (cfg.rows && cfg.rows.length) {
      var dl = document.createElement('dl');
      dl.style.cssText = 'margin:0';
      cfg.rows.forEach(function (r) {
        var row = document.createElement('div'); row.className = 'kv';
        var dt = document.createElement('dt');
        if (r.ok === true || r.ok === false) {
          var dot = document.createElement('span');
          dot.className = 'dot dot--' + (r.ok ? 'ok' : 'bad');
          dt.appendChild(dot);
        }
        dt.appendChild(document.createTextNode(r.k));
        var dd = document.createElement('dd'); dd.textContent = String(r.v);
        row.appendChild(dt); row.appendChild(dd); dl.appendChild(row);
      });
      el.modalBody.appendChild(dl);
    }
    el.modalActions.replaceChildren();
    (cfg.actions || [{ label: '好' }]).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = a.primary === false || a.danger ? 'btn-ghost' : 'btn-primary';
      if (a.danger) { b.style.color = 'var(--danger)'; b.style.borderColor = 'var(--danger)'; }
      b.textContent = a.label;
      b.addEventListener('click', function () { closeModal(); if (a.run) a.run(); });
      el.modalActions.appendChild(b);
    });
    lastFocus = document.activeElement;
    el.modal.classList.add('is-open');
    el.scrim.classList.add('is-open');
    var first = el.modalActions.lastChild;
    if (first) first.focus();
  }
  function closeModal() {
    el.modal.classList.remove('is-open');
    if (!drawerOpen()) el.scrim.classList.remove('is-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------- 服务状态 ---------- */

  function loadHealth() {
    return fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
      health = d;
      if (d.translate_env && d.translate_env.configured) {
        el.modelPill.hidden = false;
        el.modelName.textContent = String(d.translate_env.model || '').slice(0, 28);
      }
      return d;
    }).catch(function () { return null; });
  }
  function showSettings() {
    function render(d) {
      if (!d) {
        showModal({ title: '无法读取服务状态', sub: '后端未响应，请确认 Worker 正在运行或网络正常。', rows: [], actions: [{ label: '好' }] });
        return;
      }
      var e = d.translate_env || {};
      var rows = [
        { k: 'API_URL', v: e.api_url_host || (e.api_url_set ? '地址格式不正确' : '未配置'), ok: !!e.api_url_valid },
        { k: 'API_KEY', v: e.api_key_set ? '已配置' : '未配置', ok: !!e.api_key_set },
        { k: '主模型', v: e.model || '未配置', ok: !!e.model },
        { k: '备选模型', v: (e.fallback_models || []).length ? e.fallback_models.join('、') : '无' },
        { k: '语音合成', v: d.tts_ai_bound ? 'Workers AI 已绑定' : '未绑定，朗读不可用', ok: !!d.tts_ai_bound },
        { k: '输入上限', v: d.max_input_chars + ' 字符' },
        { k: '限流', v: d.rate_limit.max_requests + ' 次 / ' + (d.rate_limit.window_ms / 1000) + ' 秒' },
        { k: '版本', v: d.version || BOOT.version }
      ];
      showModal({
        title: '服务状态',
        sub: '环境变量在 Cloudflare 控制台 Settings → Variables and Secrets 中配置，改完需重新部署才生效。',
        rows: rows,
        actions: [
          { label: '快捷键', primary: false, run: showShortcuts },
          { label: '重新检测', primary: false, run: function () { loadHealth().then(render); toast('已重新检测'); } },
          { label: '好' }
        ]
      });
    }
    render(health);
  }
  function showShortcuts() {
    showModal({
      title: '快捷键',
      sub: '桌面端可用；移动端建议添加到主屏后使用。',
      rows: [
        { k: '立即翻译', v: '⌘/Ctrl + Enter' },
        { k: '聚焦输入框', v: '⌘/Ctrl + K' },
        { k: '复制译文', v: '⌘/Ctrl + Shift + C' },
        { k: '关闭弹层', v: 'Esc' }
      ],
      actions: [{ label: '返回', primary: false, run: showSettings }, { label: '好' }]
    });
  }

  /* ---------- 朗读 ---------- */

  function detectTts(text) {
    var sample = String(text).slice(0, 400), f = {};
    for (var i = 0; i < sample.length; i++) {
      var c = sample.codePointAt(i);
      if (c >= 0x3040 && c <= 0x30ff) f.ja = 1;
      else if (c >= 0xac00 && c <= 0xd7af) f.ko = 1;
      else if (c >= 0x0400 && c <= 0x04ff) f.ru = 1;
      else if (c >= 0x0600 && c <= 0x06ff) f.ar = 1;
      else if (c >= 0x0900 && c <= 0x097f) f.hi = 1;
      else if (c >= 0x0e00 && c <= 0x0e7f) f.th = 1;
      else if (c >= 0x4e00 && c <= 0x9fff) f.zh = 1;
    }
    var k = f.ja ? 'japanese' : f.ko ? 'korean' : f.ru ? 'russian' : f.ar ? 'arabic'
      : f.hi ? 'hindi' : f.th ? 'thai' : f.zh ? 'chinese' : 'english';
    return LANGS[k].tts;
  }
  function ttsLocale(key) {
    if (!key || key === 'auto') return null;
    return LANGS[key] ? LANGS[key].tts : null;
  }
  function stopSpeak() {
    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
      try { if (audioEl.src) URL.revokeObjectURL(audioEl.src); } catch (e) {}
      audioEl = null;
    }
    if (speaking) { speaking.classList.remove('is-on'); speaking = null; }
  }
  function speak(text, langKey, btn) {
    if (!text) { toast('没有可朗读的内容', 'warn'); return; }
    if (speaking === btn) { stopSpeak(); return; }
    stopSpeak();
    if (charLen(text) > TTS_MAX) { toast('文本较长，仅朗读前 ' + TTS_MAX + ' 个字符', 'warn'); text = Array.from(text).slice(0, TTS_MAX).join(''); }
    var lang = ttsLocale(langKey) || detectTts(text);
    speaking = btn; if (btn) btn.classList.add('is-on');
    fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, lang: lang })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (d) {
          var m = (d && d.error) || ('请求失败（HTTP ' + res.status + '）');
          if (d && d.detail && d.detail.message) m += '（' + d.detail.message + '）';
          throw new Error(m);
        }, function () { throw new Error('请求失败（HTTP ' + res.status + '）'); });
      }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('audio/') !== 0) throw new Error('服务端返回了非音频内容');
      return res.blob();
    }).then(function (blob) {
      if (!blob || blob.size < 64) { stopSpeak(); toast('音频数据异常，请重试', 'err'); return; }
      audioEl = new Audio(URL.createObjectURL(blob));
      audioEl.onended = stopSpeak;
      audioEl.onerror = function () { stopSpeak(); toast('播放失败，请重试', 'err'); };
      var p = audioEl.play();
      if (p && p.catch) p.catch(function () { stopSpeak(); toast('浏览器阻止了自动播放，请再点一次', 'warn'); });
    }).catch(function (err) {
      stopSpeak();
      toast('朗读失败：' + ((err && err.message) || '请稍后重试'), 'err');
    });
  }

  /* ---------- 复制 / 分享 ---------- */

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  function copyText(text, okMsg) {
    if (!text) { toast('还没有内容', 'warn'); return; }
    var ok = function () { toast(okMsg || '已复制'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok, function () {
        try { legacyCopy(text); ok(); } catch (e) { toast('复制失败，请长按选择文本', 'err'); }
      });
      return;
    }
    try { legacyCopy(text); ok(); } catch (e) { toast('复制失败，请长按选择文本', 'err'); }
  }
  function share() {
    var text = el.out.textContent.trim();
    if (!text) { toast('还没有译文', 'warn'); return; }
    if (navigator.share) {
      navigator.share({ text: text, title: 'AI 随身翻译' }).catch(function (err) {
        if (err && err.name !== 'AbortError') copyText(text, '分享不可用，已复制译文');
      });
      return;
    }
    copyText(text, '系统不支持分享，已复制译文');
  }

  /* ---------- 输入 ---------- */

  function autosize() {
    el.src.style.height = 'auto';
    el.src.style.height = Math.min(Math.max(el.src.scrollHeight, 96), 320) + 'px';
  }
  function clearAll() {
    clearDebounce();
    if (controller) controller.abort();
    seq++; busy = false;
    el.src.value = ''; setOutput('');
    el.out.classList.remove('is-streaming');
    el.outHint.textContent = '由大模型逐字译出';
    lastTranslated = null;
    autosize(); refresh(); el.src.focus();
  }
  function swap() {
    var out = el.out.textContent.trim();
    var s = el.source.value, t = el.target.value;
    var newSource = t;
    var newTarget = s === 'auto' ? (t === 'english' ? 'chinese' : 'english') : s;
    el.source.value = newSource;
    el.target.value = newTarget;
    prefs.source = newSource; prefs.target = newTarget; savePrefs();
    var btn = $('btnSwap');
    btn.classList.add('is-flipped');
    setTimeout(function () { btn.classList.remove('is-flipped'); }, 320);
    if (out) { el.src.value = out; setOutput(''); autosize(); refresh(); translate(); }
    else { applyTargetDir(); refresh(); }
  }

  /* ---------- 展示模式 ---------- */

  var SIZES = [26, 34, 44, 56];
  function openPresent() {
    var text = el.out.textContent.trim();
    if (!text) { toast('还没有译文', 'warn'); return; }
    el.presentText.textContent = text;
    el.presentText.setAttribute('dir', el.out.getAttribute('dir') || 'auto');
    el.presentLang.textContent = (LANGS[el.target.value] ? LANGS[el.target.value].zh : '译文') + ' · 给对方看';
    applySize();
    el.present.classList.add('is-open');
    $('btnPresentExit').focus();
  }
  function closePresent() { el.present.classList.remove('is-open'); $('btnPresent').focus(); }
  function applySize() { el.present.style.setProperty('--present-size', prefs.presentSize + 'px'); }
  function cycleSize() {
    var i = SIZES.indexOf(prefs.presentSize);
    prefs.presentSize = SIZES[(i + 1 + SIZES.length) % SIZES.length];
    savePrefs(); applySize();
  }

  /* ---------- OCR ---------- */

  var TESS_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tessLoading) return tessLoading;
    tessLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESS_CDN; s.async = true;
      s.onload = function () { window.Tesseract ? resolve(window.Tesseract) : reject(new Error('识别库加载异常')); };
      s.onerror = function () { tessLoading = null; reject(new Error('识别库加载失败，请检查网络')); };
      document.head.appendChild(s);
    });
    return tessLoading;
  }
  var CAMERA_ERRORS = {
    NotAllowedError: '摄像头权限被拒绝，请在浏览器设置中允许后重试',
    NotFoundError: '没有找到可用的摄像头',
    NotReadableError: '摄像头被其他程序占用，请关闭后重试',
    OverconstrainedError: '摄像头不支持所需的分辨率',
    SecurityError: '需要 HTTPS 环境才能使用摄像头'
  };
  function openCamera() {
    if (cameraOpen()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      pickFile(); toast('当前环境不支持摄像头，可直接选择图片', 'warn'); return;
    }
    // 授权弹窗可能停留几秒，期间按钮保持高亮，否则用户以为没点到
    var btn = $('btnCamera');
    btn.classList.add('is-on');
    var done = function () { btn.classList.remove('is-on'); };
    navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }
    }).then(function (s) {
      done();
      mediaStream = s;
      el.video.srcObject = s;
      el.camera.classList.add('is-open');
      return loadTesseract().catch(function (err) {
        toast((err && err.message) || '识别库加载失败', 'warn');
      });
    }).catch(function (err) {
      done();
      toast(CAMERA_ERRORS[err && err.name] || '无法打开摄像头', 'err');
    });
  }
  function closeCamera() {
    el.camera.classList.remove('is-open');
    el.ocr.hidden = true;
    if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
  }
  function cameraOpen() { return el.camera.classList.contains('is-open'); }
  function pickFile() { el.file.click(); }

  function recognize(source) {
    if (!window.Tesseract) {
      toast('识别库还在加载，请稍候再试', 'warn');
      loadTesseract().catch(function (err) { toast((err && err.message) || '识别库加载失败', 'err'); });
      return;
    }
    el.capture.disabled = true;
    var key = el.source.value;
    var base = key === 'auto' ? 'eng+chi_sim' : (LANGS[key] ? LANGS[key].ocr : 'eng');
    var ocrLang = base.indexOf('eng') > -1 ? base : base + '+eng';

    el.ocr.hidden = false;
    el.ocrMsg.textContent = '正在准备识别引擎';
    el.ocrBar.style.width = '4%'; el.ocrPct.textContent = '4%';

    window.Tesseract.recognize(source, ocrLang, {
      logger: function (m) {
        if (!m) return;
        if (m.status === 'loading tesseract core') el.ocrMsg.textContent = '加载识别引擎';
        else if (m.status === 'initializing tesseract') el.ocrMsg.textContent = '初始化引擎';
        else if (m.status === 'loading language traineddata') el.ocrMsg.textContent = '下载语言包（首次较慢）';
        else if (m.status === 'initializing api') el.ocrMsg.textContent = '准备识别';
        else if (m.status === 'recognizing text') {
          var p = Math.round((m.progress || 0) * 100);
          el.ocrMsg.textContent = '正在识别文字';
          el.ocrBar.style.width = p + '%'; el.ocrPct.textContent = p + '%';
        }
      }
    }).then(function (result) {
      var text = ((result && result.data && result.data.text) || '').replace(/\n{3,}/g, '\n\n').trim();
      closeCamera();
      if (!text) { toast('没有识别到文字，换个角度或靠近一点再试', 'warn'); return; }
      el.src.value = text; autosize(); refresh();
      if (prefs.auto) translate(); else toast('识别完成，点「翻译」查看译文');
    }).catch(function (err) {
      toast('文字识别失败：' + ((err && err.message) || '请重试'), 'err');
    }).then(function () {
      el.capture.disabled = false;
      el.ocr.hidden = true;
    });
  }

  function capture() {
    if (!el.video.videoWidth) { toast('摄像头还没准备好，请稍等', 'warn'); return; }
    el.flash.classList.remove('is-go');
    void el.flash.offsetWidth;
    el.flash.classList.add('is-go');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    var MAX_W = 1600;
    var scale = Math.min(1, MAX_W / el.video.videoWidth);
    var cv = document.createElement('canvas');
    cv.width = Math.round(el.video.videoWidth * scale);
    cv.height = Math.round(el.video.videoHeight * scale);
    cv.getContext('2d').drawImage(el.video, 0, 0, cv.width, cv.height);
    recognize(cv.toDataURL('image/jpeg', 0.92));
  }

  function onFile(ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast('请选择图片文件', 'warn'); return; }
    if (!cameraOpen()) { el.camera.classList.add('is-open'); }
    loadTesseract().then(function () {
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () {
        var MAX_W = 1600;
        var scale = Math.min(1, MAX_W / img.naturalWidth);
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * scale);
        cv.height = Math.round(img.naturalHeight * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        recognize(cv.toDataURL('image/jpeg', 0.92));
      };
      img.onerror = function () { URL.revokeObjectURL(url); toast('图片读取失败', 'err'); };
      img.src = url;
    }).catch(function (err) { closeCamera(); toast((err && err.message) || '识别库加载失败', 'err'); });
  }

  /* ---------- 网络状态 ---------- */

  function paintNet() {
    el.netPill.hidden = navigator.onLine !== false;
  }
  window.addEventListener('online', function () { paintNet(); toast('网络已恢复'); schedule(); });
  window.addEventListener('offline', function () { paintNet(); toast('网络已断开，暂时无法翻译', 'warn'); });

  /* ---------- 事件 ---------- */

  el.src.addEventListener('input', function () {
    autosize(); refresh();
    if (!el.src.value.trim()) {
      clearDebounce();
      if (controller) controller.abort();
      seq++; busy = false;
      setOutput(''); el.out.classList.remove('is-streaming');
      el.outHint.textContent = '由大模型逐字译出';
      lastTranslated = null;
      refresh(); return;
    }
    schedule();
  });
  el.src.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); translate(); }
  });
  el.auto.addEventListener('change', function () { prefs.auto = el.auto.checked; savePrefs(); if (prefs.auto) schedule(); });
  el.go.addEventListener('click', translate);
  el.source.addEventListener('change', function () { prefs.source = el.source.value; savePrefs(); if (el.src.value.trim()) translate(); });
  el.target.addEventListener('change', function () { prefs.target = el.target.value; savePrefs(); applyTargetDir(); if (el.src.value.trim()) translate(); });
  $('btnSwap').addEventListener('click', swap);
  $('btnSpeakSource').addEventListener('click', function (ev) { speak(el.src.value.trim(), el.source.value, ev.currentTarget); });
  $('btnSpeakTarget').addEventListener('click', function (ev) { speak(el.out.textContent.trim(), el.target.value, ev.currentTarget); });
  $('btnCamera').addEventListener('click', openCamera);
  $('btnClear').addEventListener('click', clearAll);
  $('btnCopy').addEventListener('click', function () { copyText(el.out.textContent.trim(), '已复制译文'); });
  $('btnShare').addEventListener('click', share);
  $('btnPresent').addEventListener('click', openPresent);
  $('btnPresentExit').addEventListener('click', closePresent);
  $('btnPresentSize').addEventListener('click', cycleSize);
  $('btnPresentSpeak').addEventListener('click', function (ev) { speak(el.out.textContent.trim(), el.target.value, null); });
  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnHistory').addEventListener('click', function () { drawerOpen() ? closeDrawer() : openDrawer(); });
  $('btnSettings').addEventListener('click', showSettings);
  $('btnCloseHistory').addEventListener('click', closeDrawer);
  $('btnExportHistory').addEventListener('click', exportHistory);
  $('btnClearHistory').addEventListener('click', clearHistory);
  el.histSearch.addEventListener('input', renderHistory);
  $('btnCloseCamera').addEventListener('click', closeCamera);
  $('btnCapture').addEventListener('click', capture);
  $('btnGallery').addEventListener('click', pickFile);
  el.file.addEventListener('change', onFile);
  el.scrim.addEventListener('click', function () { if (el.modal.classList.contains('is-open')) closeModal(); else closeDrawer(); });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (cameraOpen()) { closeCamera(); return; }
      if (el.present.classList.contains('is-open')) { closePresent(); return; }
      if (el.modal.classList.contains('is-open')) { closeModal(); return; }
      if (drawerOpen()) closeDrawer();
      return;
    }
    var mod = ev.metaKey || ev.ctrlKey;
    if (!mod) return;
    if (ev.key === 'Enter') { ev.preventDefault(); translate(); }
    else if (ev.key.toLowerCase() === 'k' && !ev.shiftKey) { ev.preventDefault(); el.src.focus(); el.src.select(); }
    else if (ev.shiftKey && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copyText(el.out.textContent.trim(), '已复制译文'); }
  });
  window.addEventListener('beforeunload', stopSpeak);

  /* ---------- 初始化 ---------- */

  el.auto.checked = !!prefs.auto;
  applyTargetDir();
  autosize();
  refresh();
  renderHistory();
  paintNet();
  loadHealth();

  // manifest shortcuts：/?action=camera 与 /?action=history
  try {
    var params = new URLSearchParams(location.search);
    var action = params.get('action');
    if (action === 'camera' || action === 'history') {
      params.delete('action');
      var qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
      if (action === 'camera') setTimeout(openCamera, 250); else setTimeout(openDrawer, 120);
    }
  } catch (e) {}

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (reg) {
        if (reg && reg.update) reg.update();
        if (!reg) return;
        reg.addEventListener('updatefound', function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              toast('发现新版本', 'ok', { label: '刷新', run: function () { location.reload(); } });
            }
          });
        });
      }).catch(function () {});
    });
  }
})();
`;
