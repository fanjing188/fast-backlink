// 父会话在独占E2E端口时执行；真实扩展 + 隔离Python服务 + 磁盘读回。
import {after, before, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {KIT, PROFILE, launchBrowser, startEnvironment} from './support.mjs';

let env, browser, replacement;
const B = 'editorbeta';
const kitPath = site => path.join(env.root, 'kits', site, 'kit.json');
const readKit = async site => JSON.parse(await readFile(kitPath(site), 'utf8'));
const beta = () => ({...structuredClone(KIT), site: B, fields: {...structuredClone(KIT.fields), name: {value: 'Beta product'}}, assets: [], qa_overrides: {Beta: 'untouched'}});
async function until(check) {
  const deadline = Date.now() + 10000;
  do {if (await check()) return; await delay(25);} while (Date.now() < deadline);
  assert.fail('持久化读回未在10秒内满足断言');
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}
before(async () => {
  env = await startEnvironment();
  // support仅生成单产品；只修改它生成的临时配置，并重启本用例拥有的子进程。
  await stop(env.service);
  const config = JSON.parse(await readFile(env.configPath, 'utf8'));
  config.sites[B] = {domain: 'editorbeta.test', kit: `${B}/kit.json`};
  await mkdir(path.join(env.root, 'kits', B, 'assets'), {recursive: true});
  await writeFile(kitPath(B), JSON.stringify(beta()));
  await writeFile(env.configPath, JSON.stringify(config));
  replacement = spawn(env.service.spawnfile, env.service.spawnargs.slice(1), {cwd: env.service.spawnargs[1] ? path.dirname(env.service.spawnargs[1]) : undefined, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  replacement.stdout.on('data', data => {output += data;});
  replacement.stderr.on('data', data => {output += data;});
  await until(async () => {
    if (replacement.exitCode !== null) throw Error(`隔离服务退出：${output}`);
    try {return (await fetch(env.base + 'api/health', {headers: {'X-Fast-Backlink': '1'}})).ok;} catch {return false;}
  });
  browser = await launchBrowser(env);
}, {timeout: 180000});
after(async () => {await browser?.context.close(); await stop(replacement); await env?.stop(); await env?.cleanup();});
beforeEach(async () => {
  await writeFile(kitPath('probekits'), JSON.stringify(env.kit));
  await writeFile(kitPath(B), JSON.stringify(beta()));
  await writeFile(path.join(env.root, 'kits/_profile.json'), JSON.stringify(PROFILE));
});
async function options(t) {
  const page = await browser.context.newPage();
  t.after(() => page.close());
  await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
  await page.waitForSelector('#field-name textarea');
  await select(page, 'probekits');
  return page;
}
async function select(page, site) {
  await page.click(`#sites button[data-site="${site}"]`);
  await page.waitForFunction(site => document.querySelector('#editor h2')?.textContent === site, site);
  assert.equal(await page.getAttribute(`#sites button[data-site="${site}"]`, 'aria-current'), 'true');
}
async function change(page, selector, value) {
  await page.fill(selector, value);
  await page.locator(selector).blur();
}
async function prompts(page, answers, action) {
  const handler = async dialog => {
    assert.equal(dialog.type(), 'prompt');
    const answer = answers.shift();
    if (answer === null) await dialog.dismiss(); else await dialog.accept(answer);
  };
  page.on('dialog', handler);
  try {await action(); assert.equal(answers.length, 0);} finally {page.off('dialog', handler);}
}
// 仅在消息边界暂停真实请求或注入失败；不伪造成功响应，落盘结果仍由真实服务生成。
async function hold(page, type, site = 'probekits') {
  await page.evaluate(({type, site}) => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const messages = window.safetyMessages = [];
    const gate = window.safetyGate = {entered: false, done: false};
    let release;
    const waiting = new Promise(resolve => {release = resolve;});
    window.releaseSafety = release;
    chrome.runtime.sendMessage = async message => {
      messages.push(structuredClone(message));
      if (message.type === type && message.site === site && !gate.entered) {
        gate.entered = true;
        await waiting;
        try {return await original(message);} finally {gate.done = true;}
      }
      return original(message);
    };
  }, {type, site});
}
async function release(page) {
  await page.evaluate(() => window.releaseSafety());
  await page.waitForFunction(() => window.safetyGate.done);
}
async function payload(page, site = 'probekits') {
  const response = await page.evaluate(site => chrome.runtime.sendMessage({type: 'kit', site}), site);
  assert.equal(response.error, undefined);
  return response.value;
}

async function importJson(page, data) {
  const chooser = page.waitForEvent('filechooser');
  await page.click('#import');
  await (await chooser).setFiles({name: 'editor-import.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data))});
}
// 暂停真实服务已返回的回包，便于核实“已落盘但回执迟到/丢失”。
async function holdReply(page, type, site = 'probekits', lose = false) {
  await page.evaluate(({type, site, lose}) => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const gate = window.replyGate = {entered: false, done: false};
    const messages = window.replyMessages = [];
    let release;
    const waiting = new Promise(resolve => {release = resolve;});
    window.releaseReply = release;
    let claimed = false;
    chrome.runtime.sendMessage = async message => {
      messages.push(structuredClone(message));
      if (!claimed && message.type === type && (site === null || message.site === site)) {
        claimed = true;
        const response = await original(message);
        if (response.error) return response;
        gate.entered = true;
        await waiting;
        try {if (lose) throw Error('editor response lost'); return response;}
        finally {gate.done = true;}
      }
      return original(message);
    };
  }, {type, site, lose});
}
async function releaseReply(page) {
  await page.evaluate(() => window.releaseReply());
  await page.waitForFunction(() => window.replyGate.done);
}

test('编辑后加翻译、再次编辑并重载：正文/分档/原素材身份与文件/问答全部保全', {timeout: 45000}, async t => {
  const page = await options(t);
  const original = await readKit('probekits');
  const files = await Promise.all(original.assets.map(asset => readFile(path.join(env.root, 'kits/probekits/assets', asset.file))));
  await change(page, '#field-tagline textarea', 'Edited before translation');
  await prompts(page, ['ja', '新しい文案'], () => page.locator('#field-tagline button', {hasText: '加翻译'}).click());
  assert.equal(await page.inputValue('#field-tagline textarea'), 'Edited before translation');
  await change(page, '#field-tagline textarea', 'Final text after translation');
  await until(async () => (await readKit('probekits')).fields.tagline.value === 'Final text after translation');
  const saved = await readKit('probekits');
  assert.equal(saved.fields.tagline.i18n.ja, '新しい文案');
  assert.ok(Object.values(saved.fields.tagline.variants).includes('Final text after translation'));
  assert.deepEqual(saved.assets, original.assets);
  assert.deepEqual(saved.qa_overrides, original.qa_overrides);
  for (const [index, asset] of saved.assets.entries()) assert.deepEqual(await readFile(path.join(env.root, 'kits/probekits/assets', asset.file)), files[index]);
  await page.reload(); await page.waitForSelector('#field-tagline textarea'); await select(page, 'probekits');
  assert.equal(await page.inputValue('#field-tagline textarea'), 'Final text after translation');
});

test('连续change等待前次保存，快速切产品不吞最后修改且不串站', {timeout: 45000}, async t => {
  const page = await options(t);
  const beforeB = await readKit(B);
  await hold(page, 'kit-save');
  await change(page, '#field-name textarea', 'First change');
  await page.waitForFunction(() => window.safetyGate.entered);
  await change(page, '#field-name textarea', 'Last change');
  await select(page, B);
  assert.equal(await page.evaluate(() => window.safetyMessages.filter(item => item.type === 'kit-save').length), 1);
  await release(page);
  await until(async () => (await readKit('probekits')).fields.name.value === 'Last change');
  assert.deepEqual(await readKit(B), beforeB);
  assert.equal(await page.inputValue('#field-name textarea'), 'Beta product');
  await select(page, 'probekits');
  assert.equal(await page.inputValue('#field-name textarea'), 'Last change');
});

test('A资料迟到不能覆盖B的选中状态或全局身份档案', {timeout: 45000}, async t => {
  const page = await options(t);
  await hold(page, 'kit');
  await page.click('#sites button[data-site="probekits"]');
  await page.waitForFunction(() => window.safetyGate.entered);
  await select(page, B);
  await release(page);
  assert.equal(await page.innerText('#editor h2'), B);
  assert.equal(await page.inputValue('#field-name textarea'), 'Beta product');
  await page.reload(); await page.waitForSelector('#field-name textarea');
  await hold(page, 'kit');
  await page.click('#sites button[data-site="probekits"]');
  await page.waitForFunction(() => window.safetyGate.entered);
  await page.click('#edit-profile');
  await page.waitForFunction(() => document.querySelector('#editor h2')?.textContent === '全局身份档案');
  await release(page);
  assert.equal(await page.innerText('#editor h2'), '全局身份档案');
});

test('本站问答不混入共享问答；显式空覆盖、修改和删除后的继承均落盘读回', {timeout: 45000}, async t => {
  const page = await options(t);
  assert.equal(await page.locator('#group-qa input[aria-label="Funding"]').count(), 0);
  await change(page, '#group-qa input[aria-label="How did you hear about us"]', 'Maker referral');
  await until(async () => (await readKit('probekits')).qa_overrides['How did you hear about us'] === 'Maker referral');
  await prompts(page, ['Funding', ''], () => page.locator('#group-qa button', {hasText: '加一条'}).click());
  await until(async () => Object.hasOwn((await readKit('probekits')).qa_overrides, 'Funding'));
  assert.equal((await readKit('probekits')).qa_overrides.Funding, '');
  assert.equal((await payload(page)).qa.Funding, '');
  await page.reload(); await page.waitForSelector('#field-name textarea'); await select(page, 'probekits');
  assert.equal(await page.inputValue('#group-qa input[aria-label="Funding"]'), '');
  const row = page.locator('#group-qa .qa-row').filter({has: page.locator('input[aria-label="Funding"]')});
  await row.getByRole('button', {name: '删除问答'}).click();
  await until(async () => !Object.hasOwn((await readKit('probekits')).qa_overrides, 'Funding'));
  assert.equal((await payload(page)).qa.Funding, 'Bootstrapped');
  assert.equal(JSON.parse(await readFile(path.join(env.root, 'kits/_profile.json'), 'utf8')).qa.Funding, 'Bootstrapped');
});

test('上传与后续正文保存串行，上传回执不覆盖当前输入，也不覆盖另一产品', {timeout: 45000}, async t => {
  const page = await options(t);
  const beforeB = await readKit(B);
  await hold(page, 'asset');
  const bytes = await readFile(path.join(env.root, 'kits/probekits/assets/logo-512.png'));
  await page.locator('#group-media input[type=file]').first().setInputFiles({name: 'editor-upload.png', mimeType: 'image/png', buffer: bytes});
  await page.waitForFunction(() => window.safetyGate.entered);
  await change(page, '#group-media input[aria-label="品牌标志 alt"]', 'Edited alt during upload');
  await change(page, '#field-name textarea', 'During upload');
  // 上传完成不能整区render吞掉尚未blur的文字。
  await page.fill('#field-tagline textarea', 'Still typing');
  await release(page);
  await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('已上传 editor-upload.png'));
  assert.equal(await page.inputValue('#field-tagline textarea'), 'Still typing');
  await page.locator('#field-tagline textarea').blur();
  await until(async () => (await readKit('probekits')).fields.tagline.value === 'Still typing');
  await hold(page, 'asset');
  await page.locator('#group-media input[type=file]').first().setInputFiles({name: 'editor-other.png', mimeType: 'image/png', buffer: bytes});
  await page.waitForFunction(() => window.safetyGate.entered);
  await select(page, B);
  await release(page);
  await until(async () => (await readKit('probekits')).assets.some(asset => asset.id === 'editor-other'));
  assert.equal(await page.innerText('#editor h2'), B);
  assert.deepEqual(await readKit(B), beforeB);
  const saved = await readKit('probekits');
  assert.equal(saved.fields.name.value, 'During upload');
  assert.equal(saved.assets.find(asset => asset.id === 'logo-512').alt, 'Edited alt during upload');
  assert.ok(saved.assets.some(asset => asset.id === 'editor-upload'));
});

test('移除等待保存，切到B后不移除B素材，磁盘原文件保留', {timeout: 45000}, async t => {
  const page = await options(t);
  const beforeB = await readKit(B);
  const beforeA = await readKit('probekits');
  await hold(page, 'kit-save');
  await page.getByRole('button', {name: '移除 品牌标志', exact: true}).click();
  await page.locator('dialog').getByRole('button', {name: '移除', exact: true}).click();
  await page.waitForFunction(() => window.safetyGate.entered);
  await select(page, B);
  await release(page);
  await until(async () => !(await readKit('probekits')).assets.some(asset => asset.key === 'logo'));
  assert.deepEqual(await readKit(B), beforeB);
  assert.equal(await page.innerText('#editor h2'), B);
  const logo = beforeA.assets.find(asset => asset.key === 'logo');
  assert.ok((await readFile(path.join(env.root, 'kits/probekits/assets', logo.file))).length > 0);
});

test('保存失败后切换再返回仍有未保存内容，后续编辑可成功保存', {timeout: 45000}, async t => {
  const page = await options(t);
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failed = false;
    chrome.runtime.sendMessage = message => {
      if (message.type === 'kit-save' && !failed) {failed = true; return Promise.reject(Error('editor injected write failure'));}
      return original(message);
    };
  });
  await change(page, '#field-name textarea', 'Keep unsaved copy');
  await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('保存失败'));
  assert.equal((await readKit('probekits')).fields.name.value, KIT.fields.name.value);
  await select(page, B); await select(page, 'probekits');
  assert.equal(await page.inputValue('#field-name textarea'), 'Keep unsaved copy');
  await change(page, '#field-name textarea', 'Retry latest copy');
  await until(async () => (await readKit('probekits')).fields.name.value === 'Retry latest copy');
});

