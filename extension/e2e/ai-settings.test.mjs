// 真实扩展设置页 → 后台 → 本机服务 → 本地合成模型；不使用个人配置或外部平台。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {launchBrowser, startEnvironment} from './support.mjs';

let env, browser, panel, model;
const requests = [];
let responseStatus = 200;

before(async () => {
  model = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => {raw += chunk;});
    request.on('end', () => {
      requests.push({body: JSON.parse(raw), auth: request.headers.authorization});
      response.writeHead(responseStatus, {'Content-Type': 'application/json'});
      response.end(JSON.stringify(responseStatus === 200
        ? {choices: [{message: {content: '{"ok":true}'}}]}
        : {error: 'synthetic-private-key must not appear in UI'}));
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  env = await startEnvironment();
  browser = await launchBrowser(env);
  panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await panel.click('nav [data-tab=settings]');
}, {timeout: 120000});

after(async () => {
  await browser?.context.close();
  await env?.stop();
  await env?.cleanup();
  model?.close();
});

test('设置填写、草稿连通、保存重开、错误与窄侧栏', async () => {
  const form = panel.locator('#ai-config');
  await form.waitFor({timeout: 5000});
  await form.getByLabel('API 地址', {exact: true}).fill(`http://127.0.0.1:${model.address().port}/v1`);
  await form.getByLabel('模型名称', {exact: true}).fill('synthetic-model');
  await form.getByLabel('API 密钥', {exact: true}).fill('synthetic-private-key');
  await form.getByLabel('启用 AI 智能填充', {exact: true}).check();
  await form.getByRole('button', {name: '测试连通', exact: true}).click();
  await panel.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('连接成功'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, 'synthetic-model');
  assert.equal(requests[0].auth, 'Bearer synthetic-private-key');
  assert.ok(!JSON.stringify(requests[0].body).includes('ProbeKits'));
  assert.equal((await (await fetch(env.base + 'api/ai', {headers: {'X-Fast-Backlink': '1'}})).json()).configured, false);
  // 周期刷新或标签更新不能擦掉草稿、密钥、焦点。
  await panel.evaluate(async () => {await refresh();});
  assert.equal(await form.getByLabel('模型名称', {exact: true}).inputValue(), 'synthetic-model');
  assert.equal(await form.getByLabel('API 密钥', {exact: true}).inputValue(), 'synthetic-private-key');
  await form.getByRole('button', {name: '保存配置', exact: true}).click();
  await panel.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('已保存'));
  assert.equal((await stat(path.join(env.root, 'settings/ai-config.json'))).mode & 0o777, 0o600);
  await panel.reload();
  await panel.click('nav [data-tab=settings]');
  assert.equal(await form.getByLabel('模型名称', {exact: true}).inputValue(), 'synthetic-model');
  assert.equal(await form.getByLabel('API 密钥', {exact: true}).inputValue(), '');
  assert.match(await form.getByLabel('API 密钥', {exact: true}).getAttribute('placeholder'), /已保存/);
  assert.equal(await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null))).then(raw => raw.includes('synthetic-private-key')), false);
  responseStatus = 401;
  await form.getByRole('button', {name: '测试连通', exact: true}).click();
  await panel.waitForFunction(() => document.querySelector('#ai-feedback')?.textContent.includes('401'));
  assert.ok(!(await form.textContent()).includes('synthetic-private-key'));
  await form.getByLabel('模型名称', {exact: true}).fill('unsaved-model');
  await panel.evaluate(async () => {await refresh();});
  assert.equal(await form.getByLabel('模型名称', {exact: true}).inputValue(), 'unsaved-model');
  await form.getByLabel('模型名称', {exact: true}).fill('synthetic-model');
  assert.ok(process.env.BK_TEST_TMPDIR, '截图必须写入私有 BK_TEST_TMPDIR');
  const shots = path.join(process.env.BK_TEST_TMPDIR, 'ai-settings-screenshots');
  await mkdir(shots, {recursive: true});
  for (const colorScheme of ['light', 'dark']) {
    await panel.emulateMedia({colorScheme});
    for (const width of [320, 375, 480, 1440]) {
      await panel.setViewportSize({width, height: 1100});
      await form.scrollIntoViewIfNeeded();
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const inputs = form.locator('input');
      assert.ok(await inputs.count() > 0);
      assert.equal(await inputs.evaluateAll(inputs => inputs.every(node => {
        const rect = node.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth;
      })), true);
      await panel.screenshot({path: path.join(shots, `settings-${width}-${colorScheme}.png`)});
    }
  }
  const raw = await readFile(path.join(shots, 'settings-375-light.png'));
  assert.equal(raw.readUInt32BE(16), 375);
}, {timeout: 90000});

test('来源切换只刷新其他设置，不丢失 AI 草稿和焦点', async () => {
  await panel.evaluate(() => {
    state.info.source = 'a.example';
    state.settings.auto_next = false;
    state.settings.auto_next_sites = {};
    renderSettings();
  });
  const override = () => panel.locator('.settings-group').filter({has: panel.getByRole('heading', {name: '本站覆盖', exact: true})});
  assert.match(await override().textContent(), /a\.example/);
  const model = panel.getByLabel('模型名称', {exact: true});
  await model.fill('preserved-draft');
  await model.focus();
  await panel.evaluate(() => {state.info.source = 'b.example'; renderSettings();});
  assert.match(await override().textContent(), /b\.example/);
  assert.ok(!(await override().textContent()).includes('a.example'));
  assert.equal(await model.inputValue(), 'preserved-draft');
  assert.equal(await model.evaluate(node => document.activeElement === node), true);
  await override().locator('input').check();
  await panel.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.auto_next_sites?.['b.example'] === true);
  assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings.auto_next_sites?.['a.example']), undefined);
});
