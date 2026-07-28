const resultBox = document.getElementById('result');
const downloadSrtBtn = document.getElementById('downloadSrtBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
let srtContent = '';
let uploadedFileName = '';

// =================== FFmpeg 视频音频提取 ===================

let ffmpeg = null;

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpegWASM.FFmpeg();

  // @ffmpeg/ffmpeg JS 从本地 public/ 加载，core 内核从 CDN 加载
  await ffmpeg.load({
    coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
    wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
  });

  return ffmpeg;
}

// Tab 切换
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

function formatSRTTime(seconds) {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(ms, 3);
}

function pad(num, size = 2) {
  return num.toString().padStart(size, '0');
}

function convertWordsToSRT(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return 'No transcription data.';
  }
  let srt = '';
  const LF = '\n';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    srt += (i + 1) + LF + formatSRTTime(seg.start) + ' --> ' + formatSRTTime(seg.end) + LF + seg.text + LF + LF;
  }
  return srt;
}

function showProgress() {
  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = '开始处理中... 请稍候';
  resultBox.value = '';
  downloadSrtBtn.disabled = true;
}

function hideProgress() {
  progressBar.style.width = '100%';
  setTimeout(() => { progressContainer.style.display = 'none'; }, 500);
}

// =================== 音频预处理（ffmpeg 切分） ===================

/**
 * 通过 WORKERFS 零拷贝挂载输入文件到 ffmpeg 虚拟文件系统。
 * 返回 { path, cleanup }，path 用于 ffmpeg -i，finally 中调用 cleanup()。
 */
async function mountInput(ff, file) {
  await ff.createDir('/mnt');
  await ff.mount('WORKERFS', { files: [file] }, '/mnt');
  return { path: '/mnt/' + file.name, cleanup: async () => { await ff.unmount('/mnt'); await ff.deleteDir('/mnt'); } };
}

/**
 * 将音频切分为 16kHz 单声道 WAV，每段 ~60 秒，储存到 OPFS。
 * 返回 { totalSegments, getSegment(i), cleanup() } — 按需读取，不堆积内存。
 */
async function prepareAudioForTranscription(file) {
  const SEGMENT_SECONDS = 60;
  const ff = await getFFmpeg();
  registerFFLog(ff);
  const input = await mountInput(ff, file);

  // 探测时长
  await ff.exec(['-i', input.path]).catch(() => {});
  let duration = 0;
  for (const msg of ffLogs) {
    const m = msg.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (m) {
      duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100;
      break;
    }
  }
  if (!duration || duration <= 0) throw new Error('无法获取音频时长');

  const totalSegments = Math.ceil(duration / SEGMENT_SECONDS);

  // 逐段提取 → 写入 OPFS（WASM 堆仅持 1 个 ~1.83MB 的 WAV）
  await cleanupOPFS();
  const opfsDir = await getOPFSDir();

  for (let i = 0; i < totalSegments; i++) {
    const name = 'seg_' + String(i).padStart(3, '0') + '.wav';
    await ff.exec([
      '-ss', String(i * SEGMENT_SECONDS),
      '-to', String((i + 1) * SEGMENT_SECONDS),
      '-i', input.path,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      name
    ]);
    const data = await ff.readFile(name);
    await writeToOPFS(opfsDir, name, data);
    await ff.deleteFile(name);
  }

  await input.cleanup();

  return {
    totalSegments,
    async getSegment(i) {
      const name = 'seg_' + String(i).padStart(3, '0') + '.wav';
      const data = await readFromOPFS(opfsDir, name);
      return data.buffer; // ArrayBuffer 兼容 fetch body
    },
    async cleanup() {
      await cleanupOPFS();
    }
  };
}

