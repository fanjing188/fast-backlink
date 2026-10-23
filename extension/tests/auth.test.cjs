const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {harness} = require('./harness.cjs');
const source = path.join(__dirname, '..', 'lib', 'auth-policy.js');
const policy = () => {
  assert.ok(fs.existsSync(source), '登录策略模块应存在');
  const sandbox = {URL, module: {exports: {}}};
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), sandbox);
  return sandbox.module.exports;
};

test('登录提交与投稿提交隔离；Google和登录路由永不接受产品资料', () => {
  const p = policy();
  assert.equal(p.loginURL('https://accounts.google.com/o/oauth2/auth?code=secret'), true);
  assert.equal(p.loginURL('https://directory.test/auth/login'), true);
  assert.equal(p.loginURL('https://directory.test/submit'), false);
  assert.equal(p.loginURL('https://directory.test/callback?code=secret&state=private'), true);
  assert.equal(p.canFill({kind: 'login'}, 'https://directory.test/submit', 'https://directory.test/submit'), false);
  assert.equal(p.canFill({kind: 'form'}, 'https://evil.test/submit', 'https://directory.test/submit'), false);
  assert.equal(p.canFill({kind: 'form'}, 'https://directory.test/submit', 'https://directory.test/submit'), true);
});

test('Google候选只精确匹配已授权账号，首次授权和跨域动作不能由模型放行', () => {
  const p = policy();
  const probe = {kind: 'google', candidates: [{id: 'a', action: 'account', email: 'other@example.test'}, {id: 'b', action: 'account', email: 'maker@example.test'}]};
  assert.equal(p.choose(probe, 'maker@example.test').id, 'b');
  assert.equal(p.choose(probe, 'unknown@example.test'), null);
  assert.equal(p.choose({...probe, kind: 'manual'}, 'maker@example.test'), null);
  assert.equal(p.allowedURL('https://accounts.google.com.evil.test/', ['https://directory.test']), false);
  assert.equal(p.allowedURL('http://accounts.google.com/', ['https://directory.test']), false);
  assert.equal(p.allowedURL('https://accounts.google.com/v3/signin/accountchooser', ['https://directory.test']), true);
  const login = {kind: 'login', candidates: [{id: 'x', action: 'login'}, {id: 'g', action: 'google'}]};
  assert.equal(p.choose(login, '').id, 'g');
  assert.equal(p.choose({kind: 'login', candidates: [{id: 'x', action: 'login'}, {id: 'y', action: 'login'}]}, ''), null);
});

test('Google弹窗必须匹配本次OAuth请求的客户端、回调、基础scope与state',()=>{
  const p=policy(), origins=['https://directory.test'];
  const query='client_id=fixture.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fdirectory.test%2Fcallback&scope=openid%20email%20profile&state=nonce';
  const expected=p.oauthContext('https://accounts.google.com/o/oauth2/v2/auth?'+query);
  assert.ok(expected);
  assert.equal(p.matchesOAuth(expected,'https://accounts.google.com/o/oauth2/v2/auth?'+query,origins),true);
  assert.equal(p.matchesOAuth(expected,'https://accounts.google.com/o/oauth2/v2/auth?'+query.replace('state=nonce','state=other'),origins),false);
  assert.equal(p.matchesOAuth(null,'https://accounts.google.com/AccountChooser',origins),false);
  assert.equal(p.matchesOAuth(expected,'https://accounts.google.com/o/oauth2/v2/auth?'+query.replace('directory.test','evil.test'),origins),false);
  assert.equal(p.matchesOAuth(expected,'https://accounts.google.com/o/oauth2/v2/auth?'+query.replace('openid%20email%20profile','https%3A%2F%2Fmail.google.com%2F'),origins),false);
});

test('登录授权不能由内容脚本创建，Google页与跨域继承页不下发产品资料', async () => {
  const h = harness();
  const blocked = await h.send({type: 'auth:grant', email: 'maker@example.test'}, h.page);
  assert.match(blocked.error, /仅允许扩展页面/);
  h.sessionStore['tab:1'] = {site: 'probekits', context: {site: 'probekits', submit_url: 'https://source.example/form', kit: {secret: 'product'}}};
  const google = await h.send({type: 'session', url: 'https://accounts.google.com/AccountChooser'}, h.page);
  assert.equal(google.value, null);
  const other = await h.send({type: 'session', url: 'https://unrelated.test/home'}, h.page);
  assert.equal(other.value, null);
});

test('点击前持久记录，重复检查与worker实例更换均不重放；停止后不再点击', async () => {
  const h = harness(); let clicks = 0;
  h.sessionStore['tab:1'] = {site: 'probekits', entryURL: 'https://source.example/form'};
  h.sandbox.chrome.tabs.get = async id => ({id, status: 'complete', url: 'https://source.example/form'});
  const probe = {document: 'doc', kind: 'login', candidates: [{id: 'doc-google', action: 'google', label: 'Continue with Google'}]};
  h.sandbox.chrome.tabs.sendMessage = async (id, m) => ({value: m.type === 'auth:probe' ? probe : {selector: '#google', document: 'doc', url: 'https://source.example/form', label: 'Continue with Google'}});
  h.sandbox.CDP.clickElement = async () => {
    assert.equal(h.sessionStore['auth:1'].attempted[0], 'doc-google'); clicks++; return {ok: true};
  };
  await h.send({type: 'auth:grant', tabId: 1, email: 'maker@example.test'}, {});
  await h.send({type: 'auth:start', tabId: 1}, {});
  await h.send({type: 'auth:resume', tabId: 1}, {});
  const restarted = h.sandbox.BKAuthFlow.create({chrome: h.sandbox.chrome, request: async () => ({}),
    readTab: async () => h.sessionStore['tab:1'], buildSession: async () => ({}), CDP: h.sandbox.CDP});
  await restarted.step(1);
  assert.equal(clicks, 1);
  await h.send({type: 'auth:cancel', tabId: 1}, {});
  probe.document = 'new-doc'; probe.candidates[0].id = 'new-doc-google';
  await restarted.step(1, true);
  assert.equal(clicks, 1);
  assert.equal(h.sessionStore['auth:1'].state, 'cancelled');
});

test('准备点击期间切换产品，旧任务不得继续派发登录动作', async () => {
  const h = harness(); let clicks = 0;
  h.sessionStore['tab:1'] = {site: 'probekits', entryURL: 'https://source.example/form'};
  h.sandbox.chrome.tabs.get = async id => ({id, status: 'complete', url: 'https://source.example/form'});
  h.sandbox.chrome.tabs.sendMessage = async (id, m) => {
    if (m.type === 'auth:probe') return {value:{document:'doc',kind:'login',candidates:[{id:'doc-google',action:'google',label:'Continue with Google'}]}};
    if (m.type === 'auth:target') h.sessionStore['tab:1'].site = 'raumlens';
    return {value:{selector:'#google',document:'doc',url:'https://source.example/form',label:'Continue with Google'}};
  };
  h.sandbox.CDP.clickElement = async () => {clicks++;return {ok:true};};
  await h.send({type:'auth:grant',tabId:1,email:'maker@example.test'},{});
  try {await h.send({type:'auth:start',tabId:1},{});assert.equal(clicks,0);}
  finally {await h.send({type:'auth:cancel',tabId:1},{});}
});
