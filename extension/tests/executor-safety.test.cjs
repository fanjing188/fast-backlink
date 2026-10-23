const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {harness} = require('./harness.cjs');
const ID = 'a'.repeat(32);
const URL = 'https://source.example/form';
function bound(h, patch = {}) {
  h.sessionStore['tab:1'] = {site: 'probekits', pendingItem: ID, entryURL: URL,
    context: {site: 'probekits', source_domain: 'source.example', submit_url: URL, record: {id: ID}}, ...patch};
  return h.sessionStore['tab:1'];
}
function job(h) {
  const value = {id: ID, site: 'probekits', domain: 'source.example', url: URL, tabId: 1,
    batch_id: 'b', lease: 'one', owner: 'test'};
  return h.sandbox.chrome.storage.local.set({batchJobs: {[ID]: value}}).then(() => value);
}

test('同tab并发frame报告按最新状态merge，不丢掉其他frame', async () => {
  const h = harness();
  await Promise.all([0, 1, 2, 3].map(frameId => h.send({type: 'frame:report', summary: {step: frameId}}, {...h.page, frameId})));
  assert.deepEqual(Object.keys(h.sessionStore['tab:1'].frames).sort(), ['0', '1', '2', '3']);
});

test('同tab控制写入串行递增taskGeneration，等价入口刷新保留最新代次', async () => {
  const h = harness(); bound(h, {taskGeneration: 4});
  await vm.runInContext("Promise.all([writeTab(1, {step: 1}, {control: true}), writeTab(1, tab => ({step: tab.step + 1}), {control: true})])", h.sandbox);
  assert.equal(h.sessionStore['tab:1'].taskGeneration, 6);
  assert.equal(h.sessionStore['tab:1'].step, 2);
  await vm.runInContext(`recordEntry(1, {site: 'probekits', item: '${ID}', url: '${URL}'})`, h.sandbox);
  assert.equal(h.sessionStore['tab:1'].taskGeneration, 6);
});

test('writeTab兼容public函数eligible与Google异步guard，patch始终在队列内合并', async () => {
  const h = harness(); bound(h, {step: 0});
  await vm.runInContext(`Promise.all([
    writeTab(1, tab => ({step: tab.step + 1}), async () => true),
    writeTab(1, tab => ({step: tab.step + 1}), {guard: async () => true}),
    writeTab(1, () => {throw Error('拒绝的patch不应执行');}, {guard: async () => false})
  ])`, h.sandbox);
  assert.equal(h.sessionStore['tab:1'].step, 2);
  assert.equal(h.sessionStore['tab:1'].context.record.id, ID);
});

test('同任务再取source的无ID降级被拒绝，仍可对当前item记录投稿', async () => {
  const h = harness(); bound(h, {pendingItem: null});
  const fetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => {
    const response = await fetch(url, options);
    return url.includes('/api/source') ? {...response, json: async () => ({...h.sessionStore['tab:1'].context, record: null})} : response;
  };
  assert.equal((await h.send({type: 'session', site: 'probekits', url: URL}, h.page)).value, null);
  assert.equal(h.sessionStore['tab:1'].context.record.id, ID);
  await h.send({type: 'submitted'}, h.page);
  assert.equal(JSON.parse(h.requests.find(r => r.url.endsWith('/api/submission-attempt')).options.body).id, ID);
});

test('设置await后重新读取实际提交状态，不下发更早的false', async () => {
  const h = harness(); bound(h);
  const get = h.sandbox.chrome.storage.local.get;
  h.sandbox.chrome.storage.local.get = async key => {
    if (key === 'settings') h.sessionStore['tab:1'].submitted = true;
    return get(key);
  };
  const result = await h.send({type: 'session', url: URL}, h.page);
  assert.equal(result.value.submitted, true);
  assert.equal(h.messages.at(-1).message.type, 'page:adopt');
});

