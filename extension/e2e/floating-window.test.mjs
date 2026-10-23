import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {REPO, launchBrowser, openFixture, startEnvironment} from './support.mjs';

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

test('快捷悬浮窗开关即时影响所有已开页面并跨刷新保存，不影响填写和侧栏', async () => {
  const {page: first} = await openFixture(browser.context, 'plain.html');
  const {page: second} = await openFixture(browser.context, 'plain.html', {query: '?instance=2'});
  const panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await panel.click('nav [data-tab=settings]');
  const toggle = panel.getByRole('checkbox', {name: '网站快捷悬浮窗'});
  const setFloating = async enabled => {
    await toggle.setChecked(enabled);
    await panel.waitForFunction(async expected =>
      (await chrome.storage.local.get('settings')).settings?.floating_window === expected, enabled);
  };
  assert.equal(await toggle.count(), 1, '设置中需要可见、可操作的悬浮窗开关');
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await first.locator('#fast-backlink-bar').count(), 1);
  await setFloating(false);
  for (const page of [first, second]) await page.waitForFunction(() => !document.getElementById('fast-backlink-bar'));
  await first.reload();
  await first.waitForFunction(() => !!document.documentElement.dataset.bkStatus);
  assert.equal(await first.locator('#fast-backlink-bar').count(), 0);
  const {page: third} = await openFixture(browser.context, 'plain.html', {query: '?instance=3'});
  assert.equal(await third.locator('#fast-backlink-bar').count(), 0);
  assert.equal(await third.inputValue('#name'), 'ProbeKits', '隐藏快捷条不能关闭辅助填写');
  await panel.reload();
  await panel.click('nav [data-tab=settings]');
  assert.equal(await toggle.isChecked(), false);
  await setFloating(true);
  for (const page of [first, second, third]) await page.waitForFunction(() => !!document.getElementById('fast-backlink-bar'));
  await setFloating(false);
  await first.waitForFunction(() => !document.getElementById('fast-backlink-bar'));
  await setFloating(true);
  await first.waitForFunction(() => document.querySelectorAll('#fast-backlink-bar').length === 1);
  const directory = path.join(REPO, 'docs/screenshots/floating-window');
  await mkdir(directory, {recursive: true});
  await panel.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
  await panel.waitForFunction(() => document.querySelector('input[aria-label="网站快捷悬浮窗"]').checked);
  for (const width of [375, 1440]) {
    await panel.setViewportSize({width, height: 900});
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await panel.screenshot({path: path.join(directory, `settings-${width}.png`)});
  }
  for (const page of [first, second, third, panel]) await page.close();
}, {timeout: 90000});
