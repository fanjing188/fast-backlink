const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const h = harness();
  h.sessionStore['tab:1'] = {site:'probekits',entryURL:'https://source.example/form',pendingItem:'item-A'};
  h.probe = {document:'doc-1',kind:'login',candidates:[{id:'doc-1-google',action:'google',label:'Continue with Google'}]};
  h.sandbox.chrome.tabs.get = async id => ({id,status:'complete',url:'https://source.example/form'});
  h.sandbox.chrome.tabs.sendMessage = async (id,m) => {
    h.messages.push({tabId:id,message:m});
    return {value:m.type==='auth:probe' ? h.probe : {selector:'#google',document:h.probe.document,url:'https://source.example/form',label:'Continue with Google'}};
  };
  h.clicks=0; h.sandbox.CDP.clickElement=async()=>{h.clicks++;return {ok:true};};
  await h.send({type:'auth:grant',tabId:1,email:'maker@example.test'},{});
  h.start=()=>h.send({type:'auth:start',tabId:1},{});
  h.stop=()=>h.send({type:'auth:cancel',tabId:1},{});
  return h;
}

test('停止与waiting写回竞态：迟到保存不能复活任务或派发点击', {timeout:3000}, async()=>{
  const h=await fixture(); const set=h.sandbox.chrome.storage.session.set;
  let release, reached;const held=new Promise(resolve=>release=resolve), ready=new Promise(resolve=>reached=resolve);
  h.sandbox.chrome.storage.session.set=async data=>{
    if(data['auth:1']?.state==='waiting'){reached();await held;}
    return set(data);
  };
  const started=h.start();await ready;
  const stopped=h.stop();await tick();release();await Promise.all([started,stopped]);
  const status=(await h.send({type:'auth:status',tabId:1},{})).value.task.state;await h.stop();
  assert.equal(h.clicks,0);
  assert.equal(status,'cancelled');
});

test('未知点击刷新文档后继续只能读回，不能重放同一阶段',async()=>{
  const h=await fixture();h.sandbox.CDP.clickElement=async()=>{h.clicks++;throw Error('outcome_unknown');};
  await h.start();h.probe.document='doc-2';h.probe.candidates[0].id='doc-2-google';
  await h.send({type:'auth:resume',tabId:1},{});
  await h.stop();assert.equal(h.clicks,1);
});

test('同产品切换续填项与入口后旧登录任务不得接回旧条目',async()=>{
  const h=await fixture();await h.start();
  h.sessionStore['tab:1'].pendingItem='item-B';h.sessionStore['tab:1'].entryURL='https://source.example/other-form';
  h.probe={document:'returned',kind:'form',candidates:[]};
  await h.send({type:'auth:resume',tabId:1},{});
  const status=(await h.send({type:'auth:status',tabId:1},{})).value.task.state;await h.stop();
  assert.equal(h.messages.some(m=>m.message.type==='page:session'),false);
  assert.notEqual(status,'complete');
});

test('等待期间无关Google窗口不能因opener而自动选择账号',async()=>{
  const h=await fixture();await h.start();
  h.sandbox.chrome.tabs.get=async id=>({id,status:'complete',url:id===1?'https://source.example/form':'https://accounts.google.com/AccountChooser?unrelated=1'});
  const previous=h.sandbox.chrome.tabs.sendMessage;
  h.sandbox.chrome.tabs.sendMessage=async(id,m)=>id===2&&m.type==='auth:probe'?{value:{document:'other',kind:'google',candidates:[{id:'other-account',action:'account',email:'maker@example.test'}]}}:previous(id,m);

  // 与真实后台使用相同存储创建一个恢复实例，验证新窗口不会获操作资格。
  const flow=h.sandbox.BKAuthFlow.create({chrome:h.sandbox.chrome,request:async()=>({}),readTab:async()=>h.sessionStore['tab:1'],buildSession:async()=>({}),CDP:h.sandbox.CDP});
  await flow.created({id:2,openerTabId:1});await flow.step(1,true);
  await h.stop();assert.equal(h.clicks,1);
});

test('完成会话写入等待期间真实切换项目，旧会话不能覆盖新控制状态或下发', {timeout:3000}, async()=>{
  const h=await fixture();await h.start();h.probe={document:'returned',kind:'form',candidates:[]};
  const set=h.sandbox.chrome.storage.session.set;
  let release,reached;const held=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>reached=resolve);
  let blocked=false;
  h.sandbox.chrome.storage.session.set=async data=>{
    if(!blocked && data['tab:1']?.context){blocked=true;reached();await held;}
    return set(data);
  };
  const resumed=h.send({type:'auth:resume',tabId:1},{});await ready;
  const changed=h.send({type:'panel:activate',tabId:1,site:'raumlens'},{});await tick();release();
  await Promise.all([resumed,changed]);
  const stale=h.messages.filter(m=>m.message.type==='page:session');
  await h.stop();
  assert.equal(h.sessionStore['tab:1'].site,'raumlens');
  assert.equal(stale.length,0);
});

test('完成写回等待期间真实切换同产品条目，旧item会话不得下发', {timeout:5000}, async()=>{
  const h=await fixture();await h.start();h.probe={document:'returned',kind:'form',candidates:[]};
  const fetch=h.sandbox.fetch;
  h.sandbox.fetch=async(url,options)=>url.includes('api/item?id=item-B')?{ok:true,json:async()=>({site:'probekits',source_domain:'source.example',
    submit_url:'https://source.example/form',record:{id:'item-B'},kit:{fields:{}},assets:[]})}:fetch(url,options);
  const set=h.sandbox.chrome.storage.session.set;
  let release,reached;const held=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>reached=resolve);
  let blocked=false;
  h.sandbox.chrome.storage.session.set=async data=>{
    if(!blocked && data['tab:1']?.context){blocked=true;reached();await held;}
    return set(data);
  };
  const resumed=h.send({type:'auth:resume',tabId:1},{});await ready;
  const changed=h.send({type:'agent:execute',command:{action:'fill',args:{tabId:1,item:'item-B'}}},{});
  await tick();release();await Promise.all([resumed,changed]);
  const stale=h.messages.filter(m=>m.message.type==='page:session'&&m.message.context.record.id!=='item-B');
  await h.stop();
  assert.equal(h.sessionStore['tab:1'].pendingItem,'item-B');
  assert.equal(h.sessionStore['tab:1'].context.record.id,'item-B');
  assert.equal(stale.length,0);
});

test('接续请求期间已发生投稿，迟到会话不能洗掉提交锁或重新填写',async()=>{
  const h=harness();h.sessionStore['tab:1']={site:'probekits',context:{site:'probekits',source_domain:'source.example',
    submit_url:'https://source.example/form',record:{id:'a'.repeat(32)}}};
  const fetch=h.sandbox.fetch;let release,reached;
  const held=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>reached=resolve);
  h.sandbox.fetch=async(url,options)=>{if(url.includes('api/rules')){reached();await held;}return fetch(url,options);};
  const pending=h.send({type:'session',url:'https://source.example/form'},h.page);await ready;
  await h.send({type:'submitted'},h.page);release();const result=await pending;
  assert.equal(result.value,null);
  assert.equal(h.sessionStore['tab:1'].submitted,true);
  assert.equal(h.messages.some(m=>m.message.type==='page:session'),false);
  assert.equal(h.requests.filter(r=>r.url.endsWith('/api/submission-attempt')).length,1);
});
