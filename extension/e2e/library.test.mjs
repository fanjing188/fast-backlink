// 页面渲染/交互夹具：file:// + 合成 chrome 消息，不启动服务、不读取真实产品/来源。
// 这不是持久化、background 桥接或真实扩展验收。父会话集成后须另跑真实扩展链路。
// 定向执行：node --test extension/e2e/library.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

let browser;
before(async () => { browser = await chromium.launch({headless: true}); });
after(async () => { await browser?.close(); });
const url = new URL('../library.html', import.meta.url);
url.searchParams.set('site', 'alpha');

async function openFixture(options = {}) {
  const context = await browser.newContext({viewport: {width: options.width || 375, height: 900}, colorScheme: options.theme || 'light', hasTouch: true});
  await context.addInitScript(() => {
    window.__messages = [];
    window.__mode = 'normal';
    const item = {domain: 'a-very-long-platform-name-that-still-needs-a-readable-row.example',
      submit_url: 'https://directory.example/submit', scenario: 'directory', admission: '可投', reuse_state: 'ready',
      reasons: ['请人工核对当前产品是否仍符合目录规则'], dr: null, dr_date: '', fee: '', login: '', backlink: '',
      has_recipe: true, previous_sites: ['old-product'], history: [{site: 'old-product', status: 'outcome_unknown'}], last_checked_at: '', note: '合成夹具，不是实际平台或提交记录。'};
    window.__items = [item, {...item, domain: 'review.example', admission: '待核实', reuse_state: 'needs_review', has_recipe: false}];
    Object.defineProperty(window, 'chrome', {configurable: true, value: {runtime: {sendMessage: async message => {
      window.__messages.push(message);
      if (message.type === 'sites') return {value: ['alpha', 'beta-with-a-long-product-name']};
      if (message.type === 'library:open') return {value: {tabId: 3}};
      if (message.type === 'library:save') {
        const saved = {...message.record, reuse_state: 'needs_review', reasons: [], has_recipe: false, previous_sites: [], history: []};
        window.__items = [saved, ...window.__items.filter(item => item.domain !== saved.domain)];
        return {value: {saved: true}};
      }
      if (message.type === 'library:list') {
        if (window.__mode === 'error') return {error: '夹具：本机服务断开，请检查连接'};
        if (window.__mode === 'loading') return new Promise(resolve => { window.__release = () => resolve({value: {items: [], counts: {total: 0, confirmed: 0, ready: 0, needs_review: 0, already_submitted: 0, blocked: 0}, site: message.site}}); });
        let items = window.__mode === 'empty' ? [] : window.__items;
        const counts = {total: items.length, confirmed: items.filter(item => item.admission === '可投').length,
          ready: message.site ? items.filter(item => item.reuse_state === 'ready').length : 0,
          needs_review: items.filter(item => item.reuse_state === 'needs_review').length, already_submitted: 0, blocked: 0};
        if (message.q) items = items.filter(item => JSON.stringify(item).toLowerCase().includes(message.q.toLowerCase()));
        if (message.status === 'confirmed') items = items.filter(item => item.admission === '可投');
        else if (message.status !== 'all') items = items.filter(item => item.reuse_state === message.status);
        if (message.scenario) items = items.filter(item => item.scenario === message.scenario);
        return {value: {items, counts, site: message.site}};
      }
      return {error: `夹具不支持的消息：${message.type}`};
    }}}});
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url.href);
  await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false');
  return {page, context, errors};
}

for (const width of [320, 375, 480, 1440]) {
  for (const theme of ['light', 'dark']) {
    test(`合成页面 ${width}px / ${theme}：清单、长域名、表单无横向溢出，动作按网格对齐`, async () => {
      const {page, context, errors} = await openFixture({width, theme});
      try {
        assert.equal(await page.locator('article.platform').count(), 2);
        assert.equal(await page.locator('[data-action=fill]').first().isEnabled(), true);
        assert.equal(await page.locator('[data-action=fill]').nth(1).isEnabled(), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const actionBoxes = await page.locator('article.platform').first().locator('button').evaluateAll(buttons => buttons.map(button => {
          const {x, y, width, height} = button.getBoundingClientRect(); return {x, y, width, height};
        }));
        assert.equal(actionBoxes[0].y, actionBoxes[1].y);
        assert.ok(Math.abs(actionBoxes[0].width - actionBoxes[1].width) <= 1);
        await page.locator('article.platform').first().locator('summary').click();
        assert.match(await page.locator('article.platform').first().innerText(), /结果未知/);
        await page.getByRole('button', {name: '新增平台', exact: true}).click();
        assert.equal(await page.locator('#record-admission').inputValue(), '待核实');
        assert.equal(await page.locator('#fit-options input:checked').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok(await page.locator('#record-domain').evaluate(input => parseFloat(getComputedStyle(input).fontSize) >= 16));
        await page.locator('#cancel-edit').click();
        await page.locator('#site').focus();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'site');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
}

test('合成页面：筛选、填写/查看消息、保存读回、JSON 下载与错误恢复', async () => {
  const {page, context, errors} = await openFixture();
  try {
    await page.locator('[data-action=fill]').first().click();
    await page.waitForFunction(() => window.__messages.some(message => message.type === 'library:open'));
    const open = await page.evaluate(() => window.__messages.find(message => message.type === 'library:open'));
    assert.equal(open.fill, true); assert.equal(open.site, 'alpha');
    await page.locator('#status').selectOption('needs_review');
    await page.waitForFunction(() => document.querySelectorAll('article.platform').length === 1);
    await page.locator('[data-action=view]').click();
    assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'library:open').at(-1).fill), false);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let text = ''; for await (const chunk of stream) text += chunk;
    const exported = JSON.parse(text);
    assert.equal(exported.scope, 'current_list'); assert.equal(exported.items.length, 1);
    assert.equal(exported.filters.status, 'needs_review');
    await page.locator('#add').click();
    await page.locator('#record-domain').fill('new.example');
    await page.locator('#record-url').fill('https://new.example/submit');
    await page.locator('#record-note').fill('合成保存读回测试');
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#form-status').textContent.includes('已保存并读回'));
    assert.equal(await page.evaluate(() => window.__messages.find(message => message.type === 'library:save').record.admission), '待核实');
    await page.evaluate(() => { window.__mode = 'error'; });
    await page.locator('#reload').click();
    await page.waitForFunction(() => !document.querySelector('#notice').hidden);
    assert.match(await page.locator('#notice').innerText(), /夹具：本机服务断开/);
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.evaluate(() => { window.__mode = 'loading'; });
    await page.locator('#reload').click();
    await page.waitForFunction(() => typeof window.__release === 'function');
    assert.match(await page.locator('#results').innerText(), /正在读取/);
    await page.evaluate(() => window.__release());
    await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false');
    assert.match(await page.locator('#results').innerText(), /没有符合筛选的平台/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