test('上传落盘后读回失败，错误保留，后续正文保存不删除已上传素材', {timeout: 45000}, async t => {
  const page = await options(t);
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let uploaded = false, failed = false;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'kit' && uploaded && !failed) {failed = true; throw Error('editor readback failure');}
      const response = await original(message);
      if (message.type === 'asset' && !response.error) uploaded = true;
      return response;
    };
  });
  const bytes = await readFile(path.join(env.root, 'kits/probekits/assets/logo-512.png'));
  await page.locator('#group-media input[type=file]').first().setInputFiles({name: 'readback-kept.png', mimeType: 'image/png', buffer: bytes});
  await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('editor readback failure'));
  assert.ok((await readKit('probekits')).assets.some(asset => asset.id === 'readback-kept'));
  await change(page, '#field-name textarea', 'Saved after readback failure');
  await until(async () => (await readKit('probekits')).fields.name.value === 'Saved after readback failure');
  const saved = await readKit('probekits');
  assert.equal(saved.assets.find(asset => asset.id === 'readback-kept').file, 'readback-kept.png');
  assert.deepEqual(await readFile(path.join(env.root, 'kits/probekits/assets/readback-kept.png')), bytes);
});

test('导入等待File.text期间切产品，无site的包仍落到发起产品，B完全不变', {timeout: 45000}, async t => {
  const page = await options(t);
  const beforeB = await readKit(B);
  const imported = await readKit('probekits'); delete imported.site;
  imported.fields.name = {value: 'Imported original product'};
  await page.evaluate(() => {
    const original = File.prototype.text;
    const gate = window.importRead = {entered: false};
    let release;
    const waiting = new Promise(resolve => {release = resolve;});
    window.releaseImportRead = release;
    File.prototype.text = async function () {
      File.prototype.text = original;
      gate.entered = true; await waiting;
      return original.call(this);
    };
  });
  await importJson(page, imported);
  await page.waitForFunction(() => window.importRead.entered);
  await select(page, B);
  await page.evaluate(() => window.releaseImportRead());
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已导入并保存'));
  assert.equal((await readKit('probekits')).fields.name.value, 'Imported original product');
  assert.deepEqual(await readKit(B), beforeB);
  assert.equal(await page.inputValue('#field-name textarea'), 'Beta product');
});

