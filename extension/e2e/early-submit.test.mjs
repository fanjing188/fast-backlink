// 真实扩展仅注入合成IPC延迟；产品内容脚本逐字使用当前源码，不访问外部平台。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {EXTENSION, PORT_A, activate, launchBrowser, startEnvironment} from './support.mjs';

test('启动会话回包迟到时，已填表后的立即人工投稿仍持久记未知', {timeout:30000}, async()=>{
  const env=await startEnvironment();let browser;
  try{
    const copy=path.join(env.root,'latency-extension');await cp(EXTENSION,copy,{recursive:true});
    const manifest=JSON.parse(await readFile(path.join(copy,'manifest.json'),'utf8'));
    manifest.content_scripts[0].js.unshift('test-startup-latency.js');
    await writeFile(path.join(copy,'manifest.json'),JSON.stringify(manifest));
    await writeFile(path.join(copy,'test-startup-latency.js'),`const originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);
chrome.runtime.sendMessage=async message=>{const result=await originalSend(message);if(message.type==='session'){await new Promise(resolve=>setTimeout(resolve,1500));document.documentElement.dataset.fixtureStartupReply='returned';}return result;};`);
    assert.equal(await readFile(path.join(copy,'content.js'),'utf8'),await readFile(path.join(EXTENSION,'content.js'),'utf8'));
    const id='b'.repeat(32),url=`http://127.0.0.1:${PORT_A}/test-pages/library-submit.html`;
    await writeFile(path.join(env.root,'handoff',id+'.json'),JSON.stringify({id,site:'probekits',source_domain:'127.0.0.1',submit_url:url,
      status:'待处理',blocker:'人工验证',blocker_location:'当前表单',fields:[{label:'Product name',key:'name',value:'ProbeKits'}],steps:[],step:0,
      created_at:new Date().toISOString().slice(0,19)}));
    browser=await launchBrowser(env,{},copy);
    const page=await browser.context.newPage();await page.goto(url+'#bk='+id);
    await page.waitForFunction(()=>document.querySelector('#product-url').value==='https://probekits.com/',null,{timeout:5000});
    assert.equal(await page.getAttribute('html','data-fixture-startup-reply'),null,'应在初始会话回包前已填写');
    await page.fill('#verification','123456');await page.getByRole('button',{name:'Submit listing'}).click();
    assert.equal(await page.getAttribute('body','data-submissions'),'1');
    let record;
    for(let attempt=0;attempt<50;attempt++){
      record=JSON.parse(await readFile(path.join(env.root,'handoff',id+'.json'),'utf8'));
      if(record.attempted_at)break;
      await page.waitForTimeout(50);
    }
    assert.ok(record.attempted_at,'投稿发生于启动期间也不能漏掉持久提交尝试');
    assert.equal(record.status,'结果未知');
  }finally{await browser?.context.close();await env.stop();await env.cleanup();}
});

test('首次item请求尚未回包时，原生人工投稿仍记录未知并阻止迟到填写', {timeout: 30000}, async () => {
  const env = await startEnvironment(); let browser;
  try {
    const copy = path.join(env.root, 'item-latency-extension'); await cp(EXTENSION, copy, {recursive: true});
    const file = path.join(copy, 'background.js');
    const source = await readFile(file, 'utf8');
    await writeFile(file, `const fixtureFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (...args) => {
  if (String(args[0]).includes('/api/item?')) {
    globalThis.fixtureItemEntered = true;
    globalThis.fixtureItemGate ||= new Promise(resolve => {globalThis.fixtureReleaseItem = resolve;});
    await globalThis.fixtureItemGate;
  }
  return fixtureFetch(...args);
};\n` + source);
    assert.equal(await readFile(path.join(copy, 'content.js'), 'utf8'), await readFile(path.join(EXTENSION, 'content.js'), 'utf8'));
    const id = 'c'.repeat(32), url = `http://127.0.0.1:${PORT_A}/test-pages/library-submit.html`;
    const recordFile = path.join(env.root, 'handoff', id + '.json');
    await writeFile(recordFile, JSON.stringify({id, site: 'probekits', source_domain: '127.0.0.1', submit_url: url,
      status: '待处理', blocker: '人工验证', blocker_location: '当前表单', fields: [], steps: [], step: 0,
      created_at: new Date().toISOString().slice(0, 19)}));
    browser = await launchBrowser(env, {}, copy);
    const page = await browser.context.newPage(); await page.goto(url + '#bk=' + id);
    await browser.worker.evaluate(async () => {
      while (!globalThis.fixtureItemEntered) await new Promise(resolve => setTimeout(resolve, 10));
    });
    assert.equal(await page.inputValue('#product-name'), '', '首次资料仍未读回，不应先填写');
    await page.fill('#product-name', 'Human product');
    await page.fill('#product-url', 'https://manual.example/');
    await page.fill('#verification', '123456');
    await page.getByRole('button', {name: 'Submit listing'}).click();
    assert.equal(await page.getAttribute('body', 'data-submissions'), '1');
    assert.equal(await browser.worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(item => item.url === url);
      return (await chrome.storage.session.get('tab:' + tab.id))['tab:' + tab.id]?.submitted;
    }, page.url()), true, '未核实原始任务ID前也要立即锁住本页');
    await browser.worker.evaluate(() => globalThis.fixtureReleaseItem());
    let record;
    for (let attempt = 0; attempt < 50; attempt++) {
      record = JSON.parse(await readFile(recordFile, 'utf8'));
      if (record.attempted_at) break;
      await page.waitForTimeout(50);
    }
    assert.ok(record.attempted_at); assert.equal(record.status, '结果未知');
    assert.equal(await page.inputValue('#product-name'), 'Human product');
    assert.equal(await page.inputValue('#product-url'), 'https://manual.example/');
  } finally {await browser?.context.close(); await env.stop(); await env.cleanup();}
});

test('真实快照复原稳定等待期间换项目，旧项目快照不写进新会话', {timeout: 30000}, async () => {
  const env = await startEnvironment(); let browser;
  try {
    browser = await launchBrowser(env);
    const page = await browser.context.newPage();
    await page.goto(`http://127.0.0.1:${PORT_A}/test-pages/library-submit.html`);
    await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus);
    await activate(page);
    await page.waitForFunction(() => document.querySelector('#product-name').value === 'ProbeKits');
    const saved = await browser.worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(item => item.url === url);
      const snapshot = (await chrome.tabs.sendMessage(tab.id, {type: 'page:snapshot'}, {frameId: 0})).value.snapshot;
      const context = (await chrome.storage.session.get('tab:' + tab.id))['tab:' + tab.id].context;
      return {tabId: tab.id, snapshot, context};
    }, page.url());
    const field = saved.snapshot.steps[saved.snapshot.step_index].fields.find(item => item.locator.id === 'product-name');
    assert.ok(field); field.value = 'PRIVATE-A-VALUE';
    await page.evaluate(() => {document.querySelector('#product-name').value = '';});
    const result = await browser.worker.evaluate(async ({tabId, snapshot, context}) => {
      const pending = chrome.tabs.sendMessage(tabId, {type: 'page:restore', snapshot}, {frameId: 0});
      await chrome.tabs.sendMessage(tabId, {type: 'page:adopt', context: {...context, site: 'other-product',
        record: {id: 'd'.repeat(32)}}}, {frameId: 0});
      return pending;
    }, saved);
    assert.match(result.error, /上下文.*变化/);
    assert.notEqual(await page.inputValue('#product-name'), 'PRIVATE-A-VALUE');
  } finally {await browser?.context.close(); await env.stop(); await env.cleanup();}
});
