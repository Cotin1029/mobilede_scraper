import { chromium } from 'patchright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const [,, modelName, modelCode, proxy] = process.argv;

const outputDir = path.join(__dirname, 'input');
const progressDir = path.join(__dirname, 'extraction_progress');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(progressDir)) fs.mkdirSync(progressDir, { recursive: true });

const SEARCH_URL_BASE =
  'https://suchen.mobile.de/fahrzeuge/search.html?con=USED&dam=false&fr=1900%3A2005&isSearchRequest=true&ms={car_model}&ref=srp&s=Car&vc=Car&pageNumber={PAGE}&lang=en';
const MAX_PAGES = 100;

async function extractCarDataFromPage(page) {
  return await page.evaluate(() => {
    const containers = document.querySelectorAll('div.mN_WC');
    return Array.from(containers).map(container => {
      const carNameElement = container.querySelector('span.eO87w');
      const priceElement = container.querySelector('span[data-testid="price-label"]');
      const imageElement = container.querySelector('img.Qj_9F');
      const linkElement = container.querySelector('a.FWtU1.YIC4W.rqEvz') || container.querySelector('a[data-testid^="result-listing-"]');
      const carName = carNameElement ? carNameElement.textContent.trim() : '';
      const maker = carName ? carName.split(' ')[0] : '';
      let detail_url = linkElement ? linkElement.getAttribute('href') : null;
      if (detail_url && !detail_url.startsWith('http')) {
        detail_url = 'https://suchen.mobile.de' + detail_url;
      }
      return {
        car_name: carName,
        maker: maker,
        price: priceElement ? priceElement.textContent.trim() : null,
        image: imageElement ? imageElement.getAttribute('src') : null,
        detail_url: detail_url
      };
    });
  });
}

(async () => {
  // プロキシの設定
  const launchOptions = {
    channel: 'chrome',
    headless: false
  };
  if (proxy) {
    launchOptions.proxy = { server: proxy };
  }

  console.log(`\n=== ${modelName} (${modelCode}) のスクレイピング開始 ===`);
  if (proxy) {
    console.log(`Using proxy: ${proxy}`);
  }

  // 進捗ファイルと出力ファイルのパス
  const progressFilePath = path.join(progressDir, `${modelName}_progress.json`);
  const outputPath = path.join(outputDir, `${modelName}.json`);

  // 既存のデータと進捗を読み込む
  let carList = [];
  let startPage = 1;
  let progressData = { lastPage: 0, totalCars: 0 };

  if (fs.existsSync(outputPath)) {
    try {
      const existingData = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      if (Array.isArray(existingData) && existingData.length > 0) {
        carList = existingData;
        console.log(`[RESUME] 既存のデータを読み込みました: ${carList.length} 件`);
      }
    } catch (err) {
      console.warn(`[WARN] 既存ファイルの読み込みに失敗しました: ${err.message}`);
    }
  }

  if (fs.existsSync(progressFilePath)) {
    try {
      progressData = JSON.parse(fs.readFileSync(progressFilePath, 'utf-8'));
      startPage = progressData.lastPage + 1;
      console.log(`[RESUME] ページ ${startPage} から再開します（最後に処理したページ: ${progressData.lastPage}）`);
    } catch (err) {
      console.warn(`[WARN] 進捗ファイルの読み込みに失敗しました: ${err.message}`);
    }
  }

  // ブラウザ起動時のタイムアウトを短縮（30秒）
  let browser;
  try {
    browser = await Promise.race([
      chromium.launchPersistentContext('', launchOptions),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout')), 30000))
    ]);
  } catch (err) {
    console.error(`[ERROR] Failed to launch browser for ${modelName}:`, err.message);
    // 既存のデータを保存してから終了
    if (carList.length > 0) {
      fs.writeFileSync(outputPath, JSON.stringify(carList, null, 2));
      console.log(`[SAVED] 既存のデータを保存しました: ${carList.length} 件`);
    }
    process.exit(1);
  }

  let consecutiveEmptyPages = 0;
  const MAX_CONSECUTIVE_EMPTY = 2; // 連続で2ページ空なら終了

  // 既に処理済みのページをスキップ
  for (let pageNum = startPage; pageNum <= MAX_PAGES; pageNum++) {
    const page = await browser.newPage();
    const url = SEARCH_URL_BASE
      .replace('{car_model}', modelCode)
      .replace('{PAGE}', pageNum);

    console.log(`Fetching page: ${pageNum} -> ${url}`);

    try {
      // タイムアウトを30秒に短縮（プロキシが無効な場合に早く検出）
      await Promise.race([
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 30000))
      ]);
      
      // Cookie同意モーダル処理（無ければスキップ）
      await page.click('button[data-testid="uc-accept-all-button"]', { timeout: 3000 }).catch(() => {});
      
      // 結果が非同期ロードされるのを待つ
      const hasContent = await page.waitForSelector('div.mN_WC', { timeout: 10000 }).catch(() => false);
      
      if (!hasContent) {
        console.error(`[ERROR] Page ${pageNum} did not load content properly`);
        consecutiveEmptyPages++;
        await page.close();
        if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY) {
          throw new Error('Multiple consecutive empty pages - proxy may be blocked or invalid');
        }
        continue;
      }
      
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
      const cars = await extractCarDataFromPage(page);

      console.log('Found:', cars.length, 'cars');

      if (cars.length === 0) {
        consecutiveEmptyPages++;
        await page.close();
        if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY) {
          break; // 正常な終了（データが終わった）
        }
        continue;
      }

      consecutiveEmptyPages = 0; // リセット
      carList.push(...cars);
      
      // 各ページ処理後にデータを保存（進捗を失わないように）
      fs.writeFileSync(outputPath, JSON.stringify(carList, null, 2));
      
      // 進捗を保存
      progressData = { lastPage: pageNum, totalCars: carList.length };
      fs.writeFileSync(progressFilePath, JSON.stringify(progressData, null, 2));
      
      await page.close();
    } catch (err) {
      console.error(`Error on ${modelName} page ${pageNum}:`, err.message);
      await page.close().catch(() => {});
      
      // エラーが発生しても、これまでに取得したデータを保存
      if (carList.length > 0) {
        fs.writeFileSync(outputPath, JSON.stringify(carList, null, 2));
        progressData = { lastPage: pageNum - 1, totalCars: carList.length };
        fs.writeFileSync(progressFilePath, JSON.stringify(progressData, null, 2));
        console.log(`[SAVED] エラー発生前に ${carList.length} 件のデータを保存しました`);
      }
      
      await browser.close().catch(() => {});
      process.exit(1); // batchRunner.jsが進捗管理（次のプロキシで再試行）
    }
  }

  await browser.close();
  
  // 進捗ファイルを削除（正常に完了した場合）
  if (fs.existsSync(progressFilePath)) {
    fs.unlinkSync(progressFilePath);
  }
  
  // 結果が空の場合もエラーとして扱う（プロキシがブロックされている可能性）
  if (carList.length === 0) {
    console.error(`[ERROR] No cars extracted for ${modelName} - proxy may be blocked`);
    fs.writeFileSync(outputPath, JSON.stringify([], null, 2));
    process.exit(1);
  }
  
  fs.writeFileSync(outputPath, JSON.stringify(carList, null, 2));
  console.log(`${modelName}: 抽出完了 (${carList.length} 件)`);
  process.exit(0); // batchRunner.jsが進捗管理
})();
