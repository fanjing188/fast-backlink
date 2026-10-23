// 真实扩展页验证原生select与刷新冲突；不把selectOption当作展开菜单的证据。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {KIT, REPO, launchBrowser, openFixture, startEnvironment} from './support.mjs';

let env, browser, context;
before(async () => {
  const second = structuredClone(KIT);
  second.site = 'secondproduct';
  second.fields.name = {value: 'Second Product'};
  second.fields.url = {value: 'https://second.example/'};
  env = await startEnvironment({additionalKits: [second]});
  browser = await launchBrowser(env, {ai_fallback: false});
  context = browser.context;
  context.setDefaultTimeout(10000);
}, {timeout: 120000});
after(async () => {
  await context?.close().catch(() => {});
  await env?.stop();
  await env?.cleanup();
});

async function setup() {
  await browser.worker.evaluate(() => chrome.storage.local.set({preferredSite: 'probekits'}));
  const {page: form} = await openFixture(context, 'plain.html');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await form.bringToFront();
  await panel.waitForFunction(() => document.querySelector('#site').options.length === 3);
  await panel.bringToFront();
  await panel.waitForFunction(() => document.querySelector('#site').value === 'probekits');
  return {form, panel};
}

async function preferred() {
  return browser.worker.evaluate(async () => (await chrome.storage.local.get('preferredSite')).preferredSite);
}

test('项目选择器聚焦时，状态刷新不重复写入原生select的值', async () => {
  const {form, panel} = await setup();
  try {
    await panel.locator('#site').focus();
    const writes = await panel.evaluate(async () => {
      const select = document.querySelector('#site');
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      const writes = [];
      Object.defineProperty(select, 'value', {configurable: true, get() {return descriptor.get.call(this);},
        set(value) {writes.push(value); descriptor.set.call(this, value);}});
      await refresh();
      return writes;
    });
    assert.deepEqual(writes, [], '向原生select回写同值也会打断展开中的菜单');
  } finally {
    await panel.close(); await form.close();
  }
});

test('切换项目可保存且不会被下一次状态刷新改回', async () => {
  const {form, panel} = await setup();
  try {
    await panel.selectOption('#site', 'secondproduct');
    await panel.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已保存默认项目：secondproduct'), null, {timeout: 6000});
    await panel.evaluate(() => refresh());
    assert.equal(await panel.locator('#site').inputValue(), 'secondproduct');
    assert.equal(await preferred(), 'secondproduct');
    const output = path.join(REPO, 'docs/screenshots/project-switch');
    await mkdir(output, {recursive: true});
    for (const width of [375, 1440]) {
      await panel.setViewportSize({width, height: 900});
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await panel.screenshot({path: path.join(output, `selected-${width}.png`)});
    }
  } finally {
    await panel.close(); await form.close();
  }
});

test('旧状态回包晚于项目切换完成时不能把选择改回原项目', async () => {
  const {form, panel} = await setup();
  try {
    await panel.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let hold = true;
      const gate = new Promise(resolve => {window.releaseOldState = resolve;});
      chrome.runtime.sendMessage = async message => {
        const result = await original(message);
        if (message.type === 'panel:state' && hold) {
          hold = false; window.oldStateHeld = true; await gate;
        }
        return result;
      };
      window.oldRefresh = refresh();
    });
    await panel.waitForFunction(() => window.oldStateHeld);
    await panel.selectOption('#site', 'secondproduct');
    await panel.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已保存默认项目：secondproduct'));
    await panel.locator('#settings').focus();
    await panel.evaluate(async () => {window.releaseOldState(); await window.oldRefresh;});
    assert.equal(await panel.locator('#site').inputValue(), 'secondproduct');
    assert.equal(await panel.evaluate(() => state.info.site), 'secondproduct');
    assert.equal(await preferred(), 'secondproduct');
  } finally {
    await panel.evaluate(() => window.releaseOldState?.()).catch(() => {});
    await panel.close(); await form.close();
  }
});

test('项目正在保存时，轮询不把已选项目改回，完成后恢复可操作', async () => {
  const {form, panel} = await setup();
  const target = url => url.pathname.endsWith('/api/kit') && url.searchParams.get('site') === 'secondproduct';
  let release, began;
  const gate = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {began = resolve;});
  const hold = async route => {
    const response = await route.fetch();
    began(); await gate;
    await route.fulfill({response});
  };
  await context.route(target, hold);
  try {
    await panel.selectOption('#site', 'secondproduct');
    await started;
    assert.equal(await panel.locator('#site').isDisabled(), true);
    await panel.evaluate(() => refresh());
    assert.equal(await panel.locator('#site').inputValue(), 'secondproduct');
    release();
    await panel.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已保存默认项目：secondproduct'));
    assert.equal(await panel.locator('#site').isEnabled(), true);
    assert.equal(await preferred(), 'secondproduct');
  } finally {
    release();
    await context.unroute(target, hold);
    await panel.close(); await form.close();
  }
});

test('项目保存失败后解除忙碌状态并恢复实际绑定，可再次选择', async () => {
  const {form, panel} = await setup();
  const target = url => url.pathname.endsWith('/api/kit') && url.searchParams.get('site') === 'secondproduct';
  const reject = route => route.fulfill({status: 409, contentType: 'application/json',
    body: JSON.stringify({error: 'synthetic_project_unavailable'})});
  await context.route(target, reject);
  try {
    await panel.selectOption('#site', 'secondproduct');
    await panel.waitForFunction(() => !document.querySelector('#site').disabled && document.querySelector('#toasts').textContent.includes('synthetic_project_unavailable'));
    assert.equal(await panel.locator('#site').isEnabled(), true);
    assert.equal(await panel.locator('#site').inputValue(), 'probekits');
    assert.equal(await preferred(), 'probekits');
    await context.unroute(target, reject);
    await panel.selectOption('#site', 'secondproduct');
    await panel.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已保存默认项目：secondproduct'));
    assert.equal(await preferred(), 'secondproduct');
  } finally {
    await context.unroute(target, reject);
    await panel.close(); await form.close();
  }
});
