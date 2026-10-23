// 合成登录站点与Google页面，真实加载扩展；不连接真实Google、不创建外部账号。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {REPO, startEnvironment, launchBrowser, activate} from './support.mjs';
let env, browser, panel;
const origin = 'https://login-fixture.example';
const pageHTML = body => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>合成登录验收</title></head><body>${body}</body></html>`;
const form = `<h1>Submit your product</h1><form id="listing" onsubmit="event.preventDefault();document.body.dataset.posted='yes'"><label>Product name<input id="name" name="name"></label><label>Website URL<input id="url" name="url" type="url"></label><button>Submit listing</button></form>`;
const message = async data => panel.evaluate(data => chrome.runtime.sendMessage(data).then(r => {if(r?.error) throw Error(r.error); return r.value;}), data);
const tabId = page => browser.worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, page.url());
before(async () => {
  env = await startEnvironment({ai: {auth_choice: 1}}); browser = await launchBrowser(env);
  panel = await browser.context.newPage(); await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await browser.context.route(origin + '/**', route => route.fulfill({contentType: 'text/html', body: pageHTML(
    new URL(route.request().url()).pathname === '/auth/login' ? `<h1>Sign in</h1><form><label>Name<input id="name" name="name"></label><label>Password<input id="password" type="password"></label><button>Sign in</button></form><script>document.querySelector('form').onsubmit=e=>e.preventDefault()</script>` : form)}));
}, {timeout: 120000});
after(async () => {await browser?.context.close(); await env?.stop(); await env?.cleanup();});

test('登录页不填产品资料；人工提交登录表单不标记投稿未知', async () => {
  const page = await browser.context.newPage();
  try {
    await page.goto(origin + '/auth/login');
    await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus);
    await activate(page);
    assert.equal(await page.inputValue('#name'), '');
    assert.equal(await page.inputValue('#password'), '');
    await page.fill('#name', 'human-login'); await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    const info = await message({type: 'panel:state', tabId: await tabId(page)});
    assert.equal(info.submitted, false);
  } finally {await page.close();}
});

test('明确授权后同页Google登录，重新识别并填写，最终投稿按钮不自动点击', async () => {
  const target = origin + '/inline';
  await browser.context.route(target, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Sign in to submit</h1><button id="google">Continue with Google</button><script>
    document.querySelector('#google').onclick=()=>{document.body.innerHTML=${JSON.stringify(form)}};</script>`)}));
  const page = await browser.context.newPage();
  try {
    await page.goto(target); await page.waitForFunction(() => !!document.documentElement.dataset.bkAuthReady);
    await activate(page); const id = await tabId(page);
    await assert.rejects(message({type: 'auth:start', tabId: id}), /授权/);
    await message({type: 'auth:grant', tabId: id, email: 'maker@example.test', target});
    await message({type: 'auth:start', tabId: id});
    await page.waitForFunction(() => document.querySelector('#url')?.value === 'https://probekits.com/');
    assert.equal(await page.inputValue('#name'), 'ProbeKits');
    assert.equal(await page.getAttribute('body', 'data-posted'), null);
    assert.equal((await message({type: 'auth:status', tabId: id})).task.state, 'complete');
  } finally {await page.close();}
});