test('同产品新任务尚未读回时，投稿以可信pendingItem为准而非残留context', async () => {
  const h = harness();
  bound(h, {pendingItem: 'b'.repeat(32)});
  await h.send({type: 'submitted'}, h.page);
  const attempt = h.requests.find(r => r.url.endsWith('/api/submission-attempt'));
  assert.equal(JSON.parse(attempt.options.body).id, 'b'.repeat(32));
});

test('提交先于item首次读回，可信pendingItem的本地提交锁不能被false清除', async () => {
  const h = harness();
  bound(h, {context: null, submitted: true});
  const result = await h.send({type: 'session', url: URL}, h.page);
  assert.equal(result.value.submitted, true);
  assert.equal(h.sessionStore['tab:1'].submitted, true);
  assert.equal(h.messages.at(-1).message.type, 'page:adopt');
});

test('AI配置UI使用configure/patch合同，网页不能读取配置或测试密钥', async () => {
  const h = harness();
  const fetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => url.includes('/api/ai_') ? {
    ok: true, json: async () => ({configured: true, api_key_configured: true, model: 'fixture'})
  } : fetch(url, options);
  for (const type of ['ai:configure', 'ai:test']) {
    const denied = await h.send({type, patch: {api_key: 'synthetic-key'}}, h.page);
    assert.match(denied.error, /扩展页面/);
    let posted;
    const original = h.sandbox.fetch;
    h.sandbox.fetch = async (url, options) => {posted = {url, options}; return original(url, options);};
    const result = await h.send({type, patch: {model: 'fixture', api_key: 'synthetic-key'}}, {});
    h.sandbox.fetch = original;
    assert.equal(result.value.configured, true);
    assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
    assert.deepEqual(JSON.parse(posted.options.body), {model: 'fixture', api_key: 'synthetic-key'});
    assert.ok(posted.url.endsWith(type === 'ai:test' ? '/api/ai_test' : '/api/ai_config'));
  }
});

for (const changed of ['site', 'source', 'record', 'url']) {
  test(`批量授权前${changed}绑定变化，不能按tabId给旧任务请求授权`, async () => {
    const h = harness(); const state = bound(h); await job(h);
    if (changed === 'site') state.site = 'other';
    if (changed === 'source') state.context.source_domain = 'other.example';
    if (changed === 'record') state.context.record.id = 'b'.repeat(32);
    if (changed === 'url') state.entryURL = 'https://source.example/other';
    const result = await h.send({type: 'batch:authorize'}, h.page);
    assert.ok(result.error);
    assert.equal(h.requests.some(r => r.url.endsWith('/api/batch_attempt')), false);
  });
}

test('批量授权HTTP等待后再次核当前持久身份，项目变更时不返回可用permit', async () => {
  const h = harness(); bound(h); await job(h);
  const fetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => {
    if (url.endsWith('/api/batch_attempt')) {
      h.sessionStore['tab:1'].site = 'other';
      return {ok: true, json: async () => ({authorized: true, id: ID})};
    }
    return fetch(url, options);
  };
  const result = await h.send({type: 'batch:authorize'}, h.page);
  assert.ok(result.error);
});

test('自动批量读回核业务绑定，其他产品页面的成功文字不能记给旧任务', async () => {
  const h = harness(); const state = bound(h, {site: 'other'}); const task = await job(h);
  h.sandbox.chrome.tabs.sendMessage = async () => ({value: {result: 'success'}});
  h.sandbox.jobFixture = task;
  const result = await vm.runInContext('batchInspect(1, {attempted: true, job: jobFixture})', h.sandbox);
  assert.equal(result.result, 'unknown');
  assert.equal(h.requests.some(r => r.url.endsWith('/api/batch_resolve')), false);
});

test('网页不能控制批量任务或批量维护外链库，非内容脚本不能领取提交授权', async () => {
  const h = harness();
  for (const type of ['library:bulk', 'library:export', 'library:import', 'library:import-preview',
    'batch:command', 'batch:preview', 'batch:resolve', 'batch:open']) {
    assert.match((await h.send({type, data: {}}, h.page)).error, /仅允许扩展页面/);
  }
  assert.match((await h.send({type: 'batch:authorize'}, {})).error, /仅允许批量页面/);
  assert.match((await h.send({type: 'batch:authorize'}, h.page)).error, /不属于活动批量任务/);
});