test('导入等待旧保存，已提交后的迟到读回不吞新输入、分档、翻译或问答', {timeout: 45000}, async t => {
  const page = await options(t);
  const imported = await readKit('probekits');
  imported.fields.name = {value: 'Imported after queued save'};
  imported.fields.tagline = {value: 'Imported tagline', variants: {40: 'Short import'}, i18n: {ja: '日本語'}};
  imported.qa_overrides.Funding = '';
  await hold(page, 'kit-save');
  await change(page, '#field-name textarea', 'Old queued save');
  await page.waitForFunction(() => window.safetyGate.entered);
  await holdReply(page, 'kit');
  await importJson(page, imported);
  assert.equal(await page.evaluate(() => window.safetyMessages.filter(message => message.type === 'kit-save').length), 1);
  await release(page);
  await page.waitForFunction(() => window.replyGate.entered);
  assert.equal(await page.inputValue('#field-name textarea'), 'Imported after queued save');
  await change(page, '#field-name textarea', 'Latest after import commit');
  await page.fill('#field-tagline textarea', 'Still typing after import');
  await page.evaluate(() => {window.importArea = document.querySelector('#field-tagline textarea');});
  await releaseReply(page);
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已导入并保存'));
  assert.equal(await page.evaluate(() => document.querySelector('#field-tagline textarea') === window.importArea), true);
  assert.equal(await page.inputValue('#field-tagline textarea'), 'Still typing after import');
  await page.locator('#field-tagline textarea').blur();
  await until(async () => (await readKit('probekits')).fields.tagline.value === 'Still typing after import');
  const saved = await readKit('probekits');
  assert.equal(saved.fields.name.value, 'Latest after import commit');
  assert.equal(saved.fields.tagline.variants['40'], 'Short import');
  assert.equal(saved.fields.tagline.i18n.ja, '日本語');
  assert.equal(saved.qa_overrides.Funding, '');
  assert.deepEqual(saved.assets, imported.assets);
});

