# Mobile.de スクレイパー

Mobile.de の検索結果から詳細ページの URL を抽出し、その詳細情報をスクレイピングして CSV に出力するための Node.js スクリプト群です。


## スクリプト構成

- `mobilede_extractor.js`  
  検索結果ページから車両詳細ページの URL を一覧抽出します。

- `mobilede_main.js`  
  `mobilede_extractor.js` で取得した詳細ページ URL を基に、各ページをスクレイピングし、結果を CSV に出力します。


## 前提環境

- Node.js 18 以上
- npm もしくは yarn

## インストール

```bash
git clone https://github.com/Cotin1029/mobilede_scraper.git
cd mobilede_scraper
npm install


## 実行方法

```bash
# 1.詳細ページの URL を一覧抽出
node mobilede_extractor.js 

# 2.ページ URLをスクレイピングし、CSV作成
node mobilede_main.js

## 注意事項

- Mobile.de の利用規約・robots.txt を確認した上で利用してください。
- アクセス頻度が高すぎるとブロックされる可能性があります。必要に応じてディレイやプロキシを設定してください。


---

# Mobile.de Scraper (English)

This project provides Node.js scripts to extract vehicle detail URLs from Mobile.de search results and scrape each detail page into a CSV file.

## Scripts

- `mobilede_extractor.js`  
  Extracts vehicle detail page URLs from a search result page.

- `mobilede_main.js`  
  Scrapes each detail page based on the extracted URLs and exports the data as a CSV file.

## Requirements

- Node.js 18 or later
- npm or yarn

## Installation

```bash
git clone https://github.com/Cotin1029/mobilede_scraper.git
cd mobilede_scraper
npm install

##Usage
```bash
# 1.Extract detail URLs
node mobilede_extractor.js 

# 2.Scrape detail pages
node mobilede_main.js