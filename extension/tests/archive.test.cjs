const {test} = require('node:test');
const assert = require('node:assert/strict');
const {harness} = require('./harness.cjs');

test('待验证存档读取所有已登记frame，并由本机持久保存；网页不能触发集中存档', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  await h.send({type: 'frame:report', summary: {url: h.page.url}}, h.page);
  await h.send({type: 'frame:report', summary: {url: 'https://child.example/form'}}, {...h.page, frameId: 2});
  const calls = [];
  h.sandbox.chrome.tabs.sendMessage = async (tabId, message, options) => {
    calls.push({tabId, type: message.type, frameId: options?.frameId});
    return {value: {snapshot: {url: options?.frameId === 2 ? 'https://child.example/form' : h.page.url,
      steps: [{fields: [{label: 'Product name', value: 'ProbeKits'}]}], step_index: 0}}};
  };
  const result = await h.send({type: 'panel:archive', tabId: 1}, {});
  assert.equal(result.error, undefined, JSON.stringify(result));
  const request = h.requests.find(x => x.url.endsWith('api/archive'));
  assert.ok(request, '必须写入本机存档接口');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.frames.length, 2);
  assert.equal(payload.site, 'probekits');
  assert.deepEqual(calls.map(x => x.frameId).sort(), [0, 2]);
  assert.ok(calls.every(x => x.type === 'page:archive'), '存档只采集，不执行填表或提交');
  const denied = await h.send({type: 'panel:archive'}, h.page);
  assert.match(denied.error, /仅允许扩展页面/);
});

test('任一iframe读取失败时不冒称完整存档、不写半份数据', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  await h.send({type: 'frame:report', summary: {}}, {...h.page, frameId: 2});
  h.sandbox.chrome.tabs.sendMessage = async () => {throw Error('frame detached');};
  const result = await h.send({type: 'panel:archive', tabId: 1}, {});
  assert.match(result.error, /frame|存档|读取/);
  assert.equal(h.requests.some(x => x.url.endsWith('api/archive')), false);
});

test('不能用当前产品A的页面结束队列里另一产品B的存档', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  const result = await h.send({type: 'done', tabId: 1, data: {id: 'b'.repeat(32)}}, {});
  assert.match(result.error, /打开|不匹配|当前/);
  assert.equal(h.requests.some(x => x.url.endsWith('api/done')), false);
});

test('提交事件持久标记未知，不靠标签页内存保护重放', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  await h.send({type: 'submitted'}, h.page);
  assert.ok(h.requests.some(x => x.url.endsWith('api/submission-attempt')));
});

test('同一URL的其他产品快照不能进入当前产品的最近快照或按key读取', async () => {
  const h = harness();
  await h.send({type: 'session', id: 'a'.repeat(32), url: h.page.url}, h.page);
  await h.send({type: 'snapshot:save', snapshot: {id: 'other', created_at: new Date().toISOString(),
    site: 'otherproduct', source_domain: 'source.example', url: h.page.url, form_fingerprint: 'fp', steps: []}}, h.page);
  const latest = await h.send({type: 'snapshot:latest', url: h.page.url}, h.page);
  assert.equal(latest.value, null);
});
