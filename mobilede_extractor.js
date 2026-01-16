import { chromium } from 'patchright';
import fs from 'fs';
import path from 'path';

const [,, modelName, modelCode, proxy] = process.argv;

const outputDir = path.join(__dirname, 'input');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

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
  // プロキシの設定（必要に応じて）
  const launchOptions = {
    channel: 'chrome',
    headless: false
  };
  if (proxy) {
    launchOptions.proxy = { server: proxy };
  }

  const browser = await chromium.launchPersistentContext('', launchOptions);
  const carList = [];

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const page = await browser.newPage();
    const url = SEARCH_URL_BASE
      .replace('{car_model}', modelCode)
      .replace('{PAGE}', pageNum);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.click('button[data-testid="uc-accept-all-button"]', { timeout: 3000 }).catch(() => {});
      await page.waitForSelector('div.mN_WC', { timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
      const cars = await extractCarDataFromPage(page);

      carList.push(...cars);

      await page.close();
      if (cars.length === 0) break;
    } catch (err) {
      await page.close();
      process.exit(1); // batchRunner.jsが進捗管理
    }
  }

  await browser.close();
  fs.writeFileSync(path.join(outputDir, `${modelName}.json`), JSON.stringify(carList, null, 2));
  process.exit(0); // batchRunner.jsが進捗管理
})();