// 文件上传转写
document.getElementById('uploadSubmitBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('audioFile');
  const file = fileInput.files[0];
  if (!file) return alert('Please select a file.');

  uploadedFileName = file.name;
  showProgress();

  // 预处理：ffmpeg 逐片切分为 1 分钟 WAV，存入 OPFS
  let prep;
  try {
    progressText.textContent = '正在预处理音频，切分为 1 分钟片段...';
    prep = await prepareAudioForTranscription(file);
  } catch (e) {
    progressContainer.style.display = 'none';
    console.error('音频预处理失败:', e);
    console.error('ffmpeg 日志:', ffLogs.join('\n'));
    const logTail = ffLogs.slice(-8).join('\n');
    resultBox.value = '音频预处理失败: ' + (e.message || String(e) || '未知错误') +
      '\n\n--- ffmpeg 最近日志 ---\n' + (logTail || '(无日志)') +
      '\n\n请打开开发者控制台查看详细错误。';
    return;
  }

  const totalSegments = prep.totalSegments;
  let allSegments = [];
  let timeOffset = 0;
  const errors = [];

  const params = new URLSearchParams({
    task: document.getElementById('task').value,
    ...(document.getElementById('language').value && { language: document.getElementById('language').value }),
    ...(document.getElementById('initial_prompt').value && { initial_prompt: document.getElementById('initial_prompt').value }),
    ...(document.getElementById('prefix').value && { prefix: document.getElementById('prefix').value }),
    vad_filter: document.getElementById('vad_filter').checked.toString()
  });

  for (let i = 0; i < totalSegments; i++) {
    progressBar.style.width = Math.round((i / totalSegments) * 90) + '%';
    progressText.textContent = '正在转写... 片段 ' + (i + 1) + '/' + totalSegments;

    try {
      const resp = await fetch('/raw?' + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await prep.getSegment(i)
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();

      if (data.segments && data.segments.length > 0) {
        for (const seg of data.segments) {
          allSegments.push({
            start: seg.start + timeOffset,
            end: seg.end + timeOffset,
            text: seg.text,
          });
        }
        const lastSeg = data.segments[data.segments.length - 1];
        timeOffset += lastSeg.end;
      }
    } catch (err) {
      errors.push(i);
    }
  }

  if (allSegments.length === 0) {
    srtContent = errors.length > 0 ? '所有片段处理失败。' : 'No transcription data.';
  } else {
    srtContent = convertWordsToSRT(allSegments);
    if (errors.length > 0) {
      srtContent += '\n\n[警告] ' + errors.length + '/' + totalSegments + ' 个片段处理失败';
    }
  }

  hideProgress();
  resultBox.value = srtContent;
  downloadSrtBtn.disabled = false;

  await prep.cleanup();
});

// =================== 视频提取音频下载 ===================

// 收集 ffmpeg 日志用于调试
let ffLogs = [];
function registerFFLog(ff) {
  ffLogs = [];
  ff.on('log', ({ message }) => { ffLogs.push(message); });
}

/** 销毁当前 ffmpeg 实例，彻底释放 WASM 堆内存 */
async function resetFFmpeg() {
  if (ffmpeg) {
    ffmpeg.off('log');           // 清理所有 log 监听器
    // terminate/destroy 会释放 WASM 堆，避免多轮处理导致 OOB
    if (typeof ffmpeg.terminate === 'function') {
      ffmpeg.terminate();
    }
    ffmpeg = null;
  }
}

/** 获取一个已加载、已挂载 WORKERFS 的 ffmpeg 实例 + input 对象 */
async function getFFmpegWithInput(file) {
  await resetFFmpeg();          // 先清理旧实例
  const ff = await getFFmpeg();
  registerFFLog(ff);
  const input = await mountInput(ff, file);
  return { ff, input };
}

/** 判断错误是否为 WASM 内存耗尽 */
function isWasmOOM(err) {
  const msg = String(err?.message || err || '');
  return /(memory access out of bounds|out of memory|abort|OOM)/i.test(msg);
}

/** 重建 ffmpeg 实例并重新挂载 WORKERFS，返回新实例 */
async function rebuildFFmpeg(file, oldInput) {
  // 先安全卸载旧的 WORKERFS
  try { await oldInput.cleanup(); } catch (_) { }
  const { ff: newFF, input: newInput } = await getFFmpegWithInput(file);
  return { ff: newFF, input: newInput };
}

// =================== OPFS 临时存储 ===================
const OPFS_TEMP_DIR = 'ffmpeg-chunks';

async function getOPFSDir(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_TEMP_DIR, { create });
}

async function writeToOPFS(dir, name, data) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readFromOPFS(dir, name) {
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function removeFromOPFS(dir, name) {
  try { await dir.removeEntry(name); } catch (_) { }
}

async function cleanupOPFS() {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(OPFS_TEMP_DIR, { recursive: true }); } catch (_) { }
}

