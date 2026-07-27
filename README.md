# Whisper on Cloudflare AI

基于 Cloudflare Workers AI（Whisper large-v3-turbo）的在线音频/视频转写工具，支持在浏览器中直接提取视频音频并生成字幕。

## 功能

- **音频转写**：上传音频文件，直接转写为文字
- **视频提取音频**：用浏览器端 ffmpeg.wasm 从视频中提取音频，然后转写
- **SRT 字幕**：自动生成带时间戳的 SRT 字幕文件并下载
- **VAD 过滤**：自动跳过静音段，减少无效消耗
- **大文件支持**：启用 Cross-Origin Isolation，支持 1GB 以内的视频文件
- **多语言**：支持转写（transcribe）和翻译（translate）两种模式

## 免费额度

Cloudflare Workers AI 每日提供 10,000 neurons 免费额度。Whisper large-v3-turbo 消耗约 **47 neurons/分钟**，每天可转写约 **3.5 小时**音频。

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
- **内存优化**：Cross-Origin Isolation（COOP + COEP），启用 SharedArrayBuffer 解锁 4GB WASM 堆

## API 接口

### `POST /raw`

上传音频数据并获取转写结果。

- **Content-Type**：`application/octet-stream`
- **Body**：WAV 音频二进制数据（16kHz 单声道 16-bit PCM）
- **Query 参数**：见上方转写配置表
- **返回**：`{ text, segments }` JSON