test('导入成功但读回失败替换旧失败草稿，切换重开后仍可保存导入内容', {timeout: 45000}, async t => {
  const page = await options(t);
  const imported = await readKit('probekits'); imported.fields.name = {value: 'Committed imported draft'};
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let failedSave = false, imported = false, failedRead = false;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'kit-save' && !failedSave) {failedSave = true; throw Error('old draft failure');}
      if (message.type === 'kit' && message.site === 'probekits' && imported && !failedRead) {failedRead = true; throw Error('import readback failure');}
      const response = await original(message);
      if (message.type === 'kit-save' && !response.error) imported = true;
      return response;
    };
  });
  await change(page, '#field-name textarea', 'Old failed draft');
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('old draft failure'));
  await importJson(page, imported);
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('import readback failure'));
  assert.equal((await readKit('probekits')).fields.name.value, 'Committed imported draft');
  assert.equal(await page.inputValue('#field-name textarea'), 'Committed imported draft');
  await select(page, B); await select(page, 'probekits');
  assert.equal(await page.inputValue('#field-name textarea'), 'Committed imported draft');
  await change(page, '#field-tagline textarea', 'Retry after imported read failure');
  await until(async () => (await readKit('probekits')).fields.tagline.value === 'Retry after imported read failure');
  assert.equal((await readKit('probekits')).fields.name.value, 'Committed imported draft');
});

