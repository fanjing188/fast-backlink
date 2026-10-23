// 真实扩展/真实服务，只有测试副本追加可控的source回包屏障，不改产品内容脚本。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {EXTENSION, PORT_A, launchBrowser, startEnvironment} from './support.mjs';

for (const submitBeforeRelease of [false, true]) {
  test(`真实worker的迟到source回包${submitBeforeRelease ? '不清除已投稿锁' : '不丢失投稿任务ID'}`, {timeout: 30000}, async () => {
    const env = await startEnvironment();
    let browser;
    try {
      const copy = path.join(env.root, 'barrier-extension');
      await cp(EXTENSION, copy, {recursive: true});
      const background = await readFile(path.join(EXTENSION, 'background.js'), 'utf8');
      const hook = `
const fixtureFetch = globalThis.fetch.bind(globalThis);
let fixtureRelease, fixtureReached;
const fixtureHeld = new Promise(resolve => {fixtureRelease = resolve;});
globalThis.__fixtureSourceReady = new Promise(resolve => {fixtureReached = resolve;});
globalThis.__fixtureReleaseSource = fixtureRelease;
globalThis.fetch = async (...args) => {
  const response = await fixtureFetch(...args);
  if (new URL(args[0]).pathname.endsWith('/api/source')) {fixtureReached(); await fixtureHeld;}
  return response;
};
globalThis.__fixtureSession = (tabId, message) => buildSession(tabId, message, {frameId: 0}, {wait: true});
`;
      await writeFile(path.join(copy, 'background.js'), background + hook);
      assert.equal(await readFile(path.join(copy, 'content.js'), 'utf8'), await readFile(path.join(EXTENSION, 'content.js'), 'utf8'));
      const id = 'b'.repeat(32);
      const url = `http://127.0.0.1:${PORT_A}/test-pages/library-submit.html`;
      const file = path.join(env.root, 'handoff', id + '.json');
      await writeFile(file, JSON.stringify({id, site: 'probekits', source_domain: '127.0.0.1', submit_url: url,
        status: '待处理', blocker: '人工验证', blocker_location: '当前表单', fields: [], steps: [], step: 0,
        created_at: new Date().toISOString().slice(0, 19)}));
      browser = await launchBrowser(env, {}, copy);
      const page = await browser.context.newPage();
      await page.goto(url);
      await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus);
      const tabId = await browser.worker.evaluate(async url => {
        const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
        await chrome.storage.session.set({['tab:' + tab.id]: {site: 'probekits'}});
        return tab.id;
      }, url);
      const stale = browser.worker.evaluate(({tabId, url}) => globalThis.__fixtureSession(tabId, {url}), {tabId, url});
      await browser.worker.evaluate(() => globalThis.__fixtureSourceReady);
      const bound = await browser.worker.evaluate(({tabId, id, url}) => globalThis.__fixtureSession(tabId, {id, url}), {tabId, id, url});
      assert.equal(bound.context.record.id, id);
      await page.waitForFunction(() => document.querySelector('#product-name').value === 'ProbeKits');
      // 等待填写结果已落盘，单独隔离source交错，不把另一个持锁问题混入此回归。
      for (let attempt = 0; attempt < 50; attempt++) {
        if (JSON.parse(await readFile(file, 'utf8')).status === '待人工') break;
        await page.waitForTimeout(50);
      }
      assert.equal(JSON.parse(await readFile(file, 'utf8')).status, '待人工');
      const submit = async () => {
        await page.fill('#verification', '123456');
        await page.getByRole('button', {name: 'Submit listing'}).click();
        await page.waitForFunction(() => document.body.dataset.submissions === '1');
        // 只读合成持久文件，不让网页接触本机服务令牌。
        for (let attempt = 0; attempt < 50; attempt++) {
          const record = JSON.parse(await readFile(file, 'utf8'));
          if (record.attempted_at) return record;
          await page.waitForTimeout(50);
        }
        return JSON.parse(await readFile(file, 'utf8'));
      };
      let record;
      if (submitBeforeRelease) record = await submit();
      await browser.worker.evaluate(() => globalThis.__fixtureReleaseSource());
      assert.equal(await stale, null, '迟到source响应不能再下发无ID会话');
      const state = await browser.worker.evaluate(async tabId => (await chrome.storage.session.get('tab:' + tabId))['tab:' + tabId], tabId);
      assert.equal(state.context.record.id, id);
      assert.equal(!!state.submitted, submitBeforeRelease);
      if (!submitBeforeRelease) record = await submit();
      assert.ok(record.attempted_at);
      assert.equal(record.status, '结果未知');
      await page.close();
    } finally {
      await browser?.context.close();
      await env.stop();
      await env.cleanup();
    }
  });
}
