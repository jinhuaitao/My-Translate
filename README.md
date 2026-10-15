# AI 随身翻译

基于 **Cloudflare Workers + Workers AI** 的单文件多语言翻译 PWA：流式翻译、拍照 OCR 识别、语音朗读、离线外壳，一个 Worker 即全部后端，无需数据库、无需额外资源。

## 功能特性

- **流式翻译**：译文逐字输出（SSE），14 种语言互译，源语言支持自动检测
- **拍照识别**：调用摄像头 + Tesseract.js 离线 OCR，识别结果直接填入并翻译
- **语音朗读**：Workers AI 语音合成（英文 Deepgram Aura-2，其他语言 MeloTTS），服务端生成音频流、前端播放；不再依赖浏览器语音包
- **历史记录**：最近 50 条本地保存（localStorage），点击回填，全程 `textContent` 渲染防 XSS
- **PWA**：可添加到主屏，Service Worker 提供离线外壳，断网有明确提示
- **深色模式**：跟随系统 + 手动切换并记忆
- **移动端适配**：安全区适配、双击缩放禁用、流式光标、触感反馈

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Cloudflare Workers（模块化 Worker，单文件 `worker.js`）|
| 模型 | Workers AI：`@cf/meta/llama-3.3-70b-instruct-fp8-fast`（翻译主模型）+ `@cf/meta/llama-3.1-8b-instruct-fast`（降级备选）|
| TTS | Workers AI：`@cf/myshell-ai/melotts`（全语种统一，含英文）|
| 前端 | Tailwind CDN + Remixicon + 原生 JS（零构建）|
| OCR | Tesseract.js v5（浏览器端，wasm）|

## 快速开始

### 本地开发

```bash
npm install
npm run dev        # wrangler dev，默认 http://localhost:8787
```

### 部署

方式一：本地部署

```bash
npm run deploy     # wrangler deploy
```

方式二：连接 GitHub（Workers Builds）

在 Cloudflare Dashboard 连接本仓库，构建命令执行 `npx wrangler deploy`，会自动读取 `wrangler.jsonc` 完成部署，AI 绑定随配置一起生效，**无需在控制台创建任何资源**。

### 其他脚本

```bash
npm run check      # dry-run 构建，验证配置与语法
npm run tail       # 实时查看线上日志
```

## 配置说明（wrangler.jsonc）

```jsonc
"ai": { "binding": "AI" }        // Workers AI 绑定，按 token 计费，不调用不收费
"vars": { "MODEL": "..." }       // 运行时模型，换模型只改这里，worker.js 不用动
```

**换模型**：修改 `vars.MODEL` 后重新部署即可；降级备选列表在 `worker.js` 顶部的 `FALLBACK_MODELS`，主模型额度/容量不足时自动切换。

**注意**：`name` 必须与 Dashboard 中连接的 Worker 名一致，否则产物会部署到另一个 Worker。

## API

### `POST /api/translate`

```bash
curl -X POST https://<your-worker>.workers.dev/api/translate \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","source_lang":"auto","target_lang":"chinese","stream":true}'
```

| 字段 | 说明 |
|---|---|
| `text` | 待翻译文本，≤ 3000 字符（必填）|
| `source_lang` | `auto` 或语言 key，缺省 `auto` |
| `target_lang` | 语言 key，缺省 `chinese` |
| `stream` | `true` 返回 SSE 流，逐字输出 |

语言 key：`chinese` `english` `japanese` `korean` `french` `german` `spanish` `russian` `italian` `portuguese` `arabic` `hindi` `thai` `vietnamese`

非流式响应：`{ "translated_text": "...", "source_lang": "...", "target_lang": "...", "model": "..." }`

### `POST /api/tts`

```bash
curl -X POST https://<your-worker>.workers.dev/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"I like tennis","lang":"en-US"}' --output speech.mp3
```

| 字段 | 说明 |
|---|---|
| `text` | 待合成文本，≤ 1000 字符（必填）|
| `lang` | BCP-47 标签（`en-US` / `zh-CN` ...），取两位语种码，缺省按英文处理 |

统一走 MeloTTS，返回 `audio/wav`（响应带 `no-store`，音频经读取合并后整体下发，不会出现分段拼接杂音）。英文原用 Deepgram Aura-2，实际合成音频出现拼接异常（读得很乱）已弃用；如需换回见 `worker.js` 顶部注释。

### `GET /api/health`

零成本探活，返回绑定状态、当前模型、限流参数。可用于 uptime 监控。

## 内置防护

- **限流**：每 IP 60 秒 30 次（内存态滑动窗口，第一道闸门）
- **请求体闸门**：超过 32KB 直接 413
- **上下文保护**：按输入长度动态压缩 `max_tokens`，防止撑爆模型上下文
- **隐私**：翻译响应 `no-store`；日志只记元数据，绝不记录用户文本
- **安全响应头**：CSP / HSTS / COOP / X-Frame-Options / Referrer-Policy / noindex
- **同源限定**：API 有意不开放 CORS，仅本页面可调用

## 已知限制

- **朗读为在线合成**：TTS 依赖 Workers AI 模型调用（按字符计费），单次上限 1000 字符，弱网下合成有短暂等待；离线时不可用
- 限流为单 isolate 内存态，多地域部署时是近似值；如需硬限制请接 Durable Objects 或 CF Rate Limiting 规则
- OCR 首次使用需从 CDN 下载语言包（约几 MB），之后走浏览器缓存
- Tailwind 为 Play CDN（零构建的代价）；如需生产级性能可改为构建产物并收紧 CSP

## 目录结构

```
Translate/
├── worker.js        # 全部逻辑：路由 + 翻译 + PWA + 页面（单文件）
├── wrangler.jsonc   # Cloudflare 配置（AI 绑定、模型变量、日志）
├── package.json     # 脚本：dev / deploy / check / tail
└── .backup-20261015/  # v2.1 重写前的原始版本备份
```

## Changelog

**v2.1**（2026-10-15）
- 新增限流、请求体闸门、模型故障转移、动态 max_tokens
- 新增 CSP/HSTS/COOP 安全响应头，错误响应不再泄漏内部细节
- 语言扩充至 14 种；新增 `/api/health`、`/api/tts`、`/favicon.ico`
- **TTS 整体替换**：浏览器 speechSynthesis → Workers AI TTS，解决「系统语音包缺失、默认中文音读英文」问题；英文先后试用 Deepgram Aura-2（音频拼接异常、读得乱）后弃用，现全语种统一 MeloTTS，并补 ReadableStream 读全合并 + 空音频防护
- 流式光标、OCR 降采样与防重复拍照、历史面板 inert/焦点管理
- 修复日文汉字被误判为中文的朗读语种 bug

**v2.0**
- 修复历史记录存储型 XSS、快速输入响应竞态
- 补上 max_tokens/temperature，流式输出，SW 白名单缓存

**v1.0**：首个可用版本
