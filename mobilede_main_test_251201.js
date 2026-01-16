import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outputDir = path.resolve('./output');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// 🎯 **拡張：全項目CSVヘッダー**
const HEADERS = [
  'car_name', 'price', 'maker', 'image', 'detail_url',
  'vehicle_condition', 'category', 'model_range', 'availability',
  'mileage', 'cubic_capacity', 'drive_type', 'fuel',
  'number_of_seats', 'door_count', 'transmission', 'first_registration',
  'number_of_owners', 'hu', 'climatisation', 'airbags',
  'interior_design', 'cylinders'
];

const BATCH_SIZE = 50;
const SAVE_INTERVAL = 10;
const MAX_RETRIES_PER_URL = 3;

let failedUrls = [];
const failedUrlsFile = path.join(outputDir, 'failed_urls.json');

function loadFailedUrls() {
  try {
    if (fs.existsSync(failedUrlsFile)) {
      failedUrls = JSON.parse(fs.readFileSync(failedUrlsFile, 'utf8'));
      console.log(`失敗URL復元: ${failedUrls.length}件`);
    }
  } catch {}
}

function saveFailedUrls() {
  fs.writeFileSync(failedUrlsFile, JSON.stringify(failedUrls, null, 2), 'utf8');
}

let consecutiveEmpty = 0;
const MAX_CONSECUTIVE_EMPTY = 3;

function loadAllJsonFiles() {
  const inputDir = path.resolve('./input');
  if (!fs.existsSync(inputDir)) {
    console.error('❌ inputフォルダが存在しません');
    return [];
  }
  const allData = [];
  const files = fs.readdirSync(inputDir);
  const jsonFiles = files.filter(file => file.endsWith('.json'));
  
  console.log(`見つかったJSONファイル: ${jsonFiles.length}個`);
  for (const file of jsonFiles) {
    const filePath = path.join(inputDir, file);
    try {
      const jsonData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(jsonData)) {
        allData.push(...jsonData);
        console.log(`${file}: ${jsonData.length}件`);
      }
    } catch (e) {
      console.error(`${file} エラー:`, e.message);
    }
  }
  return allData;
}

const carList = loadAllJsonFiles();
console.log(`合計 ${carList.length}件読み込み完了`);
if (carList.length === 0) process.exit(1);

const proxyList = JSON.parse(fs.readFileSync('./proxies.json', 'utf8'));
let proxyIndex = 0;

let currentContext = null;
let currentProxyIndex = null;
let successCount = 0;
let saveCount = 0;

const csvFilePath = path.resolve(outputDir, `mobilede_output_${Date.now()}.csv`);
let isFirstWrite = true;
const progressFilePath = path.resolve(outputDir, 'progress.json');

loadFailedUrls();

function loadProgress() {
  try {
    if (fs.existsSync(progressFilePath)) {
      const data = JSON.parse(fs.readFileSync(progressFilePath, 'utf8'));
      console.log(`進捗復元: ${data.processed}/${carList.length}件`);
      return data.processed || 0;
    }
  } catch {}
  console.log('進捗ファイルなし → 0から開始');
  return 0;
}

function saveProgress(processedIndex) {
  fs.writeFileSync(progressFilePath, JSON.stringify({
    processed: processedIndex,
    timestamp: new Date().toISOString(),
    successCount,
    failedCount: failedUrls.length,
    totalCars: carList.length,
    csvFile: csvFilePath
  }, null, 2), 'utf8');
}

function getNextProxy() {
  if (proxyList.length === 0) throw new Error('プロキシなし');
  const index = proxyIndex;
  const proxy = proxyList[index];
  proxyIndex = (proxyIndex + 1) % proxyList.length;
  return { proxy, index };
}

