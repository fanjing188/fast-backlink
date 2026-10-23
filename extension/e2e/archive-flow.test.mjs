// 完整人工流程：填表→存档→关闭→清理短期快照→重启浏览器→队列打开→复原→人工验证码→提交。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {EXPECTED, REPO, launchBrowser, openFixture, startEnvironment} from './support.mjs';
let env, browser;
before(async () => { env = await startEnvironment(); browser = await launchBrowser(env); }, {timeout: 120000});
after(async () => { await browser?.context.close().catch(() => {}); await env?.stop(); await env?.cleanup(); });

async function panelPage() {
  const panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await panel.waitForSelector('[data-panel=form] .bk-item');
  return panel;
}

test('集中待验证存档：跨重启仍复原人工最终值，验证码保持空白，提交只由人触发', async () => {
  const {page} = await openFixture(browser.context, 'archive-form.html');
  await page.locator('#name').fill('Manual saved product');
  await page.locator('#description').fill('A specific saved description, not a generated kit variant.');
  const panel = await panelPage();
  await panel.getByRole('button', {name: '存档待验证', exact: true}).click();
  await panel.getByText('已存档到待处理', {exact: true}).waitFor();
  await panel.locator('[data-tab=tasks]').click();
  await panel.locator('.task').waitFor();
  assert.match(await panel.locator('.task').textContent(), /仅剩验证/);
  const records = [];
  for (const name of await readdir(path.join(env.root, 'handoff'))) {
    if (/^[a-f0-9]{32}\.json$/.test(name)) records.push(JSON.parse(await readFile(path.join(env.root, 'handoff', name), 'utf8')));
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].archive.only_verification, true);
  assert.equal(await page.evaluate(() => window.submits), 0);
  // 删除测试浏览器的短期快照，来源记忆也置空，证明复原来自持久存档，不是旧缓存碰巧命中。
  await browser.worker.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const {name} of databases) await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) {db.close(); resolve(); return;}
        const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').clear();
        tx.oncomplete = () => {db.close(); resolve();}; tx.onerror = reject;
      };
      request.onerror = reject;
    });
  });
  await browser.context.close();
  for (const name of await readdir(path.join(env.root, 'sources'))) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(env.root, 'sources', name);
    const source = JSON.parse(await readFile(file, 'utf8')); source.memories = {};
    await writeFile(file, JSON.stringify(source));
  }
  browser = await launchBrowser(env);
  const reopenedPanel = await browser.context.newPage();
  await reopenedPanel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await reopenedPanel.locator('[data-tab=tasks]').click();
  const created = browser.context.waitForEvent('page');
  await reopenedPanel.getByRole('button', {name: '打开并复原', exact: true}).click();
  const restored = await created;
  await restored.waitForFunction(() => document.querySelector('#name')?.value === 'Manual saved product' &&
    document.querySelector('#description')?.value === 'A specific saved description, not a generated kit variant.', null, {timeout: 20000});
  assert.equal(await restored.locator('#description').inputValue(), 'A specific saved description, not a generated kit variant.');
  assert.equal(await restored.locator('#url').inputValue(), EXPECTED.url);
  assert.equal(await restored.locator('#captcha').inputValue(), '');
  assert.equal(await restored.evaluate(() => window.submits), 0);

  await mkdir(path.join(REPO, 'docs/screenshots/iteration'), {recursive: true});
  await reopenedPanel.bringToFront();
  for (const scheme of ['light', 'dark']) {
    await reopenedPanel.emulateMedia({colorScheme: scheme});
    for (const width of [320, 375, 480]) {
      await reopenedPanel.setViewportSize({width, height: 760});
      await reopenedPanel.waitForFunction(() => document.getAnimations().every(animation =>
        animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
      assert.ok(await reopenedPanel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const layout = await reopenedPanel.evaluate(() => ({rows: getComputedStyle(document.body).gridTemplateRows,
        children: [...document.body.children].map(node => ({tag: node.tagName, id: node.id,
          y: node.getBoundingClientRect().top, h: node.getBoundingClientRect().height}))}));
      assert.ok(layout.children.find(x => x.tag === 'NAV').y < 200, '页签不应被空白区推到屏幕底部：' + JSON.stringify(layout));
      const clipped = await reopenedPanel.locator('header button, header select, .task, .task button, .task .pill').evaluateAll(nodes =>
        nodes.filter(node => {const r=node.getBoundingClientRect();return r.left < 0 || r.right > innerWidth + 1}).map(node => node.textContent));
      assert.deepEqual(clipped, [], '关键控件必须在视口内，不依赖overflow:hidden遮住');
      await reopenedPanel.screenshot({path: path.join(REPO, `docs/screenshots/iteration/archive-queue-${width}-${scheme}.png`)});
    }
  }
  // 模拟人的动作，仅作用于本地夹具；不处理任何真实验证码。
  await restored.bringToFront();
  await restored.locator('#captcha').fill('fixture-human-code');
  await restored.getByRole('button', {name: 'Submit product', exact: true}).click();
  assert.equal(await restored.evaluate(() => window.submits), 1);
  for (let attempt=0; attempt<30; attempt++) {
    const record = JSON.parse(await readFile(path.join(env.root, 'handoff', records[0].id + '.json'), 'utf8'));
    if (record.status === '结果未知') break;
    await restored.waitForTimeout(100);
  }
  const afterSubmit = JSON.parse(await readFile(path.join(env.root, 'handoff', records[0].id + '.json'), 'utf8'));
  assert.equal(afterSubmit.status, '结果未知', '提交事件必须持久阻断重新排队，不能在重启后丢失');
  await restored.reload();
  await restored.waitForFunction(() => !!document.documentElement.dataset.bkStatus);
  assert.equal(await restored.locator('#name').inputValue(), '', '未知提交后刷新不得自动再次复原');
});
