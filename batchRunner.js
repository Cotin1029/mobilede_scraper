import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// ESモジュール用の__filename, __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const modelsPath = path.join(__dirname, 'models.json');
const proxyListPath = path.join(__dirname, 'proxies.json');
const progressPath = path.join(__dirname, 'progress.json');

const carModels = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
const proxies = JSON.parse(fs.readFileSync(proxyListPath, 'utf-8'));
let progress = {};
if (fs.existsSync(progressPath)) {
  progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
}

for (const [modelName, modelCode] of Object.entries(carModels)) {
  if (progress[modelName] === 'done') continue; // 既に取得済みならスキップ

  const proxy = proxies[modelName] || ''; // models/proxies 紐付け可能。なければ空

  const args = [
    path.join(__dirname, 'extractor.js'),
    modelName,
    modelCode,
    proxy
  ];

  // NodeJSサブプロセスでextractor.js呼び出し
  const proc = spawn('node', args, { stdio: 'inherit' });

  proc.on('exit', code => {
    if (code === 0) {
      progress[modelName] = 'done';
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    } else {
      progress[modelName] = 'failed';
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      console.error(`[${modelName}] スクレイプ失敗。手動再開可能です。`);
    }
  });
}
