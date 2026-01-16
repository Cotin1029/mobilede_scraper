import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// 出力先ディレクトリを作成（存在しない場合は再帰的に作成）
const outputDir = path.resolve('./output');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// 収集対象のデータ項目を定義（この順番でCSVに書き込む）
const HEADERS = [
  'car_name', 'price', 'maker', 'image', 'detail_url',
  'first_registration', 'mileage', 'power', 'cubic_capacity', 'fuel',
  'transmission', 'drive_type', 'colour', 'number_of_seats',
  'door_count', 'weight', 'cylinders', 'tank_capacity'
];

// 車リスト（スクレイピング対象URL群）をinputフォルダ内のすべてのJSONファイルから読み込み
function loadAllJsonFiles() {
  const inputDir = path.resolve('./input');
  const allData = [];
  
  // inputフォルダ内のすべてのファイルを取得
  const files = fs.readdirSync(inputDir);
  const jsonFiles = files.filter(file => file.endsWith('.json'));
  
  console.log(`見つかったJSONファイル: ${jsonFiles.length}個`);
  
  for (const file of jsonFiles) {
    const filePath = path.join(inputDir, file);
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const jsonData = JSON.parse(fileContent);
      
      if (Array.isArray(jsonData)) {
        allData.push(...jsonData);
        console.log(`${file}: ${jsonData.length}件のデータを読み込みました`);
      } else {
        console.warn(`${file}: 配列形式ではありません。スキップします。`);
      }
    } catch (error) {
      console.error(`${file}の読み込みエラー:`, error.message);
    }
  }
  
  return allData;
}

const carList = loadAllJsonFiles();
console.log(`合計 ${carList.length}件の車両データを読み込みました`);
const results = []; // 最終的に保存する車両情報一覧

// プロキシはproxies.jsonから読み込む
const proxyList = JSON.parse(fs.readFileSync('./proxies.json', 'utf8'));

let proxyIndex = 0;

//次のプロキシを取得する（ラウンドロビン方式）
function getNextProxy() {
  if (proxyList.length === 0) {
    throw new Error('利用可能なプロキシがありません');
  }
  const currentIndex = proxyIndex;
  const proxy = proxyList[currentIndex];
  proxyIndex = (proxyIndex + 1) % proxyList.length;
  return { proxy, index: currentIndex };
}

//指定されたインデックスのプロキシを除外
function removeProxyByIndex(index) {
  if (proxyList.length > 0 && index >= 0 && index < proxyList.length) {
    proxyList.splice(index, 1);
    // 削除後、インデックスを調整
    if (proxyIndex > index) {
      proxyIndex--;
    }
    if (proxyIndex >= proxyList.length) {
      proxyIndex = 0;
    }
  }
}

// 人間らしく見せるための処理

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

//マウスをランダムに移動
function randomMouseMove(page) {
  const x = 100 + Math.random() * 800;
  const y = 100 + Math.random() * 500;
  return page.mouse.move(x, y, { steps: 10 });
}

//ページをランダムにスクロール
function randomScroll(page) {
  const scrollY = 300 + Math.random() * 1200;
  return page.mouse.wheel(0, scrollY);
}

//Cookieバナーや同意ダイアログを処理する
async function handleConsentModal(page) {
  try {
    const selectors = [
      'button[data-testid="uc-accept-all-button"]',
      'button[aria-label="Accept all"]',
      'button:has-text("Alle akzeptieren")',
      'button:has-text("Accept all")',
      'button:has-text("OK")',
      '#mde-consent-modal-dialog button',
      '#gdpr-consent-accept-button'
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await sleep(800 + Math.random() * 800);
        return; // 見つかった時点で終了
      }
    }
  } catch {}
}

// ページから車両情報を抽出

async function extractCarDetails(page) {
  return await page.evaluate(() => {
    function getDd(label) {
      const dts = Array.from(document.querySelectorAll('dt'));
      for (const dt of dts) {
        if (dt.textContent.trim().toLowerCase() === label.toLowerCase()) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName.toLowerCase() === 'dd') {
            return dd.textContent.trim();
          }
        }
      }
      return '';
    }

    // 車両仕様情報（<dt>/<dd> の組み合わせ）を取得
    return {
      first_registration: getDd('First registration'),
      mileage: getDd('Mileage'),
      power: getDd('Power'),
      cubic_capacity: getDd('Cubic capacity'),
      fuel: getDd('Fuel'),
      transmission: getDd('Transmission'),
      drive_type: getDd('Drive type'),
      colour: getDd('Colour'),
      number_of_seats: getDd('Number of seats'),
      door_count: getDd('Door count'),
      weight: getDd('Weight'),
      cylinders: getDd('Cylinders'),
      tank_capacity: getDd('Tank capacity')
    };
  });
}

//JSON化されたデータをCSVフォーマットに変換
function convertDataToCSV(carData) {
  const headerRow = HEADERS.join(',');
  const dataRows = carData.map(car => {
    const rowData = HEADERS.map(header => {
      let value = car[header];
      if (value === null || value === undefined) value = '';
      if (String(value).includes(',')) return `"${value}"`; // CSVエスケープ
      return value;
    });
    return rowData.join(',');
  });
  return [headerRow, ...dataRows].join('\n');
}

//CSVファイルとして保存
async function saveDataToCSV(carData) {
  const csvData = convertDataToCSV(carData);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(outputDir, `mobilede_output_${timestamp}.csv`);
  fs.writeFileSync(filename, '\ufeff' + csvData); // BOM付きで保存（Excel互換性向上）
  console.log(`CSVファイルを保存しました: ${filename}`);
}

