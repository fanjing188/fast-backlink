// 端到端：Agent CLI 的 fb ai → 本机命令通道 → 扩展 → 内容脚本 AI 兜底。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {EXPECTED, PORT_A, REPO, launchBrowser, startEnvironment} from './support.mjs';

let env, browser, context;
const BK = path.join(REPO, 'bk.py');

before(async () => {
  env = await startEnvironment({ai: {auto_apply: false}});
  browser = await launchBrowser(env);
  context = browser.context;
}, {timeout: 120000});

after(async () => {
  await context?.close().catch(() => {});
  await env?.stop();
  await env?.cleanup();
});

function python(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('python3', args, {cwd: REPO, timeout, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* 下面统一报错 */ }
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      if (!parsed) { reject(Error(`CLI 没有输出 JSON：${stdout}\n${stderr}`)); return; }
      resolve(parsed);
    });
  });
}

const fb = (...args) => python([BK, '--config', env.configPath, 'fb', ...args]);

async function extensionReady(timeout = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      last = await fb('status', '--wait', '3');
      if (last.extension?.connected) return last;
    } catch (error) {
      last = {error: String(error.stderr || error.message)};
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('扩展没有连上命令通道：' + JSON.stringify(last));
}

test('fb ai 先返回建议，再按 --apply 填入', async () => {
  await extensionReady();
  const url = `http://127.0.0.1:${PORT_A}/test-pages/ai-fallback.html`;
  await fb('open', url, '--site', 'probekits', '--wait', '60');

  const suggested = await fb('ai', '--url', url, '--site', 'probekits', '--wait', '90');
  assert.equal(suggested.ok, true);
  assert.ok(suggested.result.suggestions.some(item => item.key === 'url'), JSON.stringify(suggested.result));

  const applied = await fb('ai', '--url', url, '--site', 'probekits', '--apply', '--wait', '90');
  assert.equal(applied.ok, true);
  assert.ok(applied.result.applied.filled >= 4, JSON.stringify(applied.result));

  const page = context.pages().find(item => item.url().split('#')[0] === url);
  assert.ok(page, 'CLI 打开的页面应还在浏览器里');
  assert.equal(await page.$eval('#site', node => node.value), EXPECTED.url);
  assert.equal(await page.$eval('input[name=billing][value=Free]', node => node.checked), true);
  assert.ok((await page.$eval('#tests', node => [...node.selectedOptions].map(option => option.textContent.trim())))
    .includes('mouse test'));
});
