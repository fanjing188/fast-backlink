const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness.cjs');


test('侧栏AI命令遵守显式目标标签，不把命令发给当前活动的扩展页', async () => {
  const h = harness();
  await h.send({type: 'panel:command', tabId: 2, command: 'page:ai', data: {action: 'fill'}}, {});
  assert.equal(h.messages.find(item => item.message.type === 'page:ai').tabId, 2);
});

test('侧栏选定项目后持久保存，清空短期会话的新页面沿用默认项目', async () => {
  const h = harness();
  const selected = await h.send({type: 'panel:activate', site: 'probekits'}, {});
  assert.equal(selected.error, undefined);
  assert.equal((await h.sandbox.chrome.storage.local.get('preferredSite')).preferredSite, 'probekits');
  for (const key of Object.keys(h.sessionStore)) delete h.sessionStore[key];
  const page = {...h.page, tab: {id: 2}};
  const session = await h.send({type: 'session', url: page.url}, page);
  assert.equal(session.value.context.site, 'probekits');
});

test('默认项目不能覆盖显式续填任务绑定的项目，也不因后台任务改写默认值', async () => {
  const h = harness();
  await h.sandbox.chrome.storage.local.set({preferredSite: 'raumlens'});
  const result = await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  assert.equal(result.value.context.site, 'probekits');
  assert.equal((await h.sandbox.chrome.storage.local.get('preferredSite')).preferredSite, 'raumlens');
});

test('侧栏没有当前页面会话时仍显示已保存项目，不必再次选择', async () => {
  const h = harness();
  await h.sandbox.chrome.storage.local.set({preferredSite: 'probekits'});
  const result = await h.send({type: 'panel:state'}, {});
  assert.equal(result.value.site, 'probekits');
});

test('旧页面请求采纳默认项目时只建立会话，不抢先执行整页填写', async () => {
  const h = harness();
  await h.sandbox.chrome.storage.local.set({preferredSite: 'probekits'});
  await h.send({type: 'session', url: h.page.url, adopt: true}, h.page);
  assert.equal(h.sessionStore['tab:1'].context.site, 'probekits');
  assert.ok(h.messages.some(item => item.message.type === 'page:adopt'));
  assert.ok(!h.messages.some(item => item.message.type === 'page:session'));
});

test('快速切换项目时旧请求迟到不会覆盖最后选择', async () => {
  const h = harness();
  const original = h.sandbox.fetch;
  let release;
  const slow = new Promise(resolve => {release = resolve;});
  h.sandbox.fetch = async (url, options) => {
    if (url.includes('api/kit?site=probekits')) await slow;
    return original(url, options);
  };
  const first = h.send({type: 'panel:activate', site: 'probekits'}, {});
  await h.flush();
  await h.send({type: 'panel:activate', site: 'raumlens'}, {});
  release();
  await first;
  assert.equal((await h.sandbox.chrome.storage.local.get('preferredSite')).preferredSite, 'raumlens');
  assert.equal(h.sessionStore['tab:1'].site, 'raumlens');
});

test('迟到的默认项目不能覆盖显式任务或解除提交锁', async () => {
  const h = harness();
  await h.sandbox.chrome.storage.local.set({preferredSite: 'raumlens'});
  const original = h.sandbox.fetch;
  let release, began;
  const delayed = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {began = resolve;});
  h.sandbox.fetch = async (url, options) => {
    if (url.includes('api/item')) return {ok: true, json: async () => ({site: 'probekits',
      source_domain: 'source.example', submit_url: h.page.url, record: {id: 'a'.repeat(32)}, submission_locked: true})};
    if (url.includes('api/source')) {
      began(); await delayed;
      return {ok: true, json: async () => ({site: 'raumlens', source_domain: 'source.example', submit_url: h.page.url})};
    }
    return original(url, options);
  };
  const fallback = h.send({type: 'session', url: h.page.url}, h.page);
  await started;
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  release(); await fallback;
  assert.equal(h.sessionStore['tab:1'].site, 'probekits');
  assert.equal(h.sessionStore['tab:1'].submitted, true);
  assert.ok(!h.messages.some(item => item.message.type === 'page:session' && item.message.context.site === 'raumlens'));
});

