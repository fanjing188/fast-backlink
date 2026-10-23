const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness.cjs');

function delayedSource() {
  const h = harness();
  const fetch = h.sandbox.fetch;
  let release, reached;
  const held = new Promise(resolve => {release = resolve;});
  const ready = new Promise(resolve => {reached = resolve;});
  h.sessionStore['tab:1'] = {site: 'probekits'};
  h.sandbox.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (new URL(url).pathname.endsWith('/source')) {
      const context = await response.json();
      reached();
      await held;
      return {...response, json: async () => ({...context, record: null})};
    }
    return response;
  };
  return {...h, ready, release};
}

for (const submitted of [false, true]) {
  test(`迟到的无任务source会话不能覆盖item绑定或${submitted ? '清除投稿锁' : '丢失投稿记录'}`, {timeout: 3000}, async () => {
    const h = delayedSource();
    const pending = h.send({type: 'session', url: h.page.url}, h.page);
    await h.ready;
    const item = await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
    assert.equal(item.value.context.record.id, 'a'.repeat(32));
    if (submitted) assert.equal((await h.send({type: 'submitted'}, h.page)).value.ok, true);
    const before = h.messages.length;
    h.release();
    const stale = await pending;
    assert.equal(stale.value, null, '旧source响应必须丢弃，不下发无任务上下文');
    assert.equal(h.sessionStore['tab:1'].context.record.id, 'a'.repeat(32));
    assert.equal(!!h.sessionStore['tab:1'].submitted, submitted);
    assert.equal(h.messages.slice(before).some(({message}) => message.type === 'page:session'), false);
    if (!submitted) assert.equal((await h.send({type: 'submitted'}, h.page)).value.ok, true);
    const attempts = h.requests.filter(({url}) => url.endsWith('/api/submission-attempt'));
    assert.equal(attempts.length, 1);
    assert.equal(JSON.parse(attempts[0].options.body).id, 'a'.repeat(32));
  });
}

test('外链库pendingItem在普通网页启动时优先绑定item，不退回source', async () => {
  const h = harness();
  h.sessionStore['tab:1'] = {site: 'probekits', pendingItem: 'a'.repeat(32), entryURL: h.page.url};
  const result = await h.send({type: 'session', url: h.page.url}, h.page);
  assert.equal(result.value.context.record.id, 'a'.repeat(32));
  assert.equal(h.requests.some(({url}) => new URL(url).pathname.endsWith('/source')), false);
  assert.ok(h.requests.some(({url}) => new URL(url).searchParams.get('id') === 'a'.repeat(32)));
});

test('切换产品后不会把上一产品pendingItem当作当前任务', async () => {
  const h = harness();
  h.sessionStore['tab:1'] = {site: 'probekits', pendingItem: 'a'.repeat(32), entryURL: h.page.url};
  await h.send({type: 'session', site: 'freshproduct', url: h.page.url}, h.page);
  assert.equal(h.requests.some(({url}) => new URL(url).pathname.endsWith('/item')), false);
});

test('任务会话尚未读回时，投稿事件仍通过可信pendingItem持久记录', async () => {
  const h = harness();
  h.sessionStore['tab:1'] = {site: 'probekits', pendingItem: 'a'.repeat(32), entryURL: h.page.url};
  const result = await h.send({type: 'submitted'}, h.page);
  assert.equal(result.error, undefined);
  const attempt = h.requests.find(({url}) => url.endsWith('/api/submission-attempt'));
  assert.ok(attempt);
  assert.equal(JSON.parse(attempt.options.body).id, 'a'.repeat(32));
  assert.equal(h.sessionStore['tab:1'].submitted, true);
});

test('真实侧栏产品切换链路撤销旧pendingItem，不串回上一产品', async () => {
  const h = harness();
  h.sessionStore['tab:1'] = {site: 'probekits', pendingItem: 'a'.repeat(32), entryURL: h.page.url};
  const fetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (new URL(url).pathname.endsWith('/source')) {
      const context = await response.json();
      return {...response, json: async () => ({...context, site: 'freshproduct', record: null})};
    }
    return response;
  };
  await h.send({type: 'panel:activate', tabId: 1, site: 'freshproduct'}, {});
  const result = await h.send({type: 'session', site: 'freshproduct', url: h.page.url}, h.page);
  assert.equal(h.requests.some(({url}) => new URL(url).pathname.endsWith('/item')), false);
  assert.equal(result.value.context.site, 'freshproduct');
});

test('item等待期间发生投稿：迟到item不洗掉投稿锁、不再派发填写', {timeout: 3000}, async () => {
  const h = harness();
  h.sessionStore['tab:1'] = {site: 'probekits', pendingItem: 'a'.repeat(32), entryURL: h.page.url,
    context: {site: 'probekits', submit_url: h.page.url, record: null}};
  let release, reached;
  const held = new Promise(resolve => {release = resolve;});
  const ready = new Promise(resolve => {reached = resolve;});
  const fetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith('/item')) {reached(); await held;}
    return fetch(url, options);
  };
  const pending = h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  await ready;
  const submitted = await h.send({type: 'submitted'}, h.page);
  release();
  assert.equal((await pending).value, null);
  assert.equal(submitted.error, undefined);
  assert.equal(h.sessionStore['tab:1'].submitted, true);
  assert.equal(h.messages.some(({message}) => message.type === 'page:session'), false);
  assert.equal(h.requests.filter(({url}) => url.endsWith('/api/submission-attempt')).length, 1);
});

test('最后设置读取期间切换产品，旧会话不得下发或返回', {timeout: 3000}, async () => {
  const h = harness();
  let release, reached, once = false;
  const held = new Promise(resolve => {release = resolve;});
  const ready = new Promise(resolve => {reached = resolve;});
  const get = h.sandbox.chrome.storage.local.get;
  h.sandbox.chrome.storage.local.get = async key => {
    if (key === 'settings' && !once && h.sessionStore['tab:1']?.context) {
      once = true; reached(); await held;
    }
    return get(key);
  };
  const pending = h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  await ready;
  await h.send({type: 'panel:activate', tabId: 1, site: 'freshproduct'}, {});
  release();
  assert.equal((await pending).value, null);
  assert.equal(h.sessionStore['tab:1'].site, 'freshproduct');
  assert.equal(h.messages.some(({message}) => message.type === 'page:session'), false);
});
