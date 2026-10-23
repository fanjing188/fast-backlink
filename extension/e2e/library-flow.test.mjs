// 真实扩展/本机API/持久SourceStore/持久handoff的组合验收；第三方表单由显式合成路由提供。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {KIT, PORT_A, REPO, launchBrowser, startEnvironment} from './support.mjs';

const exec = promisify(execFile);
const second = 'freshproduct';
const source = 'library-flow.example';
const target = `http://${source}:${PORT_A}/test-pages/library-submit.html`;
const screenshotDir = path.join(REPO, 'docs/screenshots/library');
let env, browser;
const api = async (endpoint, body) => {
  const response = await fetch(env.base + 'api/' + endpoint, {headers: {'X-Fast-Backlink': '1', ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {method: 'POST', body: JSON.stringify(body)} : {})});
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
};
before(async () => {
  const fresh = {...structuredClone(KIT), site: second, assets: [], fields: {...structuredClone(KIT.fields),
    name: {value: 'Fresh Product Fixture'}, url: {value: 'https://fresh-product.test/'}, domain: {value: 'fresh-product.test'}}};
  env = await startEnvironment({additionalKits: [fresh]});
  browser = await launchBrowser(env);
  await mkdir(screenshotDir, {recursive: true});
}, {timeout: 180000});
after(async () => {await browser?.context.close(); await env?.stop(); await env?.cleanup();});
async function library(site = '') {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.extensionId}/library.html?site=${site}`);
  await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false');
  return page;
}
async function field(page, id, value) {
  const locator = page.locator('#record-' + id);
  if (await locator.evaluate(node => node.tagName) === 'SELECT') await locator.selectOption(value);
  else await locator.fill(value);
}

test('人工新增平台的免费/回链/类型/适配记录实际保存并读回，而非仅发消息', async () => {
  const page = await library('probekits');
  try {
    await page.click('#add');
    await field(page, 'domain', 'new-platform.example');
    await field(page, 'url', 'https://new-platform.example/submit');
    await field(page, 'scenario', 'directory');
    await field(page, 'fee', 'free');
    await field(page, 'backlink', 'false');
    await page.getByRole('checkbox', {name: '确认适配 probekits', exact: true}).check();
    await field(page, 'note', '合成平台规则核对，不是外部投稿证据');
    await page.click('#save');
    await page.waitForFunction(() => !document.querySelector('#save').disabled);
    assert.match(await page.locator('#form-status').innerText(), /已保存并读回/);
    const saved = (await api('library?site=probekits&q=new-platform.example')).items[0];
    assert.equal(saved.fee, 'free');
    assert.equal(saved.backlink, false);
    assert.deepEqual(saved.fit_sites, ['probekits']);
    await page.reload();
    await page.waitForSelector('article[data-domain="new-platform.example"]');
    await page.locator('article[data-domain="new-platform.example"] [data-action=edit]').click();
    assert.equal(await page.getByRole('checkbox', {name: '确认适配 probekits', exact: true}).isChecked(), true);
    assert.equal(await page.locator('#record-backlink').inputValue(), 'false');
    assert.equal(await page.locator('#record-note').inputValue(), '合成平台规则核对，不是外部投稿证据');
    await field(page, 'url', 'https://new-platform.example/new-submit');
    await page.getByRole('checkbox', {name: '确认适配 probekits', exact: true}).uncheck();
    await page.click('#save');
    await page.waitForFunction(() => !document.querySelector('#save').disabled);
    assert.match(await page.locator('#form-status').innerText(), /已保存并读回/);
    const updated = (await api('library?site=probekits&q=new-platform.example')).items[0];
    assert.equal(updated.submit_url, 'https://new-platform.example/new-submit');
    assert.deepEqual(updated.fit_sites, []);
    await page.click('#cancel-edit');
    const downloadPromise = page.waitForEvent('download');
    await page.click('#export');
    const stream = await (await downloadPromise).createReadStream();
    let text = ''; for await (const chunk of stream) text += chunk;
    const exported = JSON.parse(text);
    assert.equal(exported.scope, 'current_list');
    assert.equal(exported.count, exported.items.length);
  } finally {await page.close();}
});

test('新产品复用生成自己的持久计划，人工提交只记未知，重载和重开都禁止重投', {timeout: 45000}, async () => {
  const seed = path.join(env.root, 'seed-library.py');
  await writeFile(seed, `import sys\nsys.path.insert(0, sys.argv[1])\nfrom backlink_kit import core as c, sources as s\nconf=c.load_config(sys.argv[2])\nstore=s.SourceStore(conf['sources_dir'])\nname='${source}'\nstore.update(name,'screen',dict(status='可投',submit_url='${target}',scenario='directory',fit_sites='probekits|${second}',dr='25',dr_date=str(c.today()),cost='free',backlink_required=False,license_risk=False,automation_forbidden=False),s.evidence('synthetic:library',by='manual'))\nstore.update(name,'capture',{'fields':[{'label':'Product name','inputType':'text','required':True},{'label':'Website URL','inputType':'url','required':True}]},s.evidence('synthetic:capture'))\nstore.update(name,'memory',[{'label':'Product name','key':'name','value':'OLD PRODUCT MUST NOT COPY'}],s.evidence('synthetic:old-product',by='manual'),'probekits')\n`);
  await exec('python3', [seed, REPO, env.configPath]);
  const page = await library(second);
  let form;
  try {
    assert.equal(await page.locator('#site').inputValue(), second, '必须能选到新增产品');
    const row = page.locator(`article[data-domain="${source}"]`);
    assert.equal(await row.locator('[data-action=fill]').isEnabled(), true);
    const opened = browser.context.waitForEvent('page');
    await row.locator('[data-action=fill]').click();
    form = await opened;
    await form.waitForSelector('#product-name');
    await form.waitForFunction(() => document.querySelector('#product-name').value === 'Fresh Product Fixture' &&
      document.querySelector('#product-url').value === 'https://fresh-product.test/');
    assert.equal(await form.inputValue('#product-url'), 'https://fresh-product.test/');
    assert.equal(await form.inputValue('#verification'), '');
    assert.equal(await form.getAttribute('body', 'data-submissions'), null);
    const files = (await readdir(path.join(env.root, 'handoff'))).filter(name => /^[0-9a-f]{32}\.json$/.test(name));
    const records = await Promise.all(files.map(async file => {
      const item = JSON.parse(await readFile(path.join(env.root, 'handoff', file), 'utf8'));
      return {file, id: item.id, site: item.site, status: item.status, source: item.source_domain};
    }));
    assert.equal(files.length, 1, JSON.stringify(records));
    const record = JSON.parse(await readFile(path.join(env.root, 'handoff', files[0]), 'utf8'));
    assert.equal(record.site, second);
    assert.ok(record.fields.some(field => field.value === 'Fresh Product Fixture'));
    assert.equal(JSON.stringify(record.fields).includes('OLD PRODUCT MUST NOT COPY'), false);
    const staleContext = await api('item?id=' + record.id);
    await form.fill('#verification', '123456');
    await form.getByRole('button', {name: 'Submit listing'}).click();
    await form.waitForFunction(() => document.body.dataset.submissions === '1');
    let after;
    for (let attempt = 0; attempt < 50; attempt++) {
      after = (await api(`library?site=${second}&q=${source}`)).items[0];
      if (after.reuse_state === 'already_submitted') break;
      await page.waitForTimeout(100);
    }
    assert.equal(after.reuse_state, 'already_submitted');
    assert.ok(after.history.some(item => item.site === second && item.status === '结果未知'));
    await page.reload();
    await page.waitForSelector(`article[data-domain="${source}"]`);
    assert.equal(await row.locator('[data-action=fill]').isDisabled(), true);
    const replay = await page.evaluate(message => chrome.runtime.sendMessage(message),
      {type: 'library:open', domain: source, site: second, fill: true});
    assert.ok(replay.error);
    assert.equal((await readdir(path.join(env.root, 'handoff'))).filter(name => /^[0-9a-f]{32}\.json$/.test(name)).length, 1);
    await api('skip', {id: record.id, reason: '停止处理，提交结果仍未知'});
    assert.equal((await api(`library?site=${second}&q=${source}`)).items[0].reuse_state, 'already_submitted');
    await form.fill('#product-name', '');
    await form.fill('#product-url', '');
    await page.evaluate(async ({target, context}) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === target);
      await chrome.tabs.sendMessage(tab.id, {type: 'page:adopt', context, submitted: false});
      await chrome.tabs.sendMessage(tab.id, {type: 'page:fill', force: true});
    }, {target, context: staleContext});
    assert.equal(await form.inputValue('#product-name'), '', '迟到的旧上下文不能撤销当前页面已知的提交锁');
    await page.evaluate(() => chrome.storage.session.clear());
    await form.reload();
    await form.waitForSelector('#product-name');
    await form.bringToFront();
    const locked = await page.evaluate(async ({target, site}) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === target);
      const selected = await chrome.runtime.sendMessage({type: 'panel:activate', site});
      if (selected.error) throw Error(selected.error);
      const restored = await chrome.runtime.sendMessage({type: 'panel:command', tabId: tab.id, command: 'page:restore'});
      if (restored.error) throw Error(restored.error);
      return (await chrome.runtime.sendMessage({type: 'panel:state', tabId: tab.id})).value.submitted;
    }, {target, site: second});
    assert.equal(locked, true, '跳过、清会话、重新选产品都不能洗掉提交锁');
    assert.equal(await form.inputValue('#product-name'), '');
    assert.equal(await form.inputValue('#product-url'), '');
    assert.equal((await api(`library?site=probekits&q=${source}`)).items[0].reuse_state, 'ready');
  } finally {await form?.close(); await page.close();}
});

test('真实扩展外链库四档宽度与深浅色：截图尺寸、滚动和控件几何实际读回', async () => {
  const page = await library('probekits');
  const evidence = [];
  try {
    for (const width of [320, 375, 480, 1440]) for (const colorScheme of ['light', 'dark']) {
      await page.setViewportSize({width, height: 900});
      await page.emulateMedia({colorScheme, reducedMotion: 'reduce'});
      const geometry = await page.evaluate(() => ({width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
        bad: [...document.querySelectorAll('button, input, select, textarea')].filter(node => {
          const r = node.getBoundingClientRect(); return r.width && r.height && (r.left < -1 || r.right > innerWidth + 1);
        }).map(node => node.id)}));
      assert.equal(geometry.overflow <= 1, true);
      assert.deepEqual(geometry.bad, []);
      const name = `fixture-${width}-${colorScheme}.png`;
      await page.screenshot({path: path.join(screenshotDir, name)});
      const png = await readFile(path.join(screenshotDir, name));
      assert.equal(png.readUInt32BE(16), width);
      assert.equal(png.readUInt32BE(20), 900);
      evidence.push({name, ...geometry});
    }
    await writeFile(path.join(screenshotDir, 'geometry.json'), JSON.stringify(evidence, null, 2));
  } finally {await page.close();}
});