test('用户选择项目本身就阻断更早的默认请求，不必等内容脚本完成激活', async () => {
  const h = harness();
  await h.sandbox.chrome.storage.local.set({preferredSite: 'raumlens'});
  const original = h.sandbox.fetch;
  let release, began;
  const delayed = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {began = resolve;});
  h.sandbox.fetch = async (url, options) => {
    if (url.includes('api/source')) {
      began(); await delayed;
      return {ok: true, json: async () => ({site: 'raumlens', source_domain: 'source.example', submit_url: h.page.url})};
    }
    return original(url, options);
  };
  const background = h.send({type: 'session', url: h.page.url}, h.page);
  await started;
  await h.send({type: 'panel:activate', site: 'probekits'}, {});
  release(); await background;
  assert.equal(h.sessionStore['tab:1'].site, 'probekits');
});

test('显式任务尚在读取时，iframe也不能抢先采用默认项目', async () => {
  const h = harness();
  await h.sandbox.chrome.storage.local.set({preferredSite: 'raumlens'});
  const original = h.sandbox.fetch;
  let release, began, sourceCalls = 0;
  const delayed = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {began = resolve;});
  h.sandbox.fetch = async (url, options) => {
    if (url.includes('api/item')) {began(); await delayed;}
    if (url.includes('api/source')) sourceCalls++;
    return original(url, options);
  };
  const explicit = h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  await started;
  const early = await h.send({type: 'session', url: h.page.url}, {...h.page, frameId: 1});
  release(); await explicit;
  assert.equal(early.value, null);
  assert.equal(sourceCalls, 0);
  assert.equal(h.sessionStore['tab:1'].site, 'probekits');
});

test('同一显式任务的并发初始化共享绑定，不互相取消', async () => {
  const h = harness();
  const original = h.sandbox.fetch;
  let release, began, calls = 0;
  const delayed = new Promise(resolve => {release = resolve;});
  const started = new Promise(resolve => {began = resolve;});
  h.sandbox.fetch = async (url, options) => {
    if (url.includes('api/item') && ++calls === 1) {began(); await delayed;}
    return original(url, options);
  };
  const message = {type: 'session', id: 'a'.repeat(32), url: h.page.url};
  const first = h.send(message, h.page);
  await started;
  const second = await h.send(message, {...h.page, frameId: 1});
  release();
  assert.equal((await first).value.context.site, 'probekits');
  assert.equal(second.value.context.site, 'probekits');
});

test('落盘前才收到提交事实时，也不得用更早读取的false降级提交锁', async () => {
  const h = harness();
  const key = 'tab:1';
  h.sessionStore[key] = {site: 'probekits', submitted: false, context: {site: 'probekits',
    source_domain: 'source.example', submit_url: h.page.url, record: {id: 'a'.repeat(32)}}};
  const original = h.sandbox.chrome.storage.session.get;
  let reads = 0;
  h.sandbox.chrome.storage.session.get = async name => {
    if (name === key && ++reads === 3) h.sessionStore[key] = {...h.sessionStore[key], submitted: true};
    return original(name);
  };
  const result = await h.send({type: 'session', url: h.page.url}, h.page);
  assert.equal(h.sessionStore[key].submitted, true);
  assert.equal(result.value.submitted, true);
  assert.equal(h.messages.at(-1).message.type, 'page:adopt');
});

test('子frame只采纳顶层共享绑定，不用自己的地址抢建默认来源', async () => {
  const h = harness();
  await h.sandbox.chrome.storage.local.set({preferredSite: 'raumlens'});
  const child = {...h.page, frameId: 1};
  const first = await h.send({type: 'session', url: 'https://embedded.example/form'}, child);
  assert.equal(first.value, null);
  assert.ok(!h.requests.some(item => item.url.includes('api/source')));
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  const second = await h.send({type: 'session', site: 'probekits', url: 'https://embedded.example/form'}, child);
  assert.equal(second.value.context.source_domain, 'source.example');
});
