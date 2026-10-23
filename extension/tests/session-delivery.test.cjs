const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {harness} = require('./harness.cjs');

test('设置读取屏障后的旧source不能投递到已绑定item的内容脚本', async () => {
  const h = harness();
  const id = 'a'.repeat(32);
  const context = {site:'fixture',source_domain:'source.example',submit_url:'https://source.example/form',record:null};
  h.sandbox.fetch = async url => ({ok:true,headers:{get:()=> 'application/json'},json:async()=>
    String(url).includes('api/source') ? context : String(url).includes('api/item') ? {...context,record:{id}} : {}});
  const delivered = [];
  h.sandbox.chrome.tabs.sendMessage = async (_id, message) => {
    if (message.type === 'auth:probe') return {value:{kind:'form'}};
    delivered.push(message);
    return {value:{ok:true}};
  };
  vm.runInContext(`
    globalThis.reachedSettings = new Promise(resolve => {globalThis.signalSettings = resolve;});
    globalThis.settingsBarrier = new Promise(resolve => {globalThis.releaseSettings = resolve;});
    const actualSettings = settings;
    let delayFirstSettings = true;
    settings = async () => {
      if (delayFirstSettings) {delayFirstSettings = false; signalSettings(); await settingsBarrier;}
      return actualSettings();
    };
  `, h.sandbox);
  const sender = {tab:{id:1,url:context.submit_url},url:context.submit_url,frameId:0};
  const stale = h.send({type:'session',site:'fixture',url:context.submit_url},sender);
  await h.sandbox.reachedSettings;
  assert.equal((await h.send({type:'session',id,url:context.submit_url},sender)).value.context.record.id,id);
  await h.send({type:'submitted'},sender);
  h.sandbox.releaseSettings();
  assert.equal((await stale).value,null);
  assert.equal(delivered.some(m=>['page:session','page:adopt'].includes(m.type) && !m.context?.record?.id),false);
  assert.equal(h.sessionStore['tab:1'].context.record.id,id);
  assert.equal(h.sessionStore['tab:1'].submitted,true);
});

test('实际adoptContext拒绝同来源的无ID降级，同时允许显式不同产品', () => {
  const source = fs.readFileSync(path.join(__dirname,'../content.js'),'utf8');
  const start = source.indexOf('function adoptContext(');
  const end = source.indexOf('\n  }',start)+4;
  assert.ok(start>0 && end>start);
  const context = {site:'fixture',source_domain:'source.example',record:{id:'a'.repeat(32)}};
  const sandbox = {state:{session:context,submitted:true}};
  const adopt = vm.runInNewContext('('+source.slice(start,end)+')',sandbox);
  assert.equal(adopt({...context,record:null},false),false);
  assert.equal(sandbox.state.session.record.id,'a'.repeat(32));
  assert.equal(sandbox.state.submitted,true);
  assert.equal(adopt({...context,site:'other',record:null},false),true);
  assert.equal(sandbox.state.session.site,'other');
  assert.equal(sandbox.state.submitted,false);
});

test('真实worker夹具的项目初始化不被在途frame写回覆盖', async () => {
  const h = harness();
  const source = fs.readFileSync(path.join(__dirname, '../e2e/session-binding.test.mjs'), 'utf8');
  const hook = source.match(/const hook = `([\s\S]*?)`;/)[1];
  vm.runInContext(hook + '\nglobalThis.fixtureWriteTab = writeTab;', h.sandbox);
  let enter, release;
  const reached = new Promise(resolve => {enter = resolve;});
  const held = new Promise(resolve => {release = resolve;});
  const originalSet = h.sandbox.chrome.storage.session.set;
  let first = true;
  h.sandbox.chrome.storage.session.set = async patch => {
    if (first) {first = false; enter(); await held;}
    return originalSet(patch);
  };
  const frame = h.sandbox.fixtureWriteTab(1, {frames: {0: {top: true}}});
  await reached;
  const seed = h.sandbox.__fixtureSetSite(1, 'probekits');
  release();
  await Promise.all([frame, seed]);
  assert.equal(h.sessionStore['tab:1'].site, 'probekits');
  assert.equal(h.sessionStore['tab:1'].frames[0].top, true);
});
