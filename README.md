# AI 随身翻译

基于 **Cloudflare Workers** 的单文件多语言翻译 PWA。用 `API_URL` / `API_KEY` / `MODEL` 三个环境变量接任意 OpenAI 兼容大模型，流式译文、拍照 OCR、语音朗读、离线外壳全部由一个 Worker 提供，无需数据库、无需构建步骤。

## 功能特性

| 能力 | 说明 |
|---|---|
| 流式翻译 | SSE 逐字输出，译文区带打字光标；流首帧回传实际生效的模型名 |
| 固定双栏 | 输入/输出框尺寸只随视口变化，**不会被内容撑高**；文字超出时在框内上下滚动，流式输出自动贴底，用户往上翻即停止跟随 |
| 多模型容灾 | `MODEL` 用逗号分隔即自动降级；额度类错误换下一个模型，鉴权/模型不存在类错误立即失败并说明原因 |
| 拍照 / 选图 OCR | 点相机图标直接拉起**系统相机**（`input capture`，不走网页取景框），相册选图另有入口；Tesseract.js v5 浏览器端识别，按需加载，结果直接填入翻译 |
| 语音朗读 | Workers AI：MeloTTS 全语种 + Deepgram Aura-2 英文兜底 |
| 历史记录 | 本机保存最近 50 条，支持搜索、按天分组、单条复制/朗读/删除、JSON 导出、清空二次确认 |
| 展示模式 | 大字译文给对方看，四档字号可切换并记忆 |
| 双向排版 | 阿拉伯语 / 印地语自动 `dir=rtl`，混排用 `unicode-bidi` 防串行 |
| 系统分享 | 支持 Web Share API 的移动端可一键分享译文 |
| PWA | 可添加到主屏，离线外壳 + 断网提示，manifest 带「拍照」「历史」两个快捷方式 |
| 深色模式 | 跟随系统 + 手动切换并记忆，切换在首帧前完成，无白闪 |
| 限流反馈 | 30 次/分钟，`RateLimit-*` 与 `Retry-After` 透传到前端，超额自动暂停自动翻译并倒计时 |

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Cloudflare Workers（模块化 Worker，单文件 `worker.js`）|
| 翻译模型 | 环境变量配置，任意 OpenAI Chat Completions 兼容接口 |
| TTS | Workers AI `@cf/myshell-ai/melotts` + `@cf/deepgram/aura-2-en` |
| 前端 | 原生 JS + CSS 设计令牌，**零依赖、零构建**；图标为内联 SVG sprite，字体走系统栈 |
| OCR | Tesseract.js v5（CDN 按需加载，wasm）|

> 已移除 Tailwind CDN、Remixicon 图标字体与 Google Fonts：三者都会在弱网/离线时阻塞渲染或显示方块，与 PWA 目标冲突。

## 路由

| 路径 | 用途 |
|---|---|
| `GET /` | 应用页面 |
| `GET /styles.css` `/app.js` `/theme.js` | 同源前端资源（`theme.js` 为阻塞式首帧主题脚本）|
| `GET /sw.js` `/manifest.json` `/icon.svg` `/icon-maskable.svg` | PWA 外壳与图标 |
| `POST /api/translate` | 翻译（`stream:true` 走 SSE）|
| `POST /api/tts` | 语音合成，返回音频流 |
| `GET /api/health` | 零成本探活，返回配置状态与语言列表 |

## 环境变量

在 **Cloudflare Dashboard → Workers → 你的 Worker → Settings → Variables and Secrets** 添加：

| 变量名 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `API_URL` | 是 | Plaintext / Secret | 完整地址、`/v1` 或域名根地址均可，程序自动补全 `/chat/completions` |
| `API_KEY` | 是 | **Secret** | 接口密钥 |
| `MODEL` | 是 | Plaintext | 模型名；逗号分隔即多模型容灾，如 `gpt-4o-mini,deepseek-chat` |

重新部署**不会**清除这三个变量：`wrangler.jsonc` 已设 `keep_vars: true`，且未定义任何同名 `vars`。

## 快速开始

```bash
npm install
npm run dev        # wrangler dev，默认 http://localhost:8787（本地变量放 .dev.vars）
npm run deploy     # wrangler deploy --keep-vars
npm run check      # dry-run，验证配置与体积
npm run tail       # 实时线上日志
```

连接 GitHub 时走 Workers Builds，构建命令 `npx wrangler deploy` 同样读取 `keep_vars`。

## API

### `POST /api/translate`

```bash
curl -X POST https://<your-worker>.workers.dev/api/translate \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","source_lang":"auto","target_lang":"chinese","stream":true}'
```

| 字段 | 说明 |
|---|---|
| `text` | 必填，≤ 3000 字符（按码点计，emoji 不算两个）|
| `source_lang` | `auto` 或语言 key，缺省 `auto` |
| `target_lang` | 语言 key，缺省 `chinese` |
| `stream` | `true` 返回 SSE；首帧为 `data: {"meta":{"model":"..."}}` |

语言 key：`chinese` `english` `japanese` `korean` `french` `german` `spanish` `russian` `italian` `portuguese` `arabic` `hindi` `thai` `vietnamese`

非流式响应：`{ "translated_text": "...", "source_lang": "...", "target_lang": "...", "model": "..." }`

### `POST /api/tts`

```bash
curl -X POST https://<your-worker>.workers.dev/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"I like tennis","lang":"en-US"}' --output speech.wav
```

### `GET /api/health`

返回 `version`、`translate_env`（含 `api_url_host`、`api_url_insecure`、`missing`）、`tts_ai_bound`、`languages`、`rate_limit`。只报状态，不回显密钥。

## 安全

- CSP 的 `script-src` **不含 `unsafe-inline`**：客户端脚本全部同源 `/app.js`，注入型 XSS 无法直接执行脚本
- 所有用户内容与历史条目只用 `textContent` 渲染，不拼 HTML
- 请求体按**字节**限 32 KB，文本按**码点**限 3000 字符
- 响应带 `X-Content-Type-Options`、`X-Frame-Options: DENY`、`frame-ancestors 'none'`、HSTS、`Referrer-Policy: no-referrer`
- `API_URL` 用 `http://` 时会在日志打 `insecure_upstream` 告警，并在 `/api/health` 里标 `api_url_insecure`

## 目录结构

```
My-Translate-main/
├── worker.js        # 全部逻辑：路由 + 翻译 + TTS + PWA + 前端资源（单文件）
├── wrangler.jsonc   # Cloudflare 配置（keep_vars: true）
├── package.json     # dev / deploy / check / tail
└── README.md
```


<details>
<summary><b>自动翻译频繁后卡住</b></summary>

限流为 30 次/分钟（按 IP）。触发后前端会暂停自动翻译并显示恢复倒计时，等 `Retry-After` 秒即恢复，不是故障。

</details>
