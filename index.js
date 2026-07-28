import HTML_PAGE from './index.html';

// COOP/COEP 头，启用 SharedArrayBuffer 支持大内存 WASM
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // GET / - 返回前端页面
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...ISOLATION_HEADERS }
      });
    }

    // POST /raw - 上传音频并转写
    if (request.method === 'POST' && url.pathname === '/raw') {
      return handleUpload(request, url, env);
    }


    return new Response('Not Found', { status: 404 });
  }
};

// =================== 转写处理 ===================

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

// =================== 路由处理 ===================

/** POST /raw - 上传音频片段并转写（前端已按 1 分钟切分） */
async function handleUpload(request, url, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/octet-stream')) {
    return new Response('Invalid content type. Use application/octet-stream.', { status: 400 });
  }

  const params = parseParams(url);
  const blob = await request.arrayBuffer();

  let result;
  try {
    result = await transcribeChunk(blob, env, params);
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (msg.includes('quota') || msg.includes('exceeded') || msg.includes('limit')) {
      return new Response('Daily free quota exceeded. Please try again after 00:00 UTC.', { status: 429 });
    }
    return new Response('Transcription failed: ' + msg, { status: 500 });
  }

  return Response.json({
    text: result.text,
    segments: result.segments || [],
    chunkCount: 1,
    errors: [],
  });
}

// =================== 辅助函数 ===================

/** 代理 CDN 资源并附加跨域隔离头，满足 COEP require-corp 和 Worker 的隔离要求 */
async function proxyWithIsolation(cdnUrl) {
  const resp = await fetch(cdnUrl);
  const headers = new Headers(resp.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

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


