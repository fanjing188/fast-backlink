import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser, openFixture, startEnvironment} from './support.mjs';

let env, browser;
before(async () => {
  env = await startEnvironment();
  browser = await launchBrowser(env);
}, {timeout: 180000});
after(async () => {
  await browser?.context.close();
  await env?.stop();
  await env?.cleanup();
});

async function shadowReader(page) {
  const cdp = await browser.context.newCDPSession(page);
  return {
    async nodes(selector) {
      const {root} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
      let shadow;
      const walk = node => {
        if (node.attributes?.includes('fast-backlink-layer')) shadow = node.shadowRoots?.[0];
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
      };
      walk(root);
      if (!shadow) return [];
      const {object} = await cdp.send('DOM.resolveNode', {nodeId: shadow.nodeId});
      const {result} = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true, arguments: [{value: selector}],
        functionDeclaration: `function (selector) { return [...this.querySelectorAll(selector)].map(node => {
          const r = node.getBoundingClientRect();
          return {text: node.textContent, pressed: node.getAttribute('aria-pressed'), value: node.value,
            x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom};
        }); }`
      });
      await cdp.send('Runtime.releaseObject', {objectId: object.objectId});
      return result.value;
    },
    async click(node) {await page.mouse.click(node.x + node.width / 2, node.y + node.height / 2);},
    async close() {await cdp.detach();}
  };
}

async function openPicker(page, reader, selector) {
  await page.focus(selector);
  await page.keyboard.press('Alt+f');
  let pop = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    pop = await reader.nodes('.pop');
    if (pop.length) return pop[0];
    await page.waitForTimeout(50);
  }
  assert.fail('真实扩展没有打开候选层');
}

test('封闭Shadow候选支持真实鼠标操作分类、搜索与填入，外部点击才关闭', async () => {
  const {page} = await openFixture(browser.context, 'plain.html');
  const reader = await shadowReader(page);
  try {
    await openPicker(page, reader, '#tagline');
    const textTab = (await reader.nodes('.pop .seg button')).find(node => node.text === '文本');
    await reader.click(textTab);
    assert.equal((await reader.nodes('.pop')).length, 1, '内部pointerdown不能被误判为外部点击');
    assert.equal((await reader.nodes('.pop .seg button')).find(node => node.text === '文本').pressed, 'true');
    await reader.click((await reader.nodes('.pop input[type=search]'))[0]);
    await page.keyboard.type('tagline');
    assert.equal((await reader.nodes('.pop input[type=search]'))[0].value, 'tagline');
    const value = (await reader.nodes('.pop .item .v'))[0];
    assert.ok(value?.text, '搜索后应有真实素材候选');
    await reader.click(value);
    await page.waitForFunction(expected => document.querySelector('#tagline').value === expected, value.text);
    assert.equal((await reader.nodes('.pop')).length, 0);
    await openPicker(page, reader, '#tagline');
    await page.locator('h1').click();
    assert.equal((await reader.nodes('.pop')).length, 0, '点击助手之外应关闭');
  } finally {await reader.close(); await page.close();}
});

test('滚动后的字段按钮和候选层使用视口坐标，不重复计入页面滚动', async () => {
  const {page} = await openFixture(browser.context, 'plain.html');
  const reader = await shadowReader(page);
  try {
    await page.setViewportSize({width: 375, height: 500});
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.locator('#hear').focus();
    await page.locator('#hear').evaluate(node => node.scrollIntoView({block: 'center'}));
    const target = await page.locator('#hear').boundingBox();
    assert.ok(await page.evaluate(() => scrollY > 0), '夹具必须实际发生页面滚动');
    let fab;
    for (let attempt = 0; attempt < 30; attempt++) {
      fab = (await reader.nodes('.fab'))[0];
      if (fab) break;
      await page.waitForTimeout(50);
    }
    assert.ok(fab, '聚焦字段应有素材按钮');
    assert.ok(Math.abs(fab.y - target.y - 3) <= 1, `字段按钮错位：${JSON.stringify({fab, target})}`);
    const pop = await openPicker(page, reader, '#hear');
    assert.ok(pop.y >= 0 && pop.bottom <= 501, `滚动后候选层落到屏外：${JSON.stringify(pop)}`);
  } finally {await reader.close(); await page.close();}
});

test('字段搜索支持连续输入，筛选和自动刷新保留焦点及选区', async () => {
  const {page: fixture} = await openFixture(browser.context, 'plain.html');
  await fixture.bringToFront();
  const panel = await browser.context.newPage();
  try {
    await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
    await panel.waitForSelector('[data-panel=form] .bk-item');
    const search = panel.getByRole('searchbox', {name: '搜索字段'});
    await search.pressSequentially('Website URL', {delay: 35});
    assert.equal(await search.inputValue(), 'Website URL');
    assert.equal(await search.evaluate(node => node === document.activeElement), true);
    assert.equal(await panel.locator('[data-panel=form] .bk-item').count(), 1);
    await search.evaluate(node => node.setSelectionRange(2, 7));
    await panel.waitForTimeout(1800);
    assert.deepEqual(await search.evaluate(node => ({focused: node === document.activeElement,
      start: node.selectionStart, end: node.selectionEnd, value: node.value})),
      {focused: true, start: 2, end: 7, value: 'Website URL'});
  } finally {await panel.close(); await fixture.close();}
});