test('CLI批量命令走Agent白名单，状态数组封装及停止接口均保留', async () => {
  const h = harness();
  h.sandbox.fetch = async () => ({ok: true, json: async () => []});
  const reply = await h.send({type: 'agent:execute', command: {action: 'batch', args: {action: 'status'}}}, {});
  assert.deepEqual(JSON.parse(JSON.stringify(reply.value)), {batches: []});
  const other = harness();
  assert.equal((await other.send({type: 'agent:execute', command: {action: 'batch', args: {action: 'stop', id: 'b'}}}, {})).error, undefined);
  assert.ok(other.requests.some(r => r.url.endsWith('/api/batch_control')));
});

test('人工复核也核产品来源任务，其他产品成功文字不落到原任务', async () => {
  const h = harness();
  const task = await job(h);
  await h.sandbox.chrome.storage.local.set({batchReviews: {1: {...task, source: task.domain}}});
  bound(h, {site: 'other', submitted: true});
  h.sandbox.chrome.tabs.sendMessage = async () => ({value: {result: 'success', hasForm: true}});
  await vm.runInContext('batchExecutor = {tick: async () => {}}; batchTick()', h.sandbox);
  assert.equal(h.requests.some(r => r.url.endsWith('/api/batch_resolve')), false);
});

// 直接运行源码中的提交handler，固定DOM身份；这是Node合同测试，不冒充真实浏览器。
function submitFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const marker = "'page:batch-submit': ";
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("\n      'page:fill':", start);
  const root = {};
  const form = {action: URL, method: 'post'};
  const element = {form, getRootNode: () => root};
  const target = {form, value: '', textContent: 'Submit', isConnected: true, disabled: false,
    type: 'submit', getAttribute: () => null, getRootNode: () => root};
  let clicks = 0, permit;
  target.click = () => clicks++;
  const entry = {element, field: {index: 0, label: 'Product name', inputType: 'text'}};
  const state = {session: {site: 'probekits', source_domain: 'source.example', record: {id: ID}, submit_url: URL}, entries: [entry], decisions: new Map()};
  const sandbox = {state, location: {href: URL}, document: {documentElement: {}, querySelectorAll: () => [target]},
    F: {visible: () => true, read: () => 'Synthetic'}, scan: () => {}, contentAllowed: () => true, loginPage: () => false,
    BKBatchPage: {inspect: () => ({canSubmit: true})}, send: () => new Promise(resolve => {permit = () => resolve({authorized: true, id: ID});})};
  const handler = vm.runInNewContext('(' + source.slice(start, end).trim().replace(/,$/, '') + ')', sandbox);
  return {state, target, form, sandbox, run: handler, permit: () => permit(), clicks: () => clicks};
}
for (const mutation of ['same-binding-refresh', 'button-form', 'form-action', 'button-type', 'document', 'source', 'record']) {
  test(`授权等待期间${mutation}后按持久任务和完整按钮归属决定是否点击`, async () => {
    const f = submitFixture();
    const pending = f.run().then(() => null, error => error.message);
    if (mutation === 'same-binding-refresh') f.state.session = {...f.state.session, record: {...f.state.session.record}};
    if (mutation === 'button-form') f.target.form = {};
    if (mutation === 'form-action') f.form.action = 'https://other.example/pay';
    if (mutation === 'button-type') f.target.type = 'reset';
    if (mutation === 'document') f.sandbox.document.documentElement = {};
    if (mutation === 'source') f.state.session.source_domain = 'other.example';
    if (mutation === 'record') f.state.session.record.id = 'b'.repeat(32);
    f.permit();
    const error = await pending;
    assert.equal(f.clicks(), mutation === 'same-binding-refresh' ? 1 : 0);
    if (mutation === 'same-binding-refresh') assert.equal(error, null);
    else assert.ok(error);
  });
}
