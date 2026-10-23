import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {REPO, launchBrowser, openFixture, startEnvironment} from './support.mjs';

let env, browser;
const directory = process.env.FB_MEDIA_EVIDENCE || path.join(REPO, 'docs/screenshots/media');
const evidence = [];
before(async () => {
  await mkdir(directory, {recursive: true});
  env = await startEnvironment();
  // 仅扩充隔离资料，覆盖无分隔长文件名与超长截图；不读取真实产品素材。
  const logo = env.kit.assets[0];
  const filename = 'product-logo-with-a-very-long-unbroken-filename-'.repeat(4) + '.png';
  await copyFile(path.join(env.root, 'kits/probekits/assets', logo.file), path.join(env.root, 'kits/probekits/assets', filename));
  logo.file = filename;
  browser = await launchBrowser(env);
  const page = await browser.context.newPage();
  for (const [key, w, h] of [['cover', 2400, 400], ['maker_avatar', 400, 2400]]) {
    const data = await page.evaluate(([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const context = canvas.getContext('2d');
      context.fillStyle = '#315fc7'; context.fillRect(0, 0, w, h);
      return canvas.toDataURL('image/png').split(',')[1];
    }, [w, h]);
    const bytes = Buffer.from(data, 'base64');
    await writeFile(path.join(env.root, 'kits/probekits/assets', `${key}.png`), bytes);
    env.kit.assets.push({id: key, key, file: `${key}.png`, mime: 'image/png', w, h, bytes: bytes.length, alt: key});
  }
  await page.close();
  await writeFile(path.join(env.root, 'kits/probekits/kit.json'), JSON.stringify(env.kit));
}, {timeout: 180000});
after(async () => {
  await writeFile(path.join(directory, 'geometry.json'), JSON.stringify(evidence, null, 2));
  await browser?.context.close();
  await env?.stop();
  await env?.cleanup();
});

async function options(t) {
  const page = await browser.context.newPage();
  t.after(() => page.close());
  await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
  await page.waitForSelector('#group-media .media');
  await page.waitForFunction(() => [...document.querySelectorAll('#group-media img')].every(image => image.complete && image.naturalWidth > 0));
  return page;
}

test('素材预览不被原图撑大，长文件名不挤占按钮或产生页面溢出', {timeout: 60000}, async t => {
  const page = await options(t);
  assert.ok((await page.locator('#group-media .name').first().innerText()).length > 100, '长文件名必须实际进入素材卡片');
  for (const width of [1440, 375, 320, 480]) for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({width, height: width === 1440 ? 900 : 640});
    await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
    await page.locator('#group-media').evaluate(node => node.scrollIntoView({block: 'start'}));
    const geometry = await page.evaluate(() => {
      const rect = node => {const r = node.getBoundingClientRect(); return {x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height};};
      return {
        width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth,
        main: rect(document.querySelector('#editor')),
        cards: [...document.querySelectorAll('#group-media .media')].map(card => ({
          card: rect(card), thumb: rect(card.querySelector('.thumb')), info: rect(card.querySelector('.info')),
          media: card.querySelector('img, video') ? rect(card.querySelector('img, video')) : null,
          bar: rect(card.querySelector('.bar')), buttons: [...card.querySelectorAll('button')].map(rect),
        })),
      };
    });
    const name = `media-${width}-${colorScheme}`;
    evidence.push({name, ...geometry});
    await page.screenshot({path: path.join(directory, `${name}.png`)});
    assert.equal(geometry.cards.length, 8, '八类素材不能被布局修改漏掉');
    assert.ok(geometry.overflow <= 1, `${name} 页面溢出：${JSON.stringify(geometry)}`);
    assert.ok(geometry.main.bottom <= geometry.height + 1, `${name} 编辑区必须在窗口内独立滚动`);
    for (const item of geometry.cards) {
      assert.ok(item.thumb.height <= 121, `${name} 缩略图过大：${JSON.stringify(item)}`);
      assert.ok(item.card.x >= 0 && item.card.right <= width + 1, `${name} 卡片越界`);
      assert.ok(item.thumb.bottom <= item.info.y + 1 && item.info.bottom <= item.bar.y + 1, `${name} 预览/信息/操作区重叠`);
      if (item.media) assert.ok(item.media.bottom <= item.thumb.bottom + 1 && item.media.right <= item.thumb.right + 1, `${name} 图片或视频超出预览框`);
      for (const button of item.buttons) assert.ok(button.height >= 32 && button.y >= item.bar.y - 1 && button.bottom <= item.card.bottom + 1, `${name} 按钮被裁切`);
    }
    // 原生指针命中与点击：不能只凭矩形断言图片没有盖住按钮。
    for (const button of await page.locator('#group-media .bar button').all()) {
      await button.scrollIntoViewIfNeeded();
      await button.click({trial: true});
    }
  }
  for (const colorScheme of ['light', 'dark']) {
    await page.setViewportSize({width: 375, height: 900});
    await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
    await page.locator('#group-media').evaluate(node => node.scrollIntoView({block: 'start'}));
    await page.screenshot({path: path.join(directory, `media-375-tall-${colorScheme}.png`)});
  }
});

test('窄屏素材操作仍可用：替换/上传选文件、键盘聚焦与移除取消', {timeout: 45000}, async t => {
  const page = await options(t);
  await page.setViewportSize({width: 375, height: 640});
  const logo = page.locator('#group-media .media').first();
  for (const button of [logo.getByRole('button', {name: '替换'}), page.locator('#group-media .missing').first().getByRole('button', {name: '上传'})]) {
    const chooser = page.waitForEvent('filechooser');
    await button.click();
    assert.equal((await chooser).isMultiple(), false);
  }
  await logo.getByRole('textbox').focus();
  await page.keyboard.press('Tab');
  assert.equal(await logo.getByRole('button', {name: '替换'}).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await logo.getByRole('button', {name: '移除 品牌标志'}).evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.locator('dialog').waitFor({state: 'visible'});
  await page.getByRole('button', {name: '取消', exact: true}).click();
  assert.equal(await logo.locator('img').count(), 1, '取消不能改变素材');
});

test('侧栏素材使用同一预览约束，操作行不继承进度条的裁切', {timeout: 45000}, async t => {
  const {page: fixture} = await openFixture(browser.context, 'plain.html');
  t.after(() => fixture.close());
  await fixture.bringToFront();
  const page = await browser.context.newPage();
  t.after(() => page.close());
  await page.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await page.locator('nav [data-tab=assets]').click();
  await page.waitForSelector('.bk-asset');
  for (const width of [320, 375, 480]) {
    await page.setViewportSize({width, height: 640});
    const failures = await page.locator('.bk-asset').evaluateAll(cards => cards.flatMap(card => {
      const preview = card.querySelector('.thumb').getBoundingClientRect();
      const bar = card.querySelector('.bar').getBoundingClientRect();
      return [...card.querySelectorAll('.bar button')].filter(button => {
        const r = button.getBoundingClientRect();
        return preview.height > 121 || r.y < preview.bottom || r.bottom > bar.bottom + 1;
      }).map(button => button.textContent || button.getAttribute('aria-label'));
    }));
    assert.deepEqual(failures, [], `${width} 侧栏素材操作行必须完整显示`);
    for (const button of await page.getByRole('button', {name: '复制文件名'}).all()) await button.click({trial: true});
  }
});
