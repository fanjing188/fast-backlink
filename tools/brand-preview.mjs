#!/usr/bin/env node
// 品牌图板的真实浏览器渲染；不加载扩展，不触及用户资料。
import {chromium} from 'playwright';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({deviceScaleFactor: 1});
  await page.goto(pathToFileURL(path.join(root, 'docs/brand/logo-review.html')).href);
  for (const width of [1440, 375]) {
    await page.setViewportSize({width, height: 900});
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) throw Error('Logo board overflows');
    await page.screenshot({path: path.join(root, `docs/brand/logo-review-${width}.png`), fullPage: true});
  }
  console.log('Logo board rendered at 1440 and 375; images loaded, no horizontal overflow.');
} finally {
  await browser.close();
}