/** 从视频中提取音频用于下载（小文件一次性，大文件分段提取 + OPFS 存储 + JS 拼接） */
async function extractAudioForDownload(file) {
  const SEGMENT_SECONDS = 60;
  const ONE_SHOT_BYTES = 200 * 1024 * 1024;
  const formatMB = (b) => (b / (1024 * 1024)).toFixed(0);

  // 小文件快速通道（单次提取，不需要 OPFS）
  if (file.size <= ONE_SHOT_BYTES) {
    const { ff, input } = await getFFmpegWithInput(file);
    try {
      progressBar.style.width = '90%';
      progressText.textContent = '正在从视频中提取音频，编码为 MP3...';

      await ff.exec([
        '-i', input.path,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        'audio.mp3'
      ]);

      const data = await ff.readFile('audio.mp3');
      await ff.deleteFile('audio.mp3');
      return { data: new Uint8Array(data), ext: 'mp3', mime: 'audio/mpeg' };
    } finally {
      await input.cleanup();
    }
  }

  // ---- 大文件：分段提取 + OPFS 存储 + 纯 JS 拼接 ----

  await cleanupOPFS();

  // 1. 初始化 ffmpeg + 探测视频时长
  const { ff: firstFF, input: firstInput } = await getFFmpegWithInput(file);

  progressText.textContent = '正在探测视频时长...';
  await firstFF.exec(['-i', firstInput.path]).catch(() => { });

  let duration = 0;
  for (const msg of ffLogs) {
    const m = msg.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (m) {
      duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100;
      break;
    }
  }
  if (!duration || duration <= 0) throw new Error('无法获取视频时长');

  // 2. 逐段提取 → 直接写入 OPFS（WASM 堆仅持有一个 ~1MB 的 chunk）
  const totalSegments = Math.ceil(duration / SEGMENT_SECONDS);
  const OOM_RETRY_LIMIT = 2;
  const CHUNK_NAME = 'chunk.mp3';
  const opfsDir = await getOPFSDir();
  let ctx = { ff: firstFF, input: firstInput };
  let extractedCount = 0;

  for (let i = 0; i < totalSegments; i++) {
    progressBar.style.width = Math.round((i / totalSegments) * 80) + '%';
    progressText.textContent = '提取音频片段 ' + (i + 1) + '/' + totalSegments;

    let attempt = 0;
    while (attempt < OOM_RETRY_LIMIT) {
      try {
        await ctx.ff.exec([
          '-ss', String(i * SEGMENT_SECONDS),
          '-to', String((i + 1) * SEGMENT_SECONDS),
          '-i', ctx.input.path,
          '-vn',
          '-c:a', 'libmp3lame',
          '-b:a', '128k',
          '-write_xing', '0',
          '-avoid_negative_ts', '1',
          CHUNK_NAME
        ]);

        const data = await ctx.ff.readFile(CHUNK_NAME);
        await writeToOPFS(opfsDir, 'chunk_' + i + '.mp3', data);
        await ctx.ff.deleteFile(CHUNK_NAME);
        extractedCount = i + 1;
        break;
      } catch (e) {
        if (isWasmOOM(e) && attempt < OOM_RETRY_LIMIT - 1) {
          console.warn('WASM OOM，重建 ffmpeg 并重试片段 ' + (i + 1));
          progressText.textContent = '内存不足，重建处理引擎...';
          try { await ctx.ff.deleteFile(CHUNK_NAME); } catch (_) { }
          ctx = await rebuildFFmpeg(file, ctx.input);
          attempt++;
          continue;
        }
        throw e;
      }
    }
  }

  // 释放 ffmpeg 实例——后续不再需要 WASM
  await ctx.input.cleanup();
  try { ctx.ff.terminate(); } catch (_) { }
  ctx = null;

  // 3. 创建 ReadableStream，从 OPFS 逐片读出 → 直接喂给 Blob
  //    CBR 128kbps + -write_xing 0 → 每片是纯 MPEG 音频帧流，直接拼接即有效 MP3
  progressBar.style.width = '90%';
  progressText.textContent = '正在流式合并 ' + extractedCount + ' 个音频片段...';

  // 先统计总大小
  let totalSize = 0;
  for (let i = 0; i < extractedCount; i++) {
    const handle = await opfsDir.getFileHandle('chunk_' + i + '.mp3');
    totalSize += (await handle.getFile()).size;
  }

  let streamDone = false;
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < extractedCount; i++) {
        const data = await readFromOPFS(opfsDir, 'chunk_' + i + '.mp3');
        controller.enqueue(data);
        // 读完一片立即从 OPFS 删除，释放磁盘空间
        await removeFromOPFS(opfsDir, 'chunk_' + i + '.mp3');
      }
      controller.close();
      await cleanupOPFS();
      streamDone = true;
    }
  });

  progressText.textContent = '音频提取完成（~' + formatMB(totalSize) + ' MB），正在准备下载...';
  return {
    stream,
    size: totalSize,
    ext: 'mp3',
    mime: 'audio/mpeg',
    opfsCleanup: async () => { if (!streamDone) await cleanupOPFS(); }
  };
}