test('投稿入口重定向登录页，精确选择Google账号，落到后台后返回原投稿页', async () => {
  const target = origin + '/redirect-submit', login = origin + '/auth/redirect';
  const google = 'https://accounts.google.com/v3/signin/accountchooser?' + new URLSearchParams({fixture:'redirect',code:'oauth-secret',
    client_id:'fixture.apps.googleusercontent.com',redirect_uri:origin+'/callback',scope:'openid email profile',state:'fixture-nonce'});
  let loggedIn = false, chosen = '';
  await browser.context.route(target, route => loggedIn ? route.fulfill({contentType: 'text/html', body: pageHTML(form)})
    : route.fulfill({contentType: 'text/html', body: pageHTML(`<script>location.replace(${JSON.stringify(login)})</script>`)}));
  await browser.context.route(login, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Sign in</h1><a href="${google}">Continue with Google</a>`)}));
  await browser.context.route(google, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Choose an account</h1><button data-email="other@example.test" onclick="location.href='${origin}/wrong-account'">Other account</button>
    <button data-email="maker@example.test" onclick="location.href='${origin}/dashboard'">Maker account</button>`)}));
  await browser.context.route(origin + '/dashboard', route => {loggedIn = true; chosen = 'maker'; return route.fulfill({contentType: 'text/html', body: pageHTML('<h1>Dashboard</h1><a href="/logout">Sign out</a>')});});
  const page = await browser.context.newPage();
  await page.goto(target); await page.waitForURL(login);
  await page.waitForFunction(() => !!document.documentElement.dataset.bkAuthReady);
  await activate(page); const id = await tabId(page);
  try {
    await message({type: 'auth:grant', tabId: id, email: 'maker@example.test', target});
    await message({type: 'auth:start', tabId: id});
    await page.waitForURL(target); await page.waitForFunction(() => document.querySelector('#url')?.value === 'https://probekits.com/');
    assert.equal(chosen, 'maker');
    assert.equal((await message({type: 'auth:status', tabId: id})).task.state, 'complete');
    assert.equal(JSON.stringify(await env.logLines()).includes('oauth-secret'), false);
    assert.equal(JSON.stringify(await env.snapshots()).includes('oauth-secret'), false);
  } finally {await page.close();}
});

test('独立Google弹窗绑定原任务，首次授权暂停，人工完成后接回原页', async () => {
  const target = origin + '/popup-submit';
  const google = 'https://accounts.google.com/o/oauth2/auth?fixture=popup&state=private-state';
  await browser.context.route(target, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Sign in to submit</h1><button id="google" onclick="window.open('${google}','fixture','width=500,height=650')">Continue with Google</button>
    <script>window.addEventListener('message',e=>{if(e.origin==='https://accounts.google.com' && e.data==='fixture-done')document.body.innerHTML=${JSON.stringify(form)}})</script>`)}));
  await browser.context.route(google, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Allow this platform to access your profile?</h1><button id="consent" onclick="window.opener.postMessage('fixture-done','${origin}');window.close()">Continue</button>`)}));
  const page = await browser.context.newPage();
  try {
    await page.goto(target); await page.waitForFunction(() => !!document.documentElement.dataset.bkAuthReady); await activate(page);
    const id = await tabId(page); await message({type: 'auth:grant', tabId: id, email: 'maker@example.test', target});
    const opened = browser.context.waitForEvent('page'); await message({type: 'auth:start', tabId: id}); const popup = await opened;
    await popup.waitForSelector('#consent');
    await panel.waitForFunction(async id => (await chrome.runtime.sendMessage({type:'auth:status',tabId:id})).value.task?.state === 'manual', id);
    assert.equal(await popup.locator('#consent').isVisible(), true);
    assert.equal(await page.locator('#name').count(), 0);
    assert.equal((await message({type: 'auth:status', tabId: await tabId(popup)})).task.rootId, id);
    await popup.click('#consent'); await page.waitForSelector('#name');
    assert.equal(await page.inputValue('#name'), '');
    await message({type: 'auth:resume', tabId: id});
    await page.waitForFunction(() => document.querySelector('#url')?.value === 'https://probekits.com/');
  } finally {await page.close();}
});

