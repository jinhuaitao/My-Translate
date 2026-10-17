# AI 随身翻译

基于 **Cloudflare Workers** 的单文件多语言翻译 PWA：通过环境变量自定义 `API_URL`、`API_KEY` 和 `MODEL` 调用任意 OpenAI 兼容大模型接口实现流式翻译，同时保留拍照 OCR 识别、语音朗读、离线外壳，一个 Worker 即全部后端，无需数据库。

## 功能特性

- **自定义 API 流式翻译**：通过环境变量配置 `API_URL`、`API_KEY`、`MODEL`（兼容 OpenAI / DeepSeek / 通义千问 / 智谱 GLM / SiliconFlow / OneAPI 等），译文逐字输出（SSE），14 种语言互译，源语言支持自动检测
- **持久化环境变量**：已开启 `keep_vars: true` 并移除本地硬编码的 `vars.MODEL`，每次重新部署（含 GitHub 自动部署与本地 `npm run deploy`）均**不会覆盖或清除**已在 Cloudflare 控制台添加的环境变量
- **拍照识别**：调用摄像头 + Tesseract.js 离线 OCR，识别结果直接填入并翻译
- **语音朗读**：Workers AI 语音合成（MeloTTS 全语种 + 英文 Deepgram Aura-2 兜底），服务端生成音频流、前端播放
- **历史记录**：最近 50 条本地保存（localStorage），点击回填，全程 `textContent` 渲染防 XSS
- **PWA**：可添加到主屏，Service Worker 提供离线外壳，断网有明确提示
- **深色模式**：跟随系统 + 手动切换并记忆
- **移动端适配**：安全区适配、双击缩放禁用、流式光标、触感反馈

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Cloudflare Workers（模块化 Worker，单文件 `worker.js`）|
| 翻译模型 | 环境变量配置（`API_URL` + `API_KEY` + `MODEL`，支持任意 OpenAI Chat Completions 兼容接口及多模型故障转移）|
| TTS | Workers AI：`@cf/myshell-ai/melotts`（全语种主路径）+ `@cf/deepgram/aura-2-en`（英文降级兜底）|
| 前端 | Tailwind CDN + Remixicon + 原生 JS（零构建）|
| OCR | Tesseract.js v5（浏览器端，wasm）|

## 环境变量配置说明（核心）

请在 **Cloudflare Dashboard -> Workers & Pages -> 选择你的 Worker -> Settings（设置） -> Variables and Secrets（变量和机密）** 中添加以下三个环境变量：

| 变量名 | 必填 | 推荐类型 | 说明与示例 |
|---|---|---|---|
| `API_URL` | 是 | Plaintext / Secret | 支持填写完整地址（如 `https://api.openai.com/v1/chat/completions`）、带版本路径（如 `https://api.openai.com/v1`、`https://open.bigmodel.cn/api/paas/v4`）或域名根地址（如 `https://api.deepseek.com`），程序会自动补全 `/chat/completions` |
| `API_KEY` | 是 | **Secret** | 你的接口密钥（如 `sk-...`），使用 Secret 类型加密保存更安全 |
| `MODEL` | 是 | Plaintext | 模型名称（如 `gpt-4o-mini`、`deepseek-chat`）。支持用英文逗号分隔多个模型实现自动降级容灾（如 `gpt-4o-mini,gpt-3.5-turbo`） |

### 为什么重新部署不会影响已添加的环境变量？

1. **`wrangler.jsonc` 已配置 `"keep_vars": true`**：告诉 Wrangler 在部署时保留云端控制台已有的所有环境变量，不执行清理。
2. **移除了 `wrangler.jsonc` 中的 `"vars"` 同名字段**：如果 `wrangler.jsonc` 的 `vars` 中存在 `MODEL` 等同名键，每次部署都会用配置文件里的静态值强行覆盖控制台的值。移除后，云端设置的 `API_URL`、`API_KEY`、`MODEL` 完全独立于代码部署。
3. **`package.json` 部署脚本已加固**：`"deploy": "wrangler deploy --keep-vars"` 提供双重保障。

## 快速开始

### 本地开发

在项目根目录新建 `.dev.vars` 文件（用于本地 `wrangler dev` 读取环境变量，切勿提交到公开仓库）：

```ini
API_URL=https://api.openai.com/v1/chat/completions
API_KEY=sk-your-api-key
MODEL=gpt-4o-mini
```

然后启动本地服务：

```bash
npm install
npm run dev        # wrangler dev，默认 http://localhost:8787
```

### 部署

方式一：本地部署

```bash
npm run deploy     # wrangler deploy --keep-vars（保留云端已配置的环境变量）
```

方式二：连接 GitHub（Workers Builds）

在 Cloudflare Dashboard 连接本仓库，构建命令执行 `npx wrangler deploy`，会自动读取 `wrangler.jsonc` 中的 `"keep_vars": true` 完成部署，**不会覆盖或删除你在控制台添加的环境变量**。

### 其他脚本

```bash
npm run check      # dry-run 构建，验证配置与语法
npm run tail       # 实时查看线上日志
```

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

### `GET /api/health`

零成本探活，返回环境变量配置状态（不暴露敏感密钥值）、TTS 绑定状态与限流参数。

## 目录结构

```
My-Translate-main/
├── worker.js        # 全部逻辑：路由 + 外部 API 翻译 + TTS + PWA + 页面（单文件）
├── wrangler.jsonc   # Cloudflare 配置（含 keep_vars: true 保护环境变量）
├── package.json     # 脚本：dev / deploy (--keep-vars) / check / tail
└── README.md        # 项目说明与配置文档
```
