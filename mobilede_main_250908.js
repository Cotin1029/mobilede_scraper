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

// 車リスト（スクレイピング対象URL群）をJSONから読み込み
const carList = JSON.parse(fs.readFileSync('C:/Users/alexa/node.js/usedcarsales/car_urls.json', 'utf8'));
const results = []; // 最終的に保存する車両情報一覧

// プロキシはJSON形式のテキストファイルから読み込む想定
const proxyTxt = fs.readFileSync('./socks4_socks5_proxies.txt', 'utf8');
const proxyObj = JSON.parse(proxyTxt);
const proxyList = proxyObj.proxies.map(p => p.proxy);

let proxyIndex = 0;

//次のプロキシを取得する（ラウンドロビン方式）
function getNextProxy() {
  if (proxyList.length === 0) {
    throw new Error('利用可能なプロキシがありません');
  }
  const proxy = proxyList[proxyIndex];
  proxyIndex = (proxyIndex + 1) % proxyList.length;
  return proxy;
}

//現在失敗したプロキシを除外
function removeCurrentProxy() {
  if (proxyList.length > 0) {
    proxyList.splice(proxyIndex === 0 ? proxyList.length - 1 : proxyIndex - 1, 1);
    if (proxyIndex >= proxyList.length) proxyIndex = 0;
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
async function launchBrowserWithProxy(maxTries = proxyList.length) {
  let lastErr;
  for (let tries = 0; tries < maxTries; tries++) {
    if (proxyList.length === 0) throw new Error('利用可能なプロキシがありません');
    const proxy = getNextProxy();
    try {
      const browser = await chromium.launch({ headless: false, proxy: { server: proxy } });
      return { browser, proxy };
    } catch (e) {
      console.warn(`プロキシ接続失敗: ${proxy} - 除外します`);
      removeCurrentProxy();
      lastErr = e;
    }
  }
  throw lastErr;
}

// メイン処理フロー

(async () => {
  for (let i = 0; i < carList.length; i++) {
    const car = carList[i];
    let browser = null, detailPage = null;
    let usedProxy = null;

    try {
      // プロキシを切り替えながらブラウザ起動
      const launchResult = await launchBrowserWithProxy();
      browser = launchResult.browser;
      usedProxy = launchResult.proxy;

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
        timezoneId: 'Europe/Berlin'
      });

      // webdriver検知回避
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      detailPage = await context.newPage();

      // ページ遷移時のHTTPヘッダ追加
      await detailPage.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://suchen.mobile.de/fahrzeuge/search.html?con=USED&dam=false&isSearchRequest=true&vc=Car&lang=en'
      });

      // 人間っぽい挙動を追加
      await randomMouseMove(detailPage);
      await randomScroll(detailPage);
      await sleep(800 + Math.random() * 1200);

      // 車両詳細ページへ遷移
      try {
        await detailPage.goto(car.detail_url, { waitUntil: 'domcontentloaded' });
      } catch (gotoErr) {
        console.error(`詳細ページ取得エラー(page.goto): ${car.detail_url}`, gotoErr, `使用プロキシ: ${usedProxy}`);
        const errorFile = path.join(outputDir, `goto_error_${i + 1}_${Date.now()}.png`);
        await detailPage.screenshot({ path: errorFile, fullPage: true });
        continue; // 次の車種へスキップ
      }

      // GDPRバナー処理
      await handleConsentModal(detailPage);

      // さらに人間らしい挙動
      await randomMouseMove(detailPage);
      await randomScroll(detailPage);
      await sleep(1200 + Math.random() * 1500);

      // 車の詳細情報を抽出
      const details = await extractCarDetails(detailPage);
      Object.assign(car, details); // carオブジェクトにマージ
      results.push(car);

    } catch (e) {
      console.error(`致命的エラー: ${car.detail_url}`, e, `使用プロキシ: ${usedProxy}`);
      if (detailPage) {
        const errorFile = path.join(outputDir, `fatal_error_${i + 1}_${Date.now()}.png`);
        await detailPage.screenshot({ path: errorFile, fullPage: true });
      }

    } finally {
      if (browser) await browser.close(); // ブラウザを必ずクローズ
    }

    // --- 次の車に移る前に待機（サイトBan対策）---
    await sleep(300000); // 5分休憩
  }

  // 全件終了後にCSV出力
  await saveDataToCSV(results);
})();