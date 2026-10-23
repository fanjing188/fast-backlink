const {test} = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/ai.js');

const read = (element, field) => {
  void field;
  return element.value === undefined ? '' : element.value;
};

test('残余字段只包含可安全提交的空字段', () => {
  const entries = [
    {element: {value: ''}, field: {index: 0, label: 'Your Website', inputType: 'url'}},
    {element: {value: 'already filled'}, field: {index: 1, label: 'Tagline', inputType: 'text'}},
    {element: {value: ''}, field: {index: 2, label: 'Password', inputType: 'password'}},
    {element: {value: ''}, field: {index: 3, label: 'Logo', inputType: 'file'}},
    {element: {value: ''}, field: {index: 4, label: 'I agree to the terms', inputType: 'checkbox'}},
    {element: {value: ''}, field: {index: 5, label: '验证码', inputType: 'text', captcha: true}},
    {element: {value: ''}, field: {index: 6, label: 'Twitter handle', inputType: 'text'}},
    {element: {value: ''}, field: {index: 7, label: 'Bio', inputType: 'text', disabled: true}},
    {element: {value: ''}, field: {index: 8, label: 'Category', inputType: 'select-one', widget: 'select-one',
      options: ['Productivity', 'Utilities']}},
    {element: {value: ''}, field: {index: 9, label: 'How do you charge?', inputType: 'radio', widget: 'radio',
      options: ['Free', 'Paid']}},
    {element: {value: ''}, field: {index: 10, label: 'Which tests?', inputType: 'select-multiple',
      widget: 'select-multiple', options: ['mouse test', 'keyboard test']}},
  ];
  const result = A.residual(entries, new Map(), read);
  assert.deepEqual(result.map(item => item.index), [0, 6, 8, 9, 10]);
  assert.deepEqual(result[2].options, ['Productivity', 'Utilities']);
  assert.deepEqual(result[3].options, ['Free', 'Paid']);
  assert.equal(result[0].label, 'Your Website');
});

test('决策为敏感/验证码/蜜罐的字段一律跳过', () => {
  const entries = [
    {element: {value: ''}, field: {index: 0, label: 'Unknown', inputType: 'text'}},
    {element: {value: ''}, field: {index: 1, label: 'Other', inputType: 'text'}},
  ];
  const decisions = new Map([[0, {status: 'sensitive'}], [1, {status: 'unmatched'}]]);
  assert.deepEqual(A.residual(entries, decisions, read).map(item => item.index), [1]);
});

test('建议校验：越界索引、未知键、重复项都丢弃，置信度收敛', () => {
  const result = A.normalize({suggestions: [
    {i: 0, key: 'url', conf: 0.9, why: 'website'},
    {i: 0, key: 'name', conf: 0.4},
    {i: 1, key: 'no_such_key', conf: 1},
    {i: 2, key: null, conf: 2, why: 'x'.repeat(200)},
    {i: 99, key: 'url', conf: 1},
    {i: '3', key: 'email', conf: 0.7},
  ]}, new Set([0, 1, 2, 3]), new Set(['url', 'name', 'email']));
  assert.deepEqual(result.map(item => [item.i, item.key]), [[0, 'url'], [2, null], [3, 'email']]);
  assert.equal(result[1].conf, 1);
  assert.equal(result[1].why.length, 80);
});

test('非数组和空响应的防御', () => {
  assert.deepEqual(A.normalize(null, new Set([0]), new Set(['url'])), []);
  assert.deepEqual(A.normalize({suggestions: 'nope'}, new Set([0]), null), []);
  assert.deepEqual(A.residual([], new Map(), read), []);
});