test('导入读回迟到不能改B，A重新打开也不用旧代次回包', {timeout: 45000}, async t => {
  for (const reopenA of [false, true]) {
    const page = await options(t);
    const imported = await readKit('probekits'); imported.fields.name = {value: 'Old import reply'};
    await holdReply(page, 'kit');
    await importJson(page, imported);
    await page.waitForFunction(() => window.replyGate.entered);
    await select(page, B);
    if (!reopenA) {
      await releaseReply(page);
      await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已导入并保存'));
      assert.equal(await page.innerText('#editor h2'), B);
      assert.equal(await page.inputValue('#field-name textarea'), 'Beta product');
      continue;
    }
    const fresh = await readKit('probekits'); fresh.fields.name = {value: 'Fresh reopened A'};
    await writeFile(kitPath('probekits'), JSON.stringify(fresh));
    const reopening = select(page, 'probekits');
    await page.waitForFunction(() => document.querySelector('#sites button[data-site="probekits"]')?.getAttribute('aria-current') === 'true');
    await releaseReply(page);
    await reopening;
    assert.equal(await page.inputValue('#field-name textarea'), 'Fresh reopened A');
    assert.equal((await readKit(B)).fields.name.value, 'Beta product');
  }
});

test('跨产品导入被拒，原产品的正文、分档、问答及素材不变', {timeout: 45000}, async t => {
  const page = await options(t);
  const before = await readKit('probekits'), beforeB = await readKit(B);
  await importJson(page, beforeB);
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('产品不匹配'));
  assert.deepEqual(await readKit('probekits'), before);
  assert.deepEqual(await readKit(B), beforeB);
  assert.equal(await page.inputValue('#field-name textarea'), before.fields.name.value);
});