// プロキシ付きでブラウザ起動（失敗したら次のプロキシでリトライ）
// mobilede_extractor.jsと同じシンプルなアプローチを採用
async function launchBrowserWithProxy(maxTries = proxyList.length) {
  let lastErr;
  for (let tries = 0; tries < maxTries; tries++) {
    if (proxyList.length === 0) throw new Error('利用可能なプロキシがありません');
    const { proxy, index } = getNextProxy();
    try {
      // mobilede_extractor.jsと同じシンプルな設定
      const launchOptions = {
        channel: 'chrome',
        headless: false
      };
      if (proxy) {
        launchOptions.proxy = { server: proxy };
      }
      
      // ブラウザ起動時のタイムアウトを30秒に設定（mobilede_extractor.jsと同じ）
      const context = await Promise.race([
        chromium.launchPersistentContext('', launchOptions),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout')), 30000))
      ]);
      
      return { context, proxy, proxyIndex: index };
    } catch (e) {
      console.warn(`プロキシ接続失敗: ${proxy} - 除外します`);
      removeProxyByIndex(index);
      lastErr = e;
    }
  }
  throw lastErr;
}

// アクセス拒否を検出する関数
function isAccessDenied(response) {
  if (!response) return false;
  const status = response.status();
  // 403 Forbidden, 429 Too Many Requests, 503 Service Unavailable などを検出
  return status === 403 || status === 429 || status === 503 || status === 401;
}

// 1台の車のデータを取得（プロキシを切り替えながらリトライ）
async function fetchCarDataWithRetry(car, maxRetries = proxyList.length) {
  let lastError = null;
  
  for (let retry = 0; retry < maxRetries; retry++) {
    if (proxyList.length === 0) {
      throw new Error('利用可能なプロキシがありません');
    }
    
    let context = null;
    let detailPage = null;
    let usedProxy = null;
    let usedProxyIndex = null;
    
    try {
      // プロキシを切り替えながらブラウザ起動
      const launchResult = await launchBrowserWithProxy();
      context = launchResult.context;
      usedProxy = launchResult.proxy;
      usedProxyIndex = launchResult.proxyIndex;

      detailPage = await context.newPage();

      // 車両詳細ページへ遷移（レスポンスを取得）
      // mobilede_extractor.jsと同じアプローチ：タイムアウト30秒、waitUntil: 'domcontentloaded'
      let response = null;
      try {
        response = await Promise.race([
          detailPage.goto(car.detail_url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 30000))
        ]);
        
        // アクセス拒否をチェック
        if (isAccessDenied(response)) {
          const status = response.status();
          console.warn(`アクセス拒否検出 (HTTP ${status}): ${car.detail_url} - プロキシ ${usedProxy} を除外してリトライします`);
          await detailPage.close().catch(() => {});
          if (context) await context.close();
          removeProxyByIndex(usedProxyIndex);
          continue; // 次のプロキシでリトライ
        }
      } catch (gotoErr) {
        console.warn(`ページ遷移エラー: ${car.detail_url} - プロキシ ${usedProxy} を除外してリトライします`, gotoErr.message);
        await detailPage.close().catch(() => {});
        if (context) await context.close();
        removeProxyByIndex(usedProxyIndex);
        lastError = gotoErr;
        continue; // 次のプロキシでリトライ
      }
      
      // Cookie同意モーダル処理（mobilede_extractor.jsと同じシンプルな方法）
      await detailPage.click('button[data-testid="uc-accept-all-button"]', { timeout: 3000 }).catch(() => {});
      
      // mobilede_extractor.jsと同じ短い待機時間（3-6秒）
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));

      // 車の詳細情報を抽出
      const details = await extractCarDetails(detailPage);
      Object.assign(car, details); // carオブジェクトにマージ
      
      // ページを閉じる（コンテキストは再利用可能）
      await detailPage.close().catch(() => {});
      // コンテキストは次のリクエストで再利用するため、ここでは閉じない
      // ただし、エラー時は閉じる必要がある
      return car; // 成功

    } catch (e) {
      console.warn(`エラー発生: ${car.detail_url} - プロキシ ${usedProxy || 'unknown'} を除外してリトライします`, e.message);
      await detailPage?.close().catch(() => {});
      if (context) await context.close();
      if (usedProxyIndex !== null && usedProxyIndex !== undefined) {
        removeProxyByIndex(usedProxyIndex);
      }
      lastError = e;
      // 次のプロキシでリトライを続ける
    }
  }
  
  // すべてのリトライが失敗した場合
  throw lastError || new Error('すべてのプロキシで失敗しました');
}

// メイン処理フロー

(async () => {
  for (let i = 0; i < carList.length; i++) {
    const car = carList[i];
    
    try {
      // プロキシを切り替えながらリトライしてデータを取得
      const carWithDetails = await fetchCarDataWithRetry(car);
      results.push(carWithDetails);
      console.log(`[${i + 1}/${carList.length}] 成功: ${car.car_name || car.detail_url}`);
    } catch (e) {
      console.error(`[${i + 1}/${carList.length}] 失敗: ${car.detail_url}`, e.message);
      // エラーが発生しても次の車に進む
    }

    // --- 次の車に移る前に待機（サイトBan対策）---
    const waitTime = Math.random() * 10000; 
    console.log(`待機中: ${Math.round(waitTime / 1000)}秒...`);
    await sleep(waitTime);
  }

  // 全件終了後にCSV出力
  await saveDataToCSV(results);
  console.log(`処理完了: ${results.length}/${carList.length}件のデータを取得しました`);
})();
