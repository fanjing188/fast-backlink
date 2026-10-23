// 端到端：真实 Chromium + 本机服务 + 标准 OpenAI 兼容假服务，验证 AI 兜底回填。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {EXPECTED, launchBrowser, openFixture, settle, startEnvironment, value} from './support.mjs';

let env, browser, context;

before(async () => {
  env = await startEnvironment({ai: {auto_apply: true}});
  browser = await launchBrowser(env, {log_level: 'debug'});
  context = browser.context;
}, {timeout: 120000});

after(async () => {
  await context?.close().catch(() => {});
  await env?.stop();
  await env?.cleanup();
});

test('AI 兜底：确定性同义词覆盖不到的字段按建议填入，敏感字段不进 prompt', async () => {
  const {page} = await openFixture(context, 'ai-fallback.html');
  // 逐字段回填是异步的，首个字段有值并不代表整轮建议已处理。
  await page.waitForFunction(() => {
    const ai = JSON.parse(document.documentElement.dataset.bkStatus || '{}').ai;
    return ai?.suggestions?.length && ai.suggestions.every(item => item.applied || item.reason);
  }, null, {timeout: 15000});
  assert.equal(await value(page, '#name'), EXPECTED.name);
  assert.equal(await value(page, '#site'), EXPECTED.url);
  assert.equal(await value(page, '#pitch'), EXPECTED.tagline60);
  assert.equal(await value(page, '#question'), EXPECTED.hear);
  assert.equal(await value(page, '#mystery'), '');
  assert.equal(await page.$eval('input[name=billing][value=Free]', node => node.checked), true);
  const picked = await page.$eval('#tests', node => [...node.selectedOptions].map(option => option.textContent.trim()));
  assert.ok(picked.includes('mouse test'), picked.join(','));
  assert.equal(await page.$eval('#password', node => node.value), '');
  assert.ok(env.aiRequests.length >= 1);
  const prompt = env.aiRequests[0].messages.map(message => message.content).join('\n');
  assert.ok(prompt.includes('Where should we point readers?'));
  assert.ok(prompt.includes('Which tests should we list?'));
  assert.ok(!prompt.includes('Password'));
  assert.ok(!prompt.includes('I agree to the terms'));
  await settle(page);
});