test('asset真实落盘但回执丢失：只读核实后保存，不重传、不删除新登记、不串B', {timeout: 45000}, async t => {
  const page = await options(t);
  const beforeB = await readKit(B);
  await holdReply(page, 'asset', 'probekits', true);
  const bytes = await readFile(path.join(env.root, 'kits/probekits/assets/logo-512.png'));
  await page.locator('#group-media input[type=file]').first().setInputFiles({name: 'receipt-lost.png', mimeType: 'image/png', buffer: bytes});
  await page.waitForFunction(() => window.replyGate.entered);
  assert.ok((await readKit('probekits')).assets.some(asset => asset.id === 'receipt-lost'));
  await change(page, '#field-name textarea', 'Queued after lost receipt');
  await select(page, B);
  await releaseReply(page);
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已读回素材登记'));
  await until(async () => (await readKit('probekits')).fields.name.value === 'Queued after lost receipt');
  assert.ok((await readKit('probekits')).assets.some(asset => asset.id === 'receipt-lost'));
  assert.deepEqual(await readFile(path.join(env.root, 'kits/probekits/assets/receipt-lost.png')), bytes);
  const messages = await page.evaluate(() => window.replyMessages);
  assert.equal(messages.filter(message => message.type === 'asset').length, 1);
  const recovery = messages.findIndex(message => message.type === 'kit' && message.site === 'probekits');
  assert.ok(recovery > 0 && recovery < messages.findLastIndex(message => message.type === 'kit-save'));
  assert.deepEqual(await readKit(B), beforeB);
  assert.equal(await page.inputValue('#field-name textarea'), 'Beta product');
});