test('侧栏真实授权入口支持保存、开始、撤销；窄栏深浅色控件可达', async () => {
  const target = origin + '/ui-submit';
  await browser.context.route(target, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Sign in to submit</h1><button id="google">Continue with Google</button><script>document.querySelector('#google').onclick=()=>{document.body.innerHTML=${JSON.stringify(form)}};</script>`)}));
  const page = await browser.context.newPage();
  try {
    await page.goto(target); await page.waitForFunction(() => !!document.documentElement.dataset.bkAuthReady); await activate(page);
    await message({type: 'auth:grant', tabId: await tabId(page), enabled: false});
    await panel.reload(); await panel.waitForSelector('#auth-email');
    await panel.fill('#auth-email', 'maker@example.test');
    await panel.fill('#auth-target', target);
    const directory = path.join(REPO, 'docs/screenshots/auth'); await mkdir(directory, {recursive: true});
    for (const width of [320, 375, 480, 1440]) for (const colorScheme of ['light', 'dark']) {
      await panel.setViewportSize({width, height: 780}); await panel.emulateMedia({colorScheme, reducedMotion: 'reduce'});
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const buttons = await panel.locator('#auth-card button').evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect();return {width:r.width, height:r.height, left:r.left, right:r.right};}));
      assert.ok(buttons.length); assert.ok(buttons.every(r => r.width > 20 && r.height >= 32 && r.left >= 0 && r.right <= width));
      const name = `login-${width}-${colorScheme}.png`; await panel.screenshot({path: path.join(directory, name)});
      const png = await readFile(path.join(directory, name)); assert.equal(png.readUInt32BE(16), width);
    }
    await panel.setViewportSize({width:375,height:520});
    await panel.focus('#auth-email');await panel.keyboard.press('Tab');
    assert.equal(await panel.evaluate(()=>document.activeElement.id),'auth-save');
    await panel.click('#auth-save');
    await page.waitForFunction(() => document.querySelector('#url')?.value === 'https://probekits.com/');
    await panel.waitForSelector('#auth-revoke'); await panel.click('#auth-revoke');
    const id = await tabId(page); assert.equal((await message({type:'auth:status',tabId:id})).authorized, false);
  } finally {await page.close();}
});

test('已授权平台从Agent打开并填写时自动登录，不要求每次重新授权', async () => {
  const target = origin + '/remembered-submit';
  await browser.context.route(target, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Sign in to submit</h1><button id="google">Continue with Google</button><script>document.querySelector('#google').onclick=()=>{document.body.innerHTML=${JSON.stringify(form)}};</script>`)}));
  const page = await browser.context.newPage();
  try {
    await page.goto(target); await page.waitForFunction(() => !!document.documentElement.dataset.bkAuthReady); await activate(page);
    await message({type: 'auth:grant', tabId: await tabId(page), email: 'maker@example.test', target});
    await message({type: 'agent:execute', command: {action: 'open', args: {site: 'probekits', url: target}}});
    await page.waitForFunction(() => document.querySelector('#url')?.value === 'https://probekits.com/');
    assert.equal(await page.getAttribute('body', 'data-posted'), null);
  } finally {await page.close();}
});