function removeProxyByIndex(index) {
  if (index >= 0 && index < proxyList.length) {
    proxyList.splice(index, 1);
    if (proxyIndex > index) proxyIndex--;
    if (proxyIndex >= proxyList.length) proxyIndex = 0;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleConsentModal(page) {
  const selectors = [
    'button[data-testid="uc-accept-all-button"]',
    'button[aria-label="Accept all"]',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Accept all")',
    'button:has-text("OK")'
  ];
  for (const sel of selectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      await sleep(1000);
      return;
    } catch {}
  }
}

// 🎯 **拡張版：全17項目抽出**
async function extractCarDetails(page) {
  return await page.evaluate(() => {
    function getText(selector) {
      const el = document.querySelector(selector);
      return el ? el.textContent.trim() : '';
    }
    
    function getDdValue(labelText) {
      const dts = Array.from(document.querySelectorAll('dt'));
      for (const dt of dts) {
        if (dt.textContent.trim().toLowerCase().includes(labelText.toLowerCase())) {
          const dd = dt.nextElementSibling;
          if (dd?.tagName.toLowerCase() === 'dd') {
            return dd.textContent.trim();
          }
        }
      }
      return '';
    }
    
    function getDataGridValue(labelText) {
      const rows = Array.from(document.querySelectorAll('[data-testid*="vehicle-detail"] dt, .DataGrid dt'));
      for (const dt of rows) {
        if (dt.textContent.trim().toLowerCase().includes(labelText.toLowerCase())) {
          const dd = dt.nextElementSibling;
          return dd ? dd.textContent.trim() : '';
        }
      }
      return '';
    }
    
    return {
      vehicle_condition: getDdValue('Vehicle condition') || getDataGridValue('Vehicle condition'),
      category: getDdValue('Category') || getText('[data-testid="category"]'),
      model_range: getDdValue('Model range') || getText('.model-range'),
      availability: getDdValue('Availability') || getDataGridValue('Availability'),
      
      mileage: getDdValue('Mileage'),
      cubic_capacity: getDdValue('Cubic capacity'),
      drive_type: getDdValue('Drive type'),
      fuel: getDdValue('Fuel'),
      
      number_of_seats: getDdValue('Number of seats'),
      door_count: getDdValue('Door count'),
      transmission: getDdValue('Transmission'),
      first_registration: getDdValue('First registration'),
      
      number_of_owners: getDdValue('Number of vehicle owners') || getDataGridValue('Number of owners'),
      hu: getDdValue('HU') || getDataGridValue('HU'),
      climatisation: getDdValue('Climatisation'),
      airbags: getDdValue('Airbags'),
      
      interior_design: getDdValue('Interior design') || getDataGridValue('Interior'),
      cylinders: getDdValue('Cylinders')
    };
  });
}

function carToCsvRow(car) {
  return HEADERS.map(header => {
    let value = car[header] ?? '';
    const str = String(value).replace(/"/g, '""');
    return /[,\"\n]/.test(str) ? `"${str}"` : str;
  }).join(',');
}

function appendCarToCsv(car) {
  const row = carToCsvRow(car);
  try {
    if (isFirstWrite) {
      fs.writeFileSync(csvFilePath, '\ufeff' + HEADERS.join(',') + '\n' + row + '\n', 'utf8');
      isFirstWrite = false;
      console.log(`📄 CSVヘッダー作成（${HEADERS.length}項目）`);
    } else {
      fs.appendFileSync(csvFilePath, row + '\n', 'utf8');
    }
  } catch (e) {
    console.error('CSV書き込みエラー:', e.message);
  }
}

async function safeCloseContext() {
  if (!currentContext) return;
  console.log('🔄 コンテキスト終了...');
  try {
    const pages = currentContext.pages();
    for (const page of pages) await page.close().catch(() => {});
    await Promise.race([
      currentContext.close(),
      sleep(10000).then(() => console.warn('⚠️ コンテキストタイムアウト'))
    ]);
  } catch (e) {
    console.warn('コンテキスト終了エラー:', e.message);
  } finally {
    currentContext = null;
    currentProxyIndex = null;
    consecutiveEmpty = 0;
  }
}

async function getOrCreateContext() {
  if (currentContext) return { context: currentContext, proxyIndex: currentProxyIndex };
  
  const userDataDir = path.join(outputDir, `tmp_ctx_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  
  const result = await launchBrowserWithProxy(userDataDir);
  currentContext = result.context;
  currentProxyIndex = result.proxyIndex;
  return result;
}

async function launchBrowserWithProxy(userDataDir) {
  for (let i = 0; i < proxyList.length; i++) {
    const { proxy, index } = getNextProxy();
    try {
      const launchOptions = {
        headless: false,
        userDataDir,
        channel: 'chrome',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-extensions',
          '--no-first-run'
        ]
      };
      if (proxy) launchOptions.proxy = { server: proxy };

      const context = await Promise.race([
        chromium.launchPersistentContext(userDataDir, launchOptions),
        sleep(30000).then(() => { throw new Error('ブラウザ起動タイムアウト'); })
      ]);
      
      console.log(`✅ プロキシ成功: ${proxy}`);
      return { context, proxy, proxyIndex: index };
    } catch (e) {
      console.warn(`❌ プロキシ失敗 ${proxy}:`, e.message);
      removeProxyByIndex(index);
    }
  }
  throw new Error('全プロキシ失敗');
}

async function isAccessDenied(response) {
  if (!response) return false;
  try {
    const status = response.status();
    return [403, 429, 503, 401].includes(status);
  } catch {
    return false;
  }
}

async function fetchCarDataWithRetry(car, currentIndex) {
  let urlRetries = 0;
  
  while (urlRetries < MAX_RETRIES_PER_URL) {
    urlRetries++;
    console.log(`🔄 URLリトライ ${urlRetries}/${MAX_RETRIES_PER_URL}: ${car.detail_url}`);
    
    for (let proxyRetry = 0; proxyRetry < proxyList.length; proxyRetry++) {
      let detailPage = null;
      try {
        const { context } = await getOrCreateContext();
        detailPage = await context.newPage();

        const response = await Promise.race([
          detailPage.goto(car.detail_url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
          sleep(30000).then(() => { throw new Error('ページ読み込みタイムアウト'); })
        ]);

        if (await isAccessDenied(response)) {
          console.warn(`🚫 アクセス拒否 (${proxyRetry + 1}/${proxyList.length})`);
          await detailPage.close();
          continue;
        }

        const hasContent = await detailPage.waitForSelector('dt, dd, h1', { timeout: 8000 }).catch(() => false);
        if (!hasContent) {
          consecutiveEmpty++;
          console.warn(`🚫 コンテンツなし (${consecutiveEmpty}/${MAX_CONSECUTIVE_EMPTY})`);
          await detailPage.close();
          if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
            await safeCloseContext();
          }
          continue;
        }

        consecutiveEmpty = 0;
        await handleConsentModal(detailPage);
        await sleep(3000 + Math.random() * 2000); // 詳細項目用に延長
        
        const details = await extractCarDetails(detailPage);
        Object.assign(car, details);
        
        await detailPage.close();
        console.log(`✅ 全項目取得: ${car.car_name}`);
        return car;

      } catch (e) {
        console.warn(`💥 プロキシエラー ${proxyRetry + 1}/${proxyList.length}: ${e.message}`);
        await detailPage?.close().catch(() => {});
        if (e.message.includes('timeout') || e.message.includes('failed')) {
          await safeCloseContext();
        }
      }
    }
    await sleep(5000);
  }
  
  console.error(`💥 3回リトライ失敗 → スキップ: ${car.detail_url}`);
  failedUrls.push({
    url: car.detail_url,
    car_name: car.car_name || '不明',
    skippedAt: new Date().toISOString(),
    retries: MAX_RETRIES_PER_URL
  });
  saveFailedUrls();
  return null;
}

(async () => {
  const startIndex = loadProgress();
  console.log(`📍 開始: ${startIndex}/${carList.length} (${HEADERS.length}項目)`);

  try {
    for (let i = startIndex; i < carList.length; i++) {
      const car = carList[i];
      
      const result = await fetchCarDataWithRetry(car, i);
      
      if (result) {
        successCount++;
        saveCount++;
        appendCarToCsv(result);
        console.log(`✅ [${i + 1}/${carList.length}] ${result.car_name} (成功:${successCount})`);
      } else {
        console.log(`⏭️  [${i + 1}/${carList.length}] スキップ`);
      }
      
      if (saveCount >= SAVE_INTERVAL) {
        saveProgress(i + 1);
        saveCount = 0;
      }
      
      if ((i + 1) % BATCH_SIZE === 0) {
        console.log('🔄 定期リフレッシュ');
        await safeCloseContext();
      }
      
      await sleep(3000 + Math.random() * 3000);
    }
  } finally {
    await safeCloseContext();
    saveProgress(carList.length);
    saveFailedUrls();
  }
  
  console.log(`\n🎉 完了！`);
  console.log(`✅ 成功: ${successCount}/${carList.length}件`);
  console.log(`📋 失敗: ${failedUrls.length}件`);
  console.log(`📄 CSV: ${path.basename(csvFilePath)} (${HEADERS.length}項目)`);
})();
