// 通过真正加载的扩展和本机接口验收；不访问外部提交站点。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {EXPECTED, REPO, launchBrowser, openFixture, startEnvironment, statusOf} from './support.mjs';
let env, browser;
before(async () => { env = await startEnvironment(); browser = await launchBrowser(env); }, {timeout: 120000});
after(async () => { await browser?.context.close(); await env?.stop(); await env?.cleanup(); });

test('扩展整链路：跨平台字段 + 按钮式 portal 下拉，写入业务值而非仅输入搜索词', async () => {
  const {page} = await openFixture(browser.context, 'stable-controls.html');
  try {
    assert.equal(await page.locator('#product').inputValue(), EXPECTED.name);
    assert.equal(await page.locator('#website').inputValue(), EXPECTED.url);
    assert.equal(await page.locator('#business').inputValue(), 'Utilities');
    assert.deepEqual(await page.evaluate(() => [window.wrongClicks, window.enterCount, window.submitCount]), [0, 0, 0]);
    assert.equal((await statusOf(page)).decisions.find(x => x.label === 'Category').status, 'filled');
    await mkdir(path.join(REPO, 'docs/screenshots/iteration'), {recursive: true});
    for (const width of [1440, 375]) {
      await page.setViewportSize({width, height: 900});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({path: path.join(REPO, `docs/screenshots/iteration/stable-controls-${width}.png`)});
    }
  } finally { await page.close(); }
});

test('扩展整链路：搜索文字存在但未提交选项，必须待确认，不能假报已填', async () => {
  const {page} = await openFixture(browser.context, 'stable-controls.html', {query: '?mode=broken'});
  try {
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.bkStatus || '{}')
      .decisions?.find(x => x.label === 'Category')?.reason === 'selection_unverified', null, {timeout: 10000});
    assert.equal(await page.locator('#business').inputValue(), '');
    assert.equal((await statusOf(page)).decisions.find(x => x.label === 'Category').status, 'pending');
    assert.deepEqual(await page.evaluate(() => [window.wrongClicks, window.enterCount, window.submitCount]), [0, 0, 0]);
  } finally { await page.close(); }
});

test('受控字段异步拒绝写入后显示待确认，不沿用瞬间读值的已填状态', async () => {
  const {page} = await openFixture(browser.context, 'stable-controls.html', {query: '?mode=rollback'});
  try {
    assert.equal(await page.locator('#product').inputValue(), '');
    const decision = (await statusOf(page)).decisions.find(x => x.label === 'Product name');
    assert.equal(decision.status, 'pending');
    assert.equal(decision.reason, 'readback_mismatch');
  } finally { await page.close(); }
});
