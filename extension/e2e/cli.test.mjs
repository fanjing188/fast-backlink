// 端到端：Agent CLI → 本机命令通道 → 真实 Chromium 扩展 → 内容脚本。
import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {EXPECTED, PORT_A, REPO, launchBrowser, startEnvironment} from './support.mjs';

let env, browser, context;
const BK = path.join(REPO, 'bk.py');

before(async () => {
  env = await startEnvironment();
  browser = await launchBrowser(env);
  context = browser.context;
}, {timeout: 120000});

after(async () => {
  await context?.close().catch(() => {});
  await env?.stop();
  await env?.cleanup();
});

function python(args, timeout = 90000) {
  return new Promise((resolve, reject) => {
    execFile('python3', args, {cwd: REPO, timeout, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* 非 JSON 留给下面报错 */ }
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (!parsed) {
        reject(Error(`CLI 没有输出 JSON：${stdout}\n${stderr}`));
        return;
      }
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

describe('Agent CLI', () => {
  let pageUrl;

  test('status 能同时看到本机服务、扩展连接和当前标签页', async () => {
    const status = await extensionReady();
    assert.equal(status.ok, true);
    assert.equal(status.service.host, '127.0.0.1');
    assert.equal(status.extension.connected, true);
    assert.ok(status.extension.version);
    assert.ok(!JSON.stringify(status).includes(env.base.split('/')[3]), '不能回显令牌');
  });

  test('open 打开夹具页并返回填写计数', async () => {
    pageUrl = `http://127.0.0.1:${PORT_A}/test-pages/plain.html`;
    const opened = await fb('open', pageUrl, '--site', 'probekits', '--wait', '60');
    assert.equal(opened.ok, true);
    assert.ok(opened.tab.id, JSON.stringify(opened));
    assert.ok(opened.counts.filled >= 7, JSON.stringify(opened.counts));
    const pages = context.pages();
    const page = pages.find(item => item.url().split('#')[0] === pageUrl);
    assert.ok(page, 'CLI 打开的工作页应当出现在浏览器里');
    assert.equal(await page.$eval('#name', node => node.value), EXPECTED.name);
    assert.equal(await page.$eval('#email', node => node.value), EXPECTED.email);
  });

  test('ai 在未启用时明确返回 enabled=false', async () => {
    const url = `http://127.0.0.1:${PORT_A}/test-pages/ai-fallback.html`;
    await fb('open', url, '--site', 'probekits', '--wait', '60');
    const answer = await fb('ai', '--url', url, '--site', 'probekits', '--wait', '30');
    assert.equal(answer.ok, true);
    assert.equal(answer.result.enabled, false);
  });

  test('state / tabs 能读取当前页与打开的标签页', async () => {
    const state = await fb('state', '--url', pageUrl, '--wait', '30');
    assert.equal(state.ok, true);
    assert.ok(state.page.count.filled >= 7, JSON.stringify(state.page));
    const tabs = await fb('tabs', '--wait', '15');
    assert.ok(tabs.tabs.some(tab => tab.url.split('#')[0] === pageUrl));
  });

  test('snapshot --output 把页面快照写成文件并同步落盘', async () => {
    const output = path.join(env.root, 'cli-snapshot.json');
    const result = await fb('snapshot', '--url', pageUrl, '--output', output, '--wait', '45');
    assert.equal(result.ok, true);
    assert.equal(result.snapshot_path, output);
    assert.ok(result.fields > 0);
    const snapshot = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(snapshot.steps.length);
    const saved = await env.snapshots();
    assert.ok(saved.length > 0, '快照还应写进本机 snapshots/');
  });

  test('remember 把当前页非敏感值写回来源库', async () => {
    const result = await fb('remember', '--url', pageUrl, '--site', 'probekits', '--wait', '45');
    assert.equal(result.ok, true);
    assert.ok(result.remembered > 0, JSON.stringify(result));
  });

  test('logs 能读到扩展落盘的 JSONL', async () => {
    // 扩展日志每 5 秒批量落盘一次；轮询几次，验证最终可读。
    let result = await fb('logs', '--days', '1');
    for (let attempt = 0; attempt < 12 && result.count === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      result = await fb('logs', '--days', '1');
    }
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.entries));
    assert.ok(result.count > 0, '填写过程应当产生日志');
  });

  test('open --item / done 完成一个续填项并写回执', async () => {
    const plan = path.join(env.root, 'cli-handoff-plan.json');
    await writeFile(plan, JSON.stringify({items: []}));
    const saved = await python([BK, '--config', env.configPath, 'handoff', 'save',
      '--plan', plan, '--source-domain', '127.0.0.1', '--site', 'probekits',
      '--url', pageUrl, '--blocker', 'captcha']);
    assert.ok(saved.id, JSON.stringify(saved));
    const opened = await fb('open', '--item', saved.id, '--wait', '60');
    assert.equal(opened.ok, true);
    assert.ok(opened.counts.filled > 0, JSON.stringify(opened));
    const done = await fb('done', saved.id, '--wait', '60');
    assert.equal(done.ok, true);
    assert.equal(done.item.status, '待核实');
    const queue = await fb('queue');
    assert.ok(!queue.queue.some(item => item.id === saved.id), '已完成的续填项不应留在队列');
  });
});
