// 真实 Chromium 固定加载路径；更新后重载必须保留扩展身份和本地设置。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp, appendFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {REPO, startEnvironment, launchBrowser} from './support.mjs';

const exec = promisify(execFile);

test('更新后重载实际扩展会读取新代码并保留身份与设置', {timeout: 60000}, async () => {
  const env = await startEnvironment();
  let browser;
  try {
    const prefix = path.join(env.root, 'installed app');
    const bin = path.join(env.root, 'installed bin');
    const variables = {...process.env, HOME: path.join(env.root, 'empty-home'), PYTHON: process.env.PYTHON || 'python3'};
    await exec('sh', [path.join(REPO, 'scripts/install.sh'), '--prefix', prefix, '--bin-dir', bin], {env: variables});
    const extension = path.join(prefix, 'extension');
    assert.equal(await realpath(extension), extension);
    browser = await launchBrowser(env, {}, extension);
    await browser.worker.evaluate(() => chrome.storage.local.set({installationProbe: 'keep my setting'}));
    const id = browser.extensionId;
    const manager = await browser.context.newPage();
    await manager.goto('chrome://extensions');
    await manager.getByRole('switch', {name: /开发者模式|Developer mode/}).click();
    const candidate = path.join(env.root, 'updated source');
    await cp(path.join(prefix, 'current'), candidate, {recursive: true, dereference: true});
    await appendFile(path.join(candidate, 'extension/background.js'), '\nglobalThis.installationProbe = "updated code";\n');
    await exec(path.join(bin, 'backlink-kit'), ['update', '--source', candidate], {env: variables});
    const restarted = browser.context.waitForEvent('serviceworker', {timeout: 20000})
      .then(worker => ({worker}), error => ({error}));
    await manager.getByRole('button', {name: /^(?:重新加载|Reload)$/}).click();
    const result = await restarted;
    if (result.error) {
      console.log(await manager.locator('body').ariaSnapshot());
      throw result.error;
    }
    const {worker} = result;
    const actual = await worker.evaluate(async () => ({
      id: chrome.runtime.id,
      code: globalThis.installationProbe,
      setting: (await chrome.storage.local.get('installationProbe')).installationProbe,
    }));
    assert.deepEqual(actual, {id, code: 'updated code', setting: 'keep my setting'});
    assert.equal(await realpath(extension), extension);
  } finally {
    await browser?.context.close();
    await env.stop();
    await env.cleanup();
  }
});
