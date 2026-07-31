export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // POST /raw - 上传音频并转写
    if (request.method === 'POST' && url.pathname === '/raw') {
      return handleAudioToText(request, url, env);
    }
    //POST /seg - 上传图片转文字
    if (request.method === 'POST' && url.pathname === '/seg') {
      return handleImageToText(request, url, env);
    }


    return new Response('Not Found', { status: 404 });
  }
};

// =================== AI处理 ===================

/**
 * 通过AI转写单个音频块
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
 * 通过 AI 视觉模型识别图片内容（LLaVA 1.5 7B）
 * @param {ArrayBuffer} image - 图片二进制数据
 * @param {Env} env - Cloudflare Workers 环境绑定
 * @param {{
 *   mimeType?: string,
 *   question?: string,
 *   max_tokens?: number,
 * }} [params] - 可选控制参数
 * @returns {Promise<{ description: string }>}
 */
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

async function describeImage(image, env, params = {}) {
  const question = params.question || 'Describe this image in detail.';

  const inputs = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: new Uint8Array(image) },
          { type: 'text', text: question },
        ],
      },
    ],
    max_tokens: params.max_tokens || 512,
    temperature: 0.1,
  };

  return await env.AI.run(VISION_MODEL, inputs);
}

// =================== 路由处理 ===================

/** POST /raw - 上传音频片段并转写（前端已按 1 分钟切分） */
async function handleAudioToText(request, url, env) {
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

/** POST /seg - 上传图片并识别内容 */
async function handleImageToText(request, url, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.startsWith('image/') && !contentType.includes('application/octet-stream')) {
    return new Response('Invalid content type. Use image/png, image/jpeg, etc.', { status: 400 });
  }

  const params = {
    mimeType: contentType.split(';')[0].trim(),   // "image/png" | "image/jpeg" | ...
    question: url.searchParams.get('question') || null,
    max_tokens: parseInt(url.searchParams.get('max_tokens')) || 512,
  };

  let image;
  try {
    image = await request.arrayBuffer();
  } catch {
    return new Response('Failed to read image body.', { status: 400 });
  }

  let result;
  try {
    result = await describeImage(image, env, params);
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (msg.includes('quota') || msg.includes('exceeded') || msg.includes('limit')) {
      return new Response('Daily free quota exceeded. Please try again after 00:00 UTC.', { status: 429 });
    }
    return new Response('Image recognition failed: ' + msg, { status: 500 });
  }

  // Llama 3.2 Vision 返回 { response: "..." }
  const description = result.response || '';
  return Response.json({ description });
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


