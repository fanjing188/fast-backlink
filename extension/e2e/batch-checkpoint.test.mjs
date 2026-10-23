// 真实扩展跨页面存档/恢复；只访问回环映射的保留域名。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {REPO, PORT_A, startEnvironment, launchBrowser} from './support.mjs';
const exec = promisify(execFile);

test('第二页存档恢复，人工提交无反馈后放弃仍保留未知锁', {timeout:90000}, async () => {
  let env, browser;
  try {
    env = await startEnvironment();
    const seed = path.join(env.root, 'checkpoint.py');
    await writeFile(seed, `import sys\nsys.path.insert(0,sys.argv[1])\nfrom backlink_kit import core as c,sources as s\nconf=c.load_config(sys.argv[2])\ns.SourceStore(conf['sources_dir']).update('checkpoint.example','screen',dict(status='可投',submit_url='http://checkpoint.example:${PORT_A}/test-pages/batch-form.html?mode=step1',scenario='directory',cost='free',dr='42',dr_date=str(c.today()),fit_sites='probekits',backlink_required=False),s.evidence('synthetic:checkpoint',by='manual'))\n`);
    await exec('python3', [seed, REPO, env.configPath]);
    browser = await launchBrowser(env, {}, undefined, ['--host-resolver-rules=MAP checkpoint.example 127.0.0.1', '--no-proxy-server']);
    const panel = await browser.context.newPage();
    await panel.goto(`chrome-extension://${browser.extensionId}/library.html?site=probekits`);
    const sent = await panel.evaluate(() => chrome.runtime.sendMessage({type:'batch:command',data:{action:'start',site:'probekits',domains:['checkpoint.example']}}));
    assert.equal(sent.error, undefined, JSON.stringify(sent));
    const batchId = sent.value.id;
    const deadline = Date.now() + 20000;
    let form;
    while (Date.now() < deadline) {
      form = browser.context.pages().find(p => p.url().includes('checkpoint.example'));
      if (form) break;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.ok(form);
    await form.waitForFunction(() => document.querySelector('#product-name')?.value === 'ProbeKits');
    await form.getByRole('button',{name:'Next',exact:true}).click();
    let batch;
    const waiting = Date.now() + 25000;
    while (Date.now() < waiting) {
      batch = await (await fetch(env.base+'api/batch_status?id='+batchId,{headers:{'X-Fast-Backlink':'1'}})).json();
      if (batch.counts.manual === 1) break;
      await new Promise(resolve => setTimeout(resolve,200));
    }
    const job = batch.jobs[0];
    assert.equal(job.state,'manual',JSON.stringify(batch));
    assert.equal(job.archive_saved,true,JSON.stringify(job));
    const record = JSON.parse(await readFile(path.join(env.root,'handoff',job.id+'.json'),'utf8'));
    assert.match(record.submit_url,/mode=manual&step=2/);
    const reopened = await panel.evaluate(data => chrome.runtime.sendMessage({type:'batch:open',data}),{batch_id:batchId,id:job.id});
    assert.equal(reopened.error,undefined,JSON.stringify(reopened));
    const restored = browser.context.pages().find(p=>p.url().includes('mode=manual&step=2'));
    assert.ok(restored,'直接打开存档的第二页而非原入口');
    await restored.waitForFunction(()=>document.querySelector('#product-name')?.value==='ProbeKits');
    assert.equal(await restored.inputValue('#product-url'),'https://probekits.com/');
    assert.equal(await restored.inputValue('[name=captcha]'),'');
    assert.equal(await restored.locator('body').getAttribute('data-submissions'),null);
    await restored.fill('[name=captcha]','SYNTHETIC-HUMAN-CODE');
    await restored.getByRole('button',{name:'Submit listing',exact:true}).click();
    const submittedDeadline = Date.now() + 10000;
    while (Date.now() < submittedDeadline) {
      batch = await (await fetch(env.base+'api/batch_status?id='+batchId,{headers:{'X-Fast-Backlink':'1'}})).json();
      if (batch.jobs[0].state === 'unknown') break;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.equal(batch.jobs[0].state,'unknown');
    assert.ok(batch.jobs[0].attempted_at);
    const resolved = await panel.evaluate(data=>chrome.runtime.sendMessage({type:'batch:resolve',data}),{batch_id:batchId,id:job.id,result:'abandoned',reason:'合成夹具取消'});
    assert.equal(resolved.error,undefined);
    const abandoned = JSON.parse(await readFile(path.join(env.root,'handoff',job.id+'.json'),'utf8'));
    assert.equal(abandoned.archive,undefined);
    const preview = await panel.evaluate(() => chrome.runtime.sendMessage({type:'batch:preview',data:{site:'probekits',domains:['checkpoint.example']}}));
    assert.deepEqual(preview.value.eligible,[]);
    const stopped = await panel.evaluate(data=>chrome.runtime.sendMessage({type:'agent:execute',command:{action:'batch',args:{action:'status'}}}),{});
    assert.ok(Array.isArray(stopped.value.batches));
  } finally {
    await browser?.context.close(); await env?.stop(); await env?.cleanup();
  }
});
