const {test} = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/log.js');

test('密码、验证码等敏感值不写进日志', () => {
  assert.equal(L.safeValue('hunter2', 'password'), '<敏感值不记录>');
  assert.equal(L.safeValue('1234', 'captcha'), '<敏感值不记录>');
  assert.equal(L.safeValue('4111111111111111', 'payment'), '<敏感值不记录>');
  assert.equal(L.safeValue('ProbeKits', 'name'), 'ProbeKits');
});

test('长值只留前 200 字符，null 进日志', () => {
  const long = 'x'.repeat(500);
  const saved = L.safeValue(long, 'description');
  assert.equal(saved.length, 201);
  assert.ok(saved.endsWith('…'));
  assert.equal(L.safeValue(null, 'name'), null);
  assert.equal(L.safeValue(undefined, 'name'), null);
});

test('按级别过滤、满 50 条自动 flush、失败不抛给调用方', async () => {
  const batches = [];
  const log = L.create({level: 'info', sink: async entries => batches.push(...entries), run: 'r_test'});
  log.debug('scan', 'ignored');
  log.info('scan', 'kept');
  await log.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].msg, 'kept');
  assert.equal(batches[0].run, 'r_test');
  assert.match(batches[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  for (let index = 0; index < 50; index++) log.info('fill', 'many');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(batches.length, 51);
  const failing = L.create({sink: async () => {throw Error('service down');}});
  failing.info('scan', 'kept');
  assert.equal(await failing.flush(), 0);
});

test('字段日志带字段描述，值走脱敏', async () => {
  const entries = [];
  const log = L.create({sink: async list => entries.push(...list)});
  log.field('info', 'fill', 'filled', {label: 'Password', widget: 'text', maxlength: 20}, {key: 'password', value: 'SECRET', conf: 0.9});
  await log.flush();
  assert.equal(entries[0].field.label, 'Password');
  assert.equal(entries[0].field.widget, 'text');
  assert.equal(entries[0].value, '<敏感值不记录>');
  assert.equal(entries[0].conf, 0.9);
});

test('汇总计数与运行标识可追踪', async () => {
  const entries = [];
  const log = L.create({sink: async list => entries.push(...list)});
  log.tally('filled', 3);
  log.tally('unmatched');
  assert.deepEqual(log.stats(), {filled: 3, unmatched: 1});
  log.push('info', 'perf', 'run_summary', {fields_total: 10, filled_auto: 9});
  await log.flush();
  assert.equal(entries.at(-1).cat, 'perf');
  assert.equal(entries.at(-1).fields_total, 10);
});
