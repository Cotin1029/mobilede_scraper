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
const badProxiesPath = path.join(__dirname, 'bad_proxies.json');

const carModels = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
const allProxies = JSON.parse(fs.readFileSync(proxyListPath, 'utf-8'));

// 使えないプロキシのリストを読み込む
let badProxies = new Set();
if (fs.existsSync(badProxiesPath)) {
  badProxies = new Set(JSON.parse(fs.readFileSync(badProxiesPath, 'utf-8')));
}

// 使えるプロキシのみをフィルタリング
const proxies = allProxies.filter(proxy => !badProxies.has(proxy));

let progress = {};
if (fs.existsSync(progressPath)) {
  progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
}

function getRandomProxy() {
  if (proxies.length === 0) {
    throw new Error('利用可能なプロキシがありません。すべてのプロキシが無効の可能性があります。');
  }
  const proxy = proxies[Math.floor(Math.random() * proxies.length)];
  // プロキシにプロトコルプレフィックスがない場合は追加
  if (proxy && !proxy.startsWith('http://') && !proxy.startsWith('https://') && !proxy.startsWith('socks5://')) {
    return `http://${proxy}`;
  }
  return proxy;
}

function markProxyAsBad(proxy) {
  // プロトコルプレフィックスを除去して元の形式に戻す
  const originalProxy = proxy.replace(/^https?:\/\//, '');
  badProxies.add(originalProxy);
  fs.writeFileSync(badProxiesPath, JSON.stringify([...badProxies], null, 2));
  console.log(`[PROXY] Marked as bad: ${originalProxy}`);
  
  // 現在のプロキシリストからも削除
  const index = proxies.findIndex(p => p === originalProxy || p === proxy);
  if (index !== -1) {
    proxies.splice(index, 1);
  }
}

function runModelWithRetry(modelName, modelCode, retryCount = 0, maxRetries = 3) {
  if (progress[modelName] === 'done') {
    console.log(`[SKIP] ${modelName} is already done`);
    return;
  }

  // failedの場合は再実行
  if (progress[modelName] === 'failed' && retryCount === 0) {
    console.log(`[RETRY] Retrying ${modelName} (previously failed)`);
  }

  if (proxies.length === 0) {
    console.error(`[ERROR] No available proxies for ${modelName}`);
    progress[modelName] = 'failed';
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    return;
  }

  const proxy = getRandomProxy();
  console.log(`[START] Processing ${modelName} with proxy ${proxy}${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);

  const args = [
    path.join(__dirname, 'mobilede_extractor.js'),
    modelName,
    modelCode,
    proxy
  ];

  const proc = spawn('node', args, { stdio: 'inherit' });
  
  // タイムアウトタイマー（5分でタイムアウト）
  const timeout = setTimeout(() => {
    console.error(`[TIMEOUT] ${modelName} timed out after 5 minutes with proxy ${proxy}`);
    proc.kill('SIGTERM');
    markProxyAsBad(proxy);
    
    // リトライ可能なら別のプロキシで再試行
    if (retryCount < maxRetries && proxies.length > 0) {
      console.log(`[RETRY] Retrying ${modelName} with a different proxy...`);
      setTimeout(() => {
        runModelWithRetry(modelName, modelCode, retryCount + 1, maxRetries);
      }, 2000);
    } else {
      progress[modelName] = 'failed';
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    }
  }, 5 * 60 * 1000); // 5分

  proc.on('error', (err) => {
    clearTimeout(timeout);
    console.error(`[ERROR] Failed to start process for ${modelName}:`, err.message);
    markProxyAsBad(proxy);
    
    // リトライ可能なら別のプロキシで再試行
    if (retryCount < maxRetries && proxies.length > 0) {
      console.log(`[RETRY] Retrying ${modelName} with a different proxy...`);
      setTimeout(() => {
        runModelWithRetry(modelName, modelCode, retryCount + 1, maxRetries);
      }, 2000);
    } else {
      progress[modelName] = 'failed';
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    }
  });

  proc.on('exit', (code) => {
    clearTimeout(timeout);
    if (code === 0) {
      console.log(`[SUCCESS] ${modelName} completed successfully`);
      progress[modelName] = 'done';
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    } else {
      console.error(`[FAILED] ${modelName} exited with code ${code} using proxy ${proxy}`);
      markProxyAsBad(proxy);
      
      // リトライ可能なら別のプロキシで再試行
      if (retryCount < maxRetries && proxies.length > 0) {
        console.log(`[RETRY] Retrying ${modelName} with a different proxy...`);
        setTimeout(() => {
          runModelWithRetry(modelName, modelCode, retryCount + 1, maxRetries);
        }, 2000);
      } else {
        progress[modelName] = 'failed';
        fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      }
    }
  });
}

// 同時実行する（すべてのモデルを並列で処理、各モデルはプロキシ失敗時に自動リトライ）
for (const [modelName, modelCode] of Object.entries(carModels)) {
  runModelWithRetry(modelName, modelCode);
}