test('回执及登记读回都失败时禁止旧assets覆盖，重新读取核实后才恢复保存', {timeout: 45000}, async t => {
  const page = await options(t);
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const messages = window.unknownMessages = [];
    window.assetReadBlocked = true;
    let uploaded = false;
    chrome.runtime.sendMessage = async message => {
      messages.push(structuredClone(message));
      if (message.site === 'probekits' && message.type === 'kit' && uploaded && window.assetReadBlocked) throw Error('unknown asset read blocked');
      const response = await original(message);
      if (message.type === 'asset' && !response.error) {uploaded = true; throw Error('unknown asset response lost');}
      return response;
    };
  });
  const bytes = await readFile(path.join(env.root, 'kits/probekits/assets/logo-512.png'));
  await page.locator('#group-media input[type=file]').first().setInputFiles({name: 'unknown-registered.png', mimeType: 'image/png', buffer: bytes});
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('素材登记未核实'));
  await change(page, '#field-name textarea', 'Blocked draft stays local');
  await page.waitForFunction(() => window.unknownMessages.filter(message => message.type === 'kit' && message.site === 'probekits').length >= 2);
  assert.equal(await page.evaluate(() => window.unknownMessages.filter(message => message.type === 'kit-save' && message.site === 'probekits').length), 1);
  assert.ok((await readKit('probekits')).assets.some(asset => asset.id === 'unknown-registered'));
  assert.notEqual((await readKit('probekits')).fields.name.value, 'Blocked draft stays local');
  await select(page, B);
  await change(page, '#field-name textarea', 'B can still save');
  await until(async () => (await readKit(B)).fields.name.value === 'B can still save');
  await page.evaluate(() => {window.assetReadBlocked = false;});
  await select(page, 'probekits');
  assert.equal(await page.inputValue('#field-name textarea'), 'Blocked draft stays local');
  assert.equal(await page.evaluate(() => window.unknownMessages.filter(message => message.type === 'kit-save' && message.site === 'probekits').length), 1, '重开核实只读，不自动重传或整包保存');
  await change(page, '#field-tagline textarea', 'Save after read-only verification');
  await until(async () => (await readKit('probekits')).fields.tagline.value === 'Save after read-only verification');
  assert.equal((await readKit('probekits')).fields.name.value, 'Blocked draft stays local');
  assert.ok((await readKit('probekits')).assets.some(asset => asset.id === 'unknown-registered'));
  assert.equal(await page.evaluate(() => window.unknownMessages.filter(message => message.type === 'asset').length), 1);
});

test('完整度检查回包只换检查区域，保留真实未blur正文节点、值及焦点', {timeout: 45000}, async t => {
  const page = await options(t);
  await holdReply(page, 'kits', null);
  await page.click('#check');
  await page.waitForFunction(() => window.replyGate.entered);
  await page.fill('#field-description textarea', 'Typing while check is pending');
  await page.evaluate(() => {window.checkedArea = document.querySelector('#field-description textarea'); window.checkedReport = document.querySelector('#check-result');});
  await releaseReply(page);
  await page.waitForFunction(() => document.querySelector('#check-result') !== window.checkedReport);
  assert.equal(await page.evaluate(() => document.querySelector('#field-description textarea') === window.checkedArea && document.activeElement === window.checkedArea), true);
  assert.equal(await page.inputValue('#field-description textarea'), 'Typing while check is pending');
  await page.locator('#field-description textarea').blur();
  await until(async () => (await readKit('probekits')).fields.description.value === 'Typing while check is pending');
});

test('A完整度检查迟到不更新B检查区或B正文', {timeout: 45000}, async t => {
  const page = await options(t);
  await holdReply(page, 'kits', null);
  await page.click('#check');
  await page.waitForFunction(() => window.replyGate.entered);
  await select(page, B);
  await page.fill('#field-description textarea', 'B is still typing');
  await page.evaluate(() => {window.betaReport = document.querySelector('#check-result');});
  await releaseReply(page);
  assert.equal(await page.evaluate(() => document.querySelector('#check-result') === window.betaReport), true);
  assert.equal(await page.inputValue('#field-description textarea'), 'B is still typing');
});

test('共享问答取消答案不写profile；明确空答案仍可落盘并交人', {timeout: 45000}, async t => {
  const page = await options(t);
  const profile = path.join(env.root, 'kits/_profile.json');
  const before = await readFile(profile, 'utf8');
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.profileWrites = 0;
    chrome.runtime.sendMessage = message => {if (message.type === 'profile-save') window.profileWrites++; return original(message);};
  });
  await prompts(page, ['Funding', null], () => page.click('#edit-qa'));
  assert.equal(await page.evaluate(() => window.profileWrites), 0);
  assert.equal(await readFile(profile, 'utf8'), before);
  await prompts(page, ['Funding', ''], () => page.click('#edit-qa'));
  await until(async () => JSON.parse(await readFile(profile, 'utf8')).qa.Funding === '');
  assert.equal(await page.evaluate(() => window.profileWrites), 1);
  assert.equal((await payload(page)).qa.Funding, '');
});
