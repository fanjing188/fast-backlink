// 实际 CLI→扩展→20个本地合成平台→本机持久记账；未知用真实3分钟期限，不伪造结果。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {REPO, PORT_A, launchBrowser, startEnvironment} from './support.mjs';
const exec = promisify(execFile);
let env, browser, panel;
const names = Array.from({length: 20}, (_, i) => `batch${String(i).padStart(2, '0')}.example`);
const modes = ['success', 'manual', 'failed', 'unknown'];
const screenshots = path.join(REPO, 'docs/screenshots/batch');
async function api(endpoint) {
  const response = await fetch(env.base + 'api/' + endpoint, {headers: {'X-Fast-Backlink': '1'}});
  assert.equal(response.ok, true);
  return response.json();
}
async function fb(...args) {
  const {stdout} = await exec('python3', [path.join(REPO, 'bk.py'), '--config', env.configPath, 'fb', 'batch', ...args], {cwd: REPO, timeout: 90000});
  return JSON.parse(stdout);
}
async function waitBatch(id, predicate, timeout) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await api('batch_status?id=' + id);
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const liveWorker = browser.context.serviceWorkers().find(w => w.url().endsWith('/background.js'));
  const debug = liveWorker ? await liveWorker.evaluate(async () => {
    const {batchJobs = {}} = await chrome.storage.local.get('batchJobs');
    const probes = [];
    for (const job of Object.values(batchJobs).slice(0, 4)) {
      let reply;
      try {reply = await chrome.tabs.sendMessage(job.tabId, {type: 'page:batch-inspect'});}
      catch (error) {reply = {error: error.message};}
      probes.push({id:job.id,tabId:job.tabId,reply});
    }
    return {active:Object.keys(batchJobs).length, probes};
  }).catch(error=>({error:error.message})) : {error:'当前worker已休眠或退出'};
  assert.fail('批量状态未到达预期：' + JSON.stringify({counts:value?.counts,
    jobs:value?.jobs.map(j=>({domain:j.domain,state:j.state,reason:j.reason,attempted_at:j.attempted_at})),debug}));
}
before(async () => {
  env = await startEnvironment();
  const seed = path.join(env.root, 'seed-batch.py');
  await writeFile(seed, `import sys\nsys.path.insert(0,sys.argv[1])\nfrom backlink_kit import core as c, sources as s\nconf=c.load_config(sys.argv[2])\nstore=s.SourceStore(conf['sources_dir'])\nfor i in range(20):\n name=f'batch{i:02d}.example'\n mode=['success','manual','failed','unknown'][i] if i<4 else 'success'\n store.update(name,'screen',dict(status='可投',submit_url=f'http://{name}:${PORT_A}/test-pages/batch-form.html?mode={mode}',scenario='directory',fit_sites='probekits',dr=str(90-i),dr_date=str(c.today()),cost='free',backlink_required=False,license_risk=False,automation_forbidden=False),s.evidence('synthetic:batch',by='manual'))\n`);
  await exec('python3', [seed, REPO, env.configPath]);
  browser = await launchBrowser(env, {}, undefined, ['--host-resolver-rules=MAP *.example 127.0.0.1', '--no-proxy-server']);
  panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/library.html?site=probekits`);
  await panel.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false');
  await mkdir(screenshots, {recursive: true});
}, {timeout: 120000});
after(async () => {await browser?.context.close(); await env?.stop(); await env?.cleanup();});

test('20平台两批四结果、真实超时、快照关闭复原、成功次数与CSV一致', {timeout: 300000}, async () => {
  const started = await fb('start', '--site', 'probekits', '--domains', names.join(','), '--batch-size', '10');
  assert.equal(started.ok, true);
  assert.equal(started.jobs.length, 20);
  const id = started.id;
  const first = await waitBatch(id, b => b.counts.manual === 1 && b.counts.failed === 1 &&
    b.jobs.some(j => j.domain === 'batch03.example' && j.attempted_at), 60000);
  assert.equal(first.jobs.filter(j => j.group === 2 && j.state !== 'queued').length, 0, '结果未知尚在真实期限内，不提前开启第二批');
  const manual = first.jobs.find(j => j.state === 'manual');
  assert.ok(manual, JSON.stringify(first));
  assert.equal(manual.archive_saved, true, JSON.stringify(manual));
  const unknownPage = browser.context.pages().find(p => p.url().includes('batch03.example'));
  assert.ok(unknownPage);
  assert.equal(await unknownPage.locator('body').getAttribute('data-submissions'), '1');
  const snapshot = JSON.parse(await readFile(path.join(env.root, 'handoff', manual.id + '.json'), 'utf8'));
  assert.equal(snapshot.archive.frames[0].steps[0].fields.find(f => f.key === 'name').value, 'ProbeKits');
  assert.ok(!browser.context.pages().some(p => p.url().includes('batch01.example')), '存档成功关闭待人工原页');
  const checkpoint = await fb('status', id);
  assert.equal(checkpoint.counts.manual, 1);
  // 只读轮询业务状态；3分钟截止沿用生产常量。
  const final = await waitBatch(id, b => b.state === 'finished', 235000);
  assert.deepEqual(Object.fromEntries(['success','manual','unknown','failed'].map(k => [k, final.counts[k]])), {success:17, manual:1, unknown:1, failed:1});
  assert.equal(await unknownPage.locator('body').getAttribute('data-submissions'), '1', '未知结果只有一次提交尝试');
  const listed = await api('library?site=probekits&page_size=50');
  assert.equal(listed.items.filter(r => r.submit_count === 1).length, 17);
  assert.equal(listed.items.filter(r => r.submission_status === 'processing').length, 2);
  const ledger = await readFile(path.join(env.root, 'ledger.csv'), 'utf8');
  assert.equal(ledger.trim().split('\n').length, 18);
  const day = final.created_at.slice(0, 10);
  const csv = await readFile(path.join(env.root, 'runs', day, 'batch-' + id + '.csv'), 'utf8');
  assert.ok(csv.startsWith('\ufeffurl,'));
  assert.equal(csv.trim().split('\n').length, 21);
  // 模拟持久映射丢失/worker重建，已完成结果不得重新领取。
  await browser.worker.evaluate(() => chrome.storage.local.remove('batchJobs'));
  const after = await fb('status', id);
  assert.deepEqual(after.counts, final.counts);
  const opened = await panel.evaluate(data => chrome.runtime.sendMessage({type:'batch:open', data}), {batch_id:id,id:manual.id});
  assert.equal(opened.error, undefined, JSON.stringify(opened));
  const restored = browser.context.pages().find(p => p.url().includes('batch01.example'));
  assert.ok(restored);
  await restored.waitForFunction(() => document.querySelector('#product-name').value === 'ProbeKits');
  assert.equal(await restored.inputValue('#product-url'), 'https://probekits.com/');
  assert.equal(await restored.inputValue('[name=captcha]'), '');
  assert.equal(await restored.locator('body').getAttribute('data-submissions'), null);
  for (const width of [375, 1440]) {
    await panel.setViewportSize({width, height:900});
    await panel.click('#reload');
    await panel.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false');
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.screenshot({path:path.join(screenshots,`local-batch-${width}.png`)});
  }
  await writeFile(path.join(screenshots,'result.json'),JSON.stringify({counts:final.counts,groups:final.groups,ledgerRows:17,csvRows:20},null,2));
});
