const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness, TOKEN} = require('./harness.cjs');

function libraryHarness(row = {}) {
  const h = harness();
  const item = {domain: 'source.example', submit_url: 'https://source.example/form', reuse_state: 'ready', ...row};
  const original = h.sandbox.fetch;
  const getTab = h.sandbox.chrome.tabs.get;
  h.sandbox.chrome.tabs.get = async id => ({...await getTab(id), status: 'complete'});
  h.created = [];
  h.sandbox.chrome.tabs.create = async options => {
    h.created.push(options);
    return {id: 2, ...options, windowId: 1};
  };
  h.sandbox.fetch = async (url, options = {}) => {
    const endpoint = new URL(url).pathname.split('/').at(-1);
    if (!['library', 'library_prepare'].includes(endpoint)) return original(url, options);
    h.requests.push({url, options});
    return {ok: true, headers: {get: () => 'application/json'}, json: async () => endpoint === 'library_prepare'
      ? {id: 'a'.repeat(32), site: 'probekits', submit_url: item.submit_url}
      : options.method === 'POST' ? {saved: true, domain: item.domain} : {items: [item], counts: {total: 1}}};
  };
  return h;
}

test('来源的持久提交锁使新会话仅采纳读回，不再次填写', async () => {
  const h = libraryHarness();
  const original = h.sandbox.fetch;
  h.sandbox.fetch = async (url, options) => {
    const response = await original(url, options);
    if (url.includes('/api/source')) {
      const value = await response.json();
      response.json = async () => ({...value, submission_locked: true});
    }
    return response;
  };
  const result = await h.send({type: 'session', site: 'probekits', url: h.page.url}, h.page);
  assert.equal(result.value.submitted, true);
  assert.ok(h.messages.some(({message}) => message.type === 'page:adopt' && message.submitted === true));
  assert.equal(h.messages.some(({message}) => message.type === 'page:session'), false);
});

test('外链库查询与保存走已有本机认证接口，不回传令牌', async () => {
  const h = libraryHarness();
  const result = await h.send({type: 'library:list', site: 'probekits', q: 'source', status: 'confirmed', scenario: 'directory'}, {});
  assert.equal(result.value.items[0].domain, 'source.example');
  const query = new URL(h.requests[0].url).searchParams;
  assert.equal(query.get('site'), 'probekits');
  assert.equal(query.get('q'), 'source');
  assert.equal(query.get('status'), 'confirmed');
  assert.equal(query.get('scenario'), 'directory');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  const record = {domain: 'source.example', admission: '待核实', note: '合成测试记录'};
  const saved = await h.send({type: 'library:save', record}, {});
  assert.equal(saved.value.saved, true);
  assert.deepEqual(JSON.parse(h.requests.at(-1).options.body), record);
});

test('网页内容脚本不能读取、修改或调度外链库', async () => {
  for (const type of ['library:list', 'library:save', 'library:open']) {
    const h = libraryHarness();
    const result = await h.send({type, domain: 'source.example', site: 'probekits', fill: true}, h.page);
    assert.match(result.error, /仅允许扩展页面/);
    assert.equal(h.requests.length, 0);
    assert.equal(h.created.length, 0);
  }
});

test('一键复用先建立持久待处理项，再绑定该项打开并填写', async () => {
  const h = libraryHarness();
  const result = await h.send({type: 'library:open', domain: 'source.example', site: 'probekits', fill: true}, {});
  assert.equal(result.error, undefined);
  const prepare = h.requests.find(request => request.url.endsWith('api/library_prepare'));
  assert.ok(prepare);
  assert.deepEqual(JSON.parse(prepare.options.body), {domain: 'source.example', site: 'probekits'});
  assert.equal(h.sessionStore['tab:1'].context.record.id, 'a'.repeat(32));
  assert.equal(h.sessionStore['tab:1'].site, 'probekits');
  assert.ok(h.messages.some(({message}) => message.type === 'page:session'));
  assert.ok(h.messages.some(({message}) => message.type === 'page:fill'));
});

test('查看平台只打开新页，不创建提交项、不绑定产品、不触发填写', async () => {
  const h = libraryHarness({reuse_state: 'needs_review'});
  const result = await h.send({type: 'library:open', domain: 'source.example', site: 'probekits', fill: false}, {});
  assert.equal(result.error, undefined);
  assert.equal(h.created[0].url, 'https://source.example/form');
  assert.equal(h.requests.some(request => request.url.endsWith('api/library_prepare')), false);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.sessionStore, {});
});

test('非ready、未知域名和不安全地址不能触发准备、填写或开页', async () => {
  for (const row of [{reuse_state: 'already_submitted'}, {reuse_state: 'unknown'}, {reuse_state: 'blocked'},
    {reuse_state: 'needs_review'}, {domain: 'other.example'}, {submit_url: 'javascript:alert(1)'},
    {submit_url: 'https://' + 'private:password' + '@source.example/form'}]) {
    const h = libraryHarness(row);
    const result = await h.send({type: 'library:open', domain: 'source.example', site: 'probekits', fill: true}, {});
    assert.ok(result.error, JSON.stringify(row));
    assert.equal(h.requests.some(request => request.url.endsWith('api/library_prepare')), false);
    assert.equal(h.messages.length, 0);
    assert.equal(h.created.length, 0);
  }
});
