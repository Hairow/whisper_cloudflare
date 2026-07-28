const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'umd');
const dest = path.join(__dirname, '..', 'public', 'ffmpeg-umd');

fs.mkdirSync(dest, { recursive: true });

for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.js')) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
    console.log('Copied:', file);
  }
}

console.log('ffmpeg UMD files copied to public/ffmpeg-umd/');