test('歧义登录入口经当前AI接口选择，模型只能选当前候选且收不到账号', async () => {
  const target = origin + '/ai-submit', login = origin + '/auth/ai';
  await browser.context.route(target, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Sign in to submit</h1><a href="/wrong-account">Sign in as visitor</a><a href="${login}">Sign in as maker</a>`)}));
  await browser.context.route(login, route => route.fulfill({contentType: 'text/html', body: pageHTML(
    `<h1>Sign in</h1><button id="google" onclick="location.href='${origin}/ai-return'">Continue with Google</button>`)}));
  await browser.context.route(origin + '/ai-return', route => route.fulfill({contentType: 'text/html', body: pageHTML('<a href="/logout">Sign out</a><h1>Account</h1>')}));
  let ready = false;
  const page = await browser.context.newPage();
  try {
    await page.goto(target); await page.waitForFunction(() => !!document.documentElement.dataset.bkAuthReady); await activate(page);
    await browser.context.route(target, route => ready ? route.fulfill({contentType:'text/html',body:pageHTML(form)}) : route.fallback());
    await browser.context.route(origin + '/ai-return', route => {ready = true;return route.fulfill({contentType:'text/html',body:pageHTML('<a href="/logout">Sign out</a>')});});
    const id=await tabId(page);await message({type:'auth:grant',tabId:id,email:'maker@example.test',target});
    await message({type:'auth:start',tabId:id});
    await page.waitForFunction(() => document.querySelector('#url')?.value === 'https://probekits.com/');
    const requests = env.aiRequests.filter(r => r.messages[0].content.startsWith('Select a login'));
    assert.ok(requests.length);
    assert.equal(JSON.stringify(requests).includes('maker@example.test'), false);
    assert.equal(JSON.stringify(requests).includes('accounts.google.com'), false);
  } finally {await page.close();}
});

test('已有产品会话的页面进入登录后停止任务，迟到的表单不能继续自动填写', async () => {
  const page = await browser.context.newPage(), target = origin + '/cancel-submit';
  try {
    await page.goto(target); await page.waitForFunction(() => !!document.documentElement.dataset.bkStatus); await activate(page);
    await page.waitForFunction(() => document.querySelector('#url')?.value === 'https://probekits.com/');
    await page.evaluate(() => {document.body.innerHTML='<h1>Sign in</h1><button id="google" onclick="document.body.dataset.clicked=String(Number(document.body.dataset.clicked||0)+1)">Continue with Google</button>';});
    const id = await tabId(page); await message({type:'auth:grant',tabId:id,email:'maker@example.test',target});
    await message({type:'auth:start',tabId:id}); await message({type:'auth:cancel',tabId:id});
    await page.evaluate(html => {document.body.innerHTML=html;},form);
    await panel.evaluate(async id => chrome.tabs.sendMessage(id,{type:'page:fill',force:true}),id);
    assert.equal(await page.inputValue('#name'),'');
    assert.equal(await page.inputValue('#url'),'');
  } finally {await page.close();}
});

test('普通投稿Title和Description加可见captcha仍是内容页，只跳过验证码',async()=>{
  const target=origin+'/captcha-content';
  await browser.context.route(target,route=>route.fulfill({contentType:'text/html',body:pageHTML(
    '<h1>Submit listing</h1><form><label>Title<input name="title"></label><label>Description<textarea name="description"></textarea></label><label>Verification code<input name="captcha"></label></form>')}));
  const page=await browser.context.newPage();
  try{
    await page.goto(target);await page.waitForFunction(()=>!!document.documentElement.dataset.bkAuthReady);await activate(page);
    const probe=await panel.evaluate(async id=>(await chrome.tabs.sendMessage(id,{type:'auth:probe'},{frameId:0})).value,await tabId(page));
    assert.equal(probe.kind,'form');
    await page.waitForFunction(()=>document.querySelector('textarea').value.length>0);
    assert.equal(await page.inputValue('[name=captcha]'),'');
  }finally{await page.close();}
});

test('可验证OAuth弹窗只选择授权账号，完成后回读原表单',async()=>{
  const target=origin+'/verified-popup';
  const google='https://accounts.google.com/v3/signin/accountchooser?'+new URLSearchParams({client_id:'popup.apps.googleusercontent.com',
    redirect_uri:origin+'/callback',scope:'openid email profile',state:'popup-nonce'});
  await browser.context.route(target,route=>route.fulfill({contentType:'text/html',body:pageHTML(
    `<h1>Sign in to submit</h1><a target="_blank" rel="opener" href="${google}">Continue with Google</a><script>addEventListener('message',e=>{if(e.origin==='https://accounts.google.com'&&e.data==='verified-fixture')document.body.innerHTML=${JSON.stringify(form)}})</script>`)}));
  await browser.context.route(google,route=>route.fulfill({contentType:'text/html',body:pageHTML(
    `<h1>Choose an account</h1><button data-email="other@example.test">Other</button><button data-email="maker@example.test" onclick="opener.postMessage('verified-fixture','${origin}');window.close()">Maker</button>`)}));
  const page=await browser.context.newPage();
  try{
    await page.goto(target);await page.waitForFunction(()=>!!document.documentElement.dataset.bkAuthReady);await activate(page);
    const id=await tabId(page);await message({type:'auth:grant',tabId:id,email:'maker@example.test',target});
    await message({type:'auth:start',tabId:id});
    await page.waitForFunction(()=>document.querySelector('#url')?.value==='https://probekits.com/');
    assert.equal((await message({type:'auth:status',tabId:id})).task.state,'complete');
  }finally{await page.close();}
});
