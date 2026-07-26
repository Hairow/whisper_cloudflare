export default `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Whisper Transcription</title>
  <style>
    :root {
      --primary-color: #4a90e2;
      --border-radius: 8px;
      --spacing: 20px;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: var(--spacing);
      max-width: 900px;
      margin: 0 auto;
      background-color: #f5f7fa;
      color: #333;
      line-height: 1.6;
    }
    h1 { color: #2c3e50; margin-bottom: 8px; }
    h2 { color: #2c3e50; margin-bottom: var(--spacing); font-size: 1.2em; }
    form {
      background: white;
      padding: var(--spacing);
      border-radius: var(--border-radius);
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    label {
      display: block;
      margin-top: 12px;
      font-weight: 500;
      color: #4a5568;
      font-size: 0.95em;
    }
    input[type="file"], input[type="text"], select {
      width: 100%;
      padding: 10px;
      margin: 6px 0;
      border: 1px solid #ddd;
      border-radius: var(--border-radius);
      box-sizing: border-box;
      font-size: 14px;
    }
    input[type="checkbox"] { margin-right: 6px; }
    button {
      background-color: var(--primary-color);
      color: white;
      padding: 12px 20px;
      border: none;
      border-radius: var(--border-radius);
      cursor: pointer;
      font-size: 15px;
      margin-top: 15px;
      transition: background-color 0.3s;
    }
    button:hover { background-color: #357abd; }
    button:disabled { background-color: #ccc; cursor: not-allowed; }
    textarea {
      width: 100%;
      height: 240px;
      margin-top: 10px;
      padding: 15px;
      border: 1px solid #ddd;
      border-radius: var(--border-radius);
      box-sizing: border-box;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      resize: vertical;
    }
    #downloadBtn { background-color: #27ae60; }
    #downloadBtn:hover { background-color: #219a52; }
    @media (max-width: 600px) {
      body { padding: 10px; }
      form { padding: 15px; }
    }
    #progressContainer {
      display: none;
      margin: 20px 0;
      background: #f0f0f0;
      border-radius: var(--border-radius);
      padding: 10px;
      text-align: center;
    }
    .progress-bar {
      width: 100%;
      height: 20px;
      background-color: #ddd;
      border-radius: 10px;
      overflow: hidden;
    }
    .progress {
      width: 0%;
      height: 100%;
      background-color: var(--primary-color);
      transition: width 0.3s ease;
    }
    .progress-text {
      margin-top: 8px;
      color: #666;
      font-size: 0.9em;
    }
    #chunkInfo {
      color: #888;
      font-size: 0.85em;
      margin-top: 4px;
    }
    .url-section {
      background: white;
      padding: var(--spacing);
      border-radius: var(--border-radius);
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      margin-bottom: var(--spacing);
    }
    .url-section h2 { margin-top: 0; }
  </style>
</head>
<body>
  <h1>Whisper 音频转写</h1>

  <div class="url-section">
    <h2>通过 URL 转写</h2>
    <label>音频文件 URL:</label>
    <input type="text" id="audioUrl" placeholder="https://example.com/audio.wav" />
    <button id="urlSubmitBtn">开始转写</button>
  </div>

  <form id="uploadForm">
    <h2 style="margin-top:0">上传文件转写</h2>
    <label>音频文件 (WAV/MP3):</label>
    <input type="file" id="audioFile" accept="audio/*" required />
    <label>任务:</label>
    <select id="task">
      <option value="transcribe">Transcribe（转写）</option>
      <option value="translate">Translate（翻译为英文）</option>
    </select>
    <label>语言 (optional):</label>
    <input type="text" id="language" placeholder="e.g. en, zh, ja" />
    <label>初始提示 (optional):</label>
    <input type="text" id="initial_prompt" placeholder="以下是普通话句子。" />
    <label>前缀 (optional):</label>
    <input type="text" id="prefix" />
    <label><input type="checkbox" id="vad_filter" checked />启用 VAD 过滤</label>
    <button type="submit">提交</button>
  </form>

  <div id="progressContainer">
    <div class="progress-bar">
      <div class="progress" id="progressBar"></div>
    </div>
    <div class="progress-text" id="progressText">处理中... 请稍候</div>
  </div>

  <h2>结果 (SRT):</h2>
  <textarea id="result" readonly></textarea>
  <button id="downloadBtn" disabled>下载 SRT</button>

<script>
const resultBox = document.getElementById('result');
const downloadBtn = document.getElementById('downloadBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
let srtContent = '';

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
  const LF = '\\n';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    srt += (i + 1) + LF + formatSRTTime(seg.start) + ' --> ' + formatSRTTime(seg.end) + LF + seg.text + LF + LF;
  }
  return srt;
}

function showProgress() {
  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = '处理中... 请稍候';
  resultBox.value = '';
  downloadBtn.disabled = true;
}

function hideProgress() {
  progressBar.style.width = '100%';
  setTimeout(() => { progressContainer.style.display = 'none'; }, 500);
}

// 文件上传转写
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('audioFile').files[0];
  if (!file) return alert('Please select a file.');

  showProgress();

  const task = document.getElementById('task').value;
  const language = document.getElementById('language').value;
  const initial_prompt = document.getElementById('initial_prompt').value;
  const prefix = document.getElementById('prefix').value;
  const vad_filter = document.getElementById('vad_filter').checked;

  const estimatedChunks = Math.ceil(file.size / (1024 * 1024));
  progressText.textContent = '音频约 ' + (file.size / (1024 * 1024)).toFixed(1) + ' MB，预计分 ' + estimatedChunks + ' 块处理...';

  const params = new URLSearchParams({
    task,
    ...(language && { language }),
    ...(initial_prompt && { initial_prompt }),
    ...(prefix && { prefix }),
    vad_filter: vad_filter.toString()
  });

  try {
    const response = await fetch('/raw?' + params.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer()
    });

    if (!response.ok) {
      const error = await response.text();
      resultBox.value = 'Error: ' + error;
      progressContainer.style.display = 'none';
      return;
    }

    const rawData = await response.json();

    if (!rawData || !rawData.response || !rawData.response.segments) {
      srtContent = 'No transcription data.';
    } else {
      const result = rawData.response;
      srtContent = convertWordsToSRT(result.segments);
      if (result.errors && result.errors.length > 0) {
        srtContent += '\\n\\n[警告] ' + result.errors.length + '/' + result.chunkCount + ' 个块处理失败';
      }
    }

    hideProgress();
    resultBox.value = srtContent;
    downloadBtn.disabled = false;
  } catch (error) {
    progressContainer.style.display = 'none';
    resultBox.value = 'Error: ' + error.message;
    downloadBtn.disabled = true;
  }
});

// URL 转写
document.getElementById('urlSubmitBtn').addEventListener('click', async () => {
  const audioUrl = document.getElementById('audioUrl').value.trim();
  if (!audioUrl) return alert('请输入音频 URL');

  showProgress();
  progressText.textContent = '正在下载并转写远程音频...';

  const task = document.getElementById('task').value;
  const language = document.getElementById('language').value;
  const initial_prompt = document.getElementById('initial_prompt').value;
  const prefix = document.getElementById('prefix').value;
  const vad_filter = document.getElementById('vad_filter').checked;

  const baseParams = new URLSearchParams({
    task,
    ...(language && { language }),
    ...(initial_prompt && { initial_prompt }),
    ...(prefix && { prefix }),
    vad_filter: vad_filter.toString(),
    url: audioUrl
  });

  try {
    const response = await fetch('/url?' + baseParams.toString());
    if (!response.ok) {
      const error = await response.text();
      resultBox.value = 'Error: ' + error;
      progressContainer.style.display = 'none';
      return;
    }
    const data = await response.json();
    srtContent = convertWordsToSRT(data.segments || []);
    if (data.errors && data.errors.length > 0) {
      srtContent += '\\n\\n[警告] ' + data.errors.length + '/' + data.chunkCount + ' 个块处理失败';
    }
    hideProgress();
    resultBox.value = srtContent;
    downloadBtn.disabled = false;
  } catch (error) {
    progressContainer.style.display = 'none';
    resultBox.value = 'Error: ' + error.message;
    downloadBtn.disabled = true;
  }
});

// 下载 SRT
downloadBtn.addEventListener('click', () => {
  const fileName = (document.getElementById('audioFile').files[0]?.name || document.getElementById('audioUrl').value.split('/').pop() || 'subtitles').replace(/\\.[^/.]+$/, '') + '.srt';
  const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
});
</script>
</body>
</html>`;