// 视频文件选择（WORKERFS + OPFS 已无大小限制）
document.getElementById('extractVideoFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const info = document.getElementById('extractSizeInfo');
  if (file) {
    const gb = (file.size / (1024 * 1024 * 1024)).toFixed(1);
    info.textContent = file.name + '（' + gb + ' GB）— WORKERFS 零拷贝 + OPFS 临时存储，无文件大小限制';
    info.style.display = 'block';
  } else {
    info.style.display = 'none';
  }
});
//提取音频
document.getElementById('extractSubmitBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('extractVideoFile');
  const file = fileInput.files[0];
  if (!file) return alert('请选择一个视频文件。');

  const filename = file.name.replace(/\.[^/.]+$/, '') + '.mp3';

  // showSaveFilePicker 必须在用户手势内调用，先弹保存对话框再提取
  if (typeof window.showSaveFilePicker === 'function') {
    let handle, writable;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: filename });
      writable = await handle.createWritable();
    } catch (e) {
      if (e.name === 'AbortError') return; // 用户取消保存对话框
      throw e;
    }

    showProgress();
    progressText.textContent = '检测到视频文件，准备提取音频...';

    try {
      const result = await extractAudioForDownload(file);

      if (result.stream) {
        // 大文件：流式写入磁盘，内存峰值仅 1 个 chunk
        const totalMB = (result.size / (1024 * 1024)).toFixed(1);
        progressText.textContent = '正在保存音频... ' + totalMB + ' MB';
        await result.stream.pipeTo(writable);
        await result.opfsCleanup();
      } else {
        // 小文件：直接写入
        await writable.write(result.data);
        await writable.close();
      }

      hideProgress();
      resultBox.value = '提取并下载完成：' + filename;
    } catch (e) {
      // 提取失败时关闭/丢弃文件
      try { await writable.abort(); } catch (_) { }
      progressContainer.style.display = 'none';
      console.error('提取音频失败:', e);
      console.error('ffmpeg 日志:', ffLogs.join('\n'));
      const errMsg = e.message || String(e);
      const logTail = ffLogs.slice(-8).join('\n');
      if (errMsg.includes('out of memory') || errMsg.includes('memory access') || (logTail && logTail.includes('out of memory'))) {
        resultBox.value = errMsg;
      } else {
        resultBox.value = '音频提取失败: ' + (errMsg || '未知错误') +
          '\n\n--- ffmpeg 最近日志 ---\n' + (logTail || '(无日志)') +
          '\n\n请确认浏览器支持 WebAssembly，也可打开开发者控制台查看详细错误。';
      }
    }
    return;
  }

  // 降级：Blob URL 方式（Firefox / Safari 不支持 showSaveFilePicker）
  showProgress();
  progressText.textContent = '检测到视频文件，准备提取音频...';

  try {
    const result = await extractAudioForDownload(file);

    const response = result.stream
      ? new Response(result.stream, { headers: { 'Content-Type': result.mime } })
      : new Response(result.data, { headers: { 'Content-Type': result.mime } });

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    if (result.stream) await result.opfsCleanup();

    const audioMB = (blob.size / (1024 * 1024)).toFixed(1);
    hideProgress();
    resultBox.value = '提取并下载完成：' + filename + '（' + audioMB + ' MB）';
  } catch (e) {
    progressContainer.style.display = 'none';
    // 完整 error 对象输出到控制台
    console.error('提取音频失败:', e);
    console.error('ffmpeg 日志:', ffLogs.join('\n'));

    const errMsg = e.message || String(e);
    const logTail = ffLogs.slice(-8).join('\n');
    if (errMsg.includes('out of memory') || errMsg.includes('memory access') || (logTail && logTail.includes('out of memory'))) {
      resultBox.value = errMsg;
    } else {
      resultBox.value = '音频提取失败: ' + (errMsg || '未知错误') +
        '\n\n--- ffmpeg 最近日志 ---\n' + (logTail || '(无日志)') +
        '\n\n请确认浏览器支持 WebAssembly，也可打开开发者控制台查看详细错误。';
    }
  }
});

function getBaseFileName() {
  return (uploadedFileName || 'subtitles').replace(/\.[^/.]+$/, '');
}

function downloadFile(content, ext, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = getBaseFileName() + '.' + ext;
  a.click();
  URL.revokeObjectURL(url);
}

// 下载 SRT
downloadSrtBtn.addEventListener('click', () => downloadFile(srtContent, 'srt', 'text/plain;charset=utf-8'));
