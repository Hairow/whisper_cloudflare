# Whisper on Cloudflare AI

基于 Cloudflare Workers AI（Whisper large-v3-turbo）的在线音频/视频转写工具，支持在浏览器中直接提取视频音频并生成字幕。

## 功能

- **音频转写**：上传音频文件，转写为带时间戳的文字
- **视频提取音频**：用浏览器端 ffmpeg.wasm 从视频中提取 MP3 音频并下载
- **视频→字幕**：先提取音频再转写，一条龙生成 SRT 字幕
- **VAD 过滤**：自动跳过静音段，减少无效消耗
- **大文件支持**：WORKERFS 零拷贝 + OPFS 流式存储，**无文件大小限制**
- **OOM 自动恢复**：WASM 内存耗尽时自动重建 ffmpeg 实例，继续处理
- **流式下载**：Chrome / Edge 通过 File System Access API 直接写入磁盘，内存峰值 ~1MB
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
- **大文件存储**：OPFS（Origin Private File System）
- **前端**：`public/` 目录静态托管，单 HTML + 单 JS

### 音频处理架构

#### 视频提取音频（→ 下载 MP3）

```
WORKERFS 零拷贝挂载视频文件
  ↓
ffmpeg -ss -to 逐段提取 MP3（每段 60 秒，CBR 128kbps，无 Xing 头）
  ↓
每段写入 OPFS（WASM 堆仅持 1 个 ~1MB chunk，OOM 自动恢复）
  ↓
ReadableStream 从 OPFS 逐片读出 → showSaveFilePicker 流式写入磁盘
  （内存峰值 ~1MB，无文件大小限制）
```

#### 音频转写（→ SRT 字幕）

```
WORKERFS 零拷贝挂载音频文件
  ↓
ffmpeg -ss -to 逐段提取 WAV（16kHz 单声道 PCM，每段 60 秒）
  ↓
每段写入 OPFS（WASM 堆仅持 1 个 ~1.83MB WAV）
  ↓
按需从 OPFS 逐段读取 → POST /raw 转写 → 合并 SRT
```


### 静态资源路由

Cloudflare Workers + Assets 模式下，`public/` 下的文件由平台直接托管，不经过 Worker：

| 路径 | 处理方式 |
|------|---------|
| `/` | Platform Assets → `public/index.html` |
| `/index.html` | Platform Assets → `public/index.html` |
| `/app.js` | Platform Assets → `public/app.js` |
| `/ffmpeg-umd/…` | Platform Assets → `public/ffmpeg-umd/…` |
| `POST /raw` | Worker → Whisper 转写 API |
| 其他 | Worker → 404 |

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
- 使用单线程版 core（`dist/umd`），WASM 堆上限 128MB

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
