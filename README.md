# Whisper on Cloudflare AI

基于 Cloudflare Workers AI（Whisper large-v3-turbo）的在线音频/视频转写工具，支持在浏览器中直接提取视频音频并生成字幕。

## 功能

- **音频转写**：上传音频文件，直接转写为文字
- **视频提取音频**：用浏览器端 ffmpeg.wasm 从视频中提取音频，然后转写
- **SRT 字幕**：自动生成带时间戳的 SRT 字幕文件并下载
- **VAD 过滤**：自动跳过静音段，减少无效消耗
- **大文件支持**：浏览器端 ffmpeg.wasm 处理，支持 1GB 以内的视频文件
- **多语言**：支持转写（transcribe）和翻译（translate）两种模式

## 免费额度

Cloudflare Workers AI 每日提供 10,000 neurons 免费额度。Whisper large-v3-turbo 消耗约 **47 neurons/分钟**，每天可转写约 **3.5 小时**音频。

> **超出后**：API 调用会返回 `429` 错误，提示配额耗尽。北京时间每天 08:00（UTC 00:00）重置。

## 付费计划

超免费额度后可订阅 **Workers Paid 计划**（$5/月起），按实际用量付费。

**Whisper large-v3-turbo 定价**：$0.011 / 1,000 neurons

| 音频时长 | 消耗 neurons | 费用 |
| --- | ---: | ---: |
| 1 分钟 | ~47 | ~$0.0005 |
| 10 分钟 | ~470 | ~$0.005 |
| 1 小时 | ~2,820 | ~$0.031 |
| 3.5 小时（≈ 免费额度） | ~10,000 | ~$0.11 |

## 使用方式

直接访问部署后的 Worker URL，上传音频或视频文件即可。

### 转写配置

| 参数 | 说明 |
| --- | --- |
| Task | `transcribe`（转写原文）或 `translate`（翻译为英文） |
| Language | 可选，指定源语言代码（zh、en、ja 等） |
| Initial Prompt | 初始提示词，引导模型理解语境 |
| Prefix | 前缀文本，增强上下文理解 |
| VAD Filter | 启用语音活动检测，跳过静音段 |

## 部署

```bash
npm install
npx wrangler deploy
```

## 技术栈

- **后端**：Cloudflare Workers
- **AI**：Cloudflare Workers AI（`@cf/openai/whisper-large-v3-turbo`）
- **视频处理**：ffmpeg.wasm（浏览器端 WebAssembly）
- **前端**：`public/` 目录静态托管，单 HTML + 单 JS

### ffmpeg.wasm 文件加载架构

ffmpeg.wasm 由主线程 + Web Worker 双线程运行，涉及 4 个文件：

```
主线程                              Worker 线程
   │
   ├── <script> ffmpeg.js            ─── 主线程入口，暴露 API
   └── new Worker(814.ffmpeg.js)     ─── 创建 Worker
         │
         ├── importScripts('ffmpeg-core.js')   ─── WASM 胶水代码
         └── fetch('ffmpeg-core.wasm')         ─── WASM 二进制（9.9MB）
```

| 文件 | 加载方式 | 来源 | CORS 影响 |
|---|---|---|---|
| `ffmpeg.js` | `<script>` 标签 | `public/ffmpeg-umd/` 同源 | ❌ 不受限 |
| `814.ffmpeg.js` | `new Worker()` | `public/ffmpeg-umd/` 同源 | ❌ 必须同源，本身满足 |
| `ffmpeg-core.js` | `importScripts()` | CDN（unpkg） | ❌ importScripts 不检查 CORS，不检查 COEP|
| `ffmpeg-core.wasm` | `fetch()` | CDN（unpkg） | ✅ CDN 需返回 CORS 头，但项目未启用 COEP，不强制 CORP |

- `ffmpeg.js` / `814.ffmpeg.js` 由 `npm run postinstall` 从 `node_modules` 拷贝到 `public/ffmpeg-umd/`
- `ffmpeg-core.js` / `ffmpeg-core.wasm` 直接从 unpkg CDN 加载
- 未启用 COEP，WASM 堆上限 2GB（非 4GB），实际建议视频不超过 500MB 以保证稳定性

### 通信模型

ffmpeg.js 在主线程只暴露轻量 API 壳，所有 WASM 运算在 Worker 线程完成，通过 `postMessage` 通信：

```
主线程                              Worker 线程
─────────────────────────────────────────────────
ff.exec(['-i', 'input.mp4',
         '-vn', '-c:a', 'copy',
         'output.mp3'])
  │
  └── postMessage(args)  ──→     接收消息
                                    WASM 解码 + 编码
                                    memcpy 写入 MEMFS
                                  运算结束
                                ← postMessage(result)
  await resolve()
  │
  ├── ff.readFile('output.mp3')
  │     └── postMessage  ──→     WASM 读 MEMFS
  │                           ←   Uint8Array
  │
  └── ff.deleteFile(...)
        └── postMessage  ──→     WASM 清理 MEMFS
```

- `importScripts()` / `WebAssembly.instantiate()` 只在 Worker 启动时执行一次，之后 WASM 处于待命状态
- 每次 `ff.exec()` 期间 Worker 线程被 WASM 独占，结束后立即交还控制权
- 主线程始终保持响应，不会因 ffmpeg 运算而卡顿 UI

## API 接口

### `POST /raw`

上传音频数据并获取转写结果。

- **Content-Type**：`application/octet-stream`
- **Body**：WAV 音频二进制数据（16kHz 单声道 16-bit PCM）
- **Query 参数**：见上方转写配置表
- **返回**：`{ text, segments }` JSON
