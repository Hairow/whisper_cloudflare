// 分块大小：1MB（官方推荐值）
const CHUNK_SIZE = 1024 * 1024;

// 音频文件大小限制：20MB（Workers 免费计划内存限制）
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

import HTML_PAGE from './index.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // GET / - 返回前端页面
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // POST /raw - 上传音频并转写
    if (request.method === 'POST' && url.pathname === '/raw') {
      return handleUpload(request, url, env);
    }

    // 代理 ffmpeg CDN 文件，同源提供以解决 Worker 跨域问题
    if (url.pathname.startsWith('/ffmpeg/')) {
      return fetch('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/' + url.pathname.slice(8));
    }
    if (url.pathname.startsWith('/ffmpeg-core/')) {
      return fetch('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/' + url.pathname.slice(13));
    }

    return new Response('Not Found', { status: 404 });
  }
};

// =================== 分块处理核心逻辑 ===================

/**
 * 将音频 ArrayBuffer 按固定大小切为多个块
 * 每个块都是独立的 ArrayBuffer 切片（零拷贝，共享底层内存）
 */
function chunkAudio(buffer) {
  const chunks = [];
  for (let i = 0; i < buffer.byteLength; i += CHUNK_SIZE) {
    chunks.push(buffer.slice(i, Math.min(i + CHUNK_SIZE, buffer.byteLength)));
  }
  return chunks;
}

/**
 * 转写单个音频块
 * @returns {{ text: string, segments: Array }} Whisper 返回的结果
 */
async function transcribeChunk(chunk, env, params) {
  const inputs = {
    audio: arrayBufferToBase64(chunk),
    task: params.task,
    vad_filter: params.vad_filter,
  };
  if (params.language) inputs.language = params.language;
  if (params.initial_prompt) inputs.initial_prompt = params.initial_prompt;
  if (params.prefix) inputs.prefix = params.prefix;

  return await env.AI.run("@cf/openai/whisper-large-v3-turbo", inputs);
}

/**
 * 处理所有音频块，返回合并后的结果
 * - text: 合并的纯文本
 * - segments: 时间戳已偏移为全局时间的 segments 数组
 * - chunkCount: 总块数
 * - errors: 失败的块索引列表
 */
async function processChunks(chunks, env, params) {
  let fullText = '';
  let allSegments = [];
  let timeOffset = 0;
  const errors = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const result = await transcribeChunk(chunks[i], env, params);
      fullText += result.text + '\n';

      if (result.segments && result.segments.length > 0) {
        // 将当前块的时间戳偏移为全局时间
        for (const seg of result.segments) {
          allSegments.push({
            start: seg.start + timeOffset,
            end: seg.end + timeOffset,
            text: seg.text,
          });
        }
        // 累加时间偏移（用本块最后一段的结束时间作为下一块的起点）
        const lastSeg = result.segments[result.segments.length - 1];
        timeOffset += lastSeg.end;
      }
    } catch (e) {
      console.error(`Chunk ${i} failed:`, e);
      errors.push(i);
      fullText += `[块 ${i} 转写失败]\n`;
    }
  }

  return {
    text: fullText.trim(),
    segments: allSegments,
    chunkCount: chunks.length,
    errors,
  };
}

// =================== 路由处理 ===================

/** POST /raw - 上传音频文件 */
async function handleUpload(request, url, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/octet-stream')) {
    return new Response('Invalid content type. Use application/octet-stream.', { status: 400 });
  }

  const params = parseParams(url);

  const blob = await request.arrayBuffer();

  if (blob.byteLength > MAX_AUDIO_BYTES) {
    return new Response(`File too large (${(blob.byteLength / (1024 * 1024)).toFixed(1)} MB). Max 20 MB.`, { status: 400 });
  }

  const chunks = chunkAudio(blob);

  let result;
  try {
    result = await processChunks(chunks, env, params);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "An unexpected error occurred: " + e });
  }

  return Response.json({
    text: result.text,
    segments: result.segments,
    chunkCount: result.chunkCount,
    errors: result.errors,
  });
}

// =================== 辅助函数 ===================

/** 解析 URL 查询参数 */
function parseParams(url) {
  return {
    task: url.searchParams.get('task') || 'transcribe',
    language: url.searchParams.get('language') || null,
    vad_filter: url.searchParams.get('vad_filter') === 'true',
    initial_prompt: url.searchParams.get('initial_prompt') || null,
    prefix: url.searchParams.get('prefix') || null,
  };
}

/** ArrayBuffer → Base64 字符串 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}


