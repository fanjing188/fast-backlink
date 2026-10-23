#!/usr/bin/env node
// 生成扩展图标：同一份 SVG 标记渲染成 16/32/48/128/256/512 的 PNG。
// 用法：node tools/make-icons.mjs
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 128, 256, 512];
// 书签链：已保存的来源资产可以再次复用。SVG是唯一原件，避免页面和工具栏漂移。
const MARK = await readFile(path.join(OUT, 'mark.svg'), 'utf8');

async function main() {
  await mkdir(OUT, {recursive: true});
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 128, height: 128}, deviceScaleFactor: 1});
  const written = [];
  for (const size of SIZES) {
    const svg = MARK.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setViewportSize({width: size, height: size});
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`);
    const file = path.join(OUT, `icon-${size}.png`);
    await page.screenshot({path: file, omitBackground: true, clip: {x: 0, y: 0, width: size, height: size}});
    written.push(file);
  }

  await browser.close();
  console.log(JSON.stringify({written, sizes: SIZES}, null, 2));
}

main().catch(error => {console.error(error); process.exit(1);});
