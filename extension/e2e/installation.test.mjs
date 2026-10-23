// 冷安装链路：安装命令→安装后的本机服务→安装后的扩展→填表→持久存档→队列复原。
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {copyFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {API_PORT, REPO, startEnvironment, launchBrowser, openFixture} from './support.mjs';
const exec = promisify(execFile);
let env, browser, service, extension;

before(async () => {
  env = await startEnvironment();
  const prefix = path.join(env.root,'installed app');
  const bin = path.join(env.root,'installed bin');
  await exec('sh',[path.join(REPO,'scripts/install.sh'),'--prefix',prefix,'--bin-dir',bin],
    {env:{...process.env,HOME:path.join(env.root,'empty-home'),PYTHON:process.env.PYTHON||'python3'}});
  // 用户可选择自己的数据目录；这里只连启动器创建的合成资料，绝不连真实config。
  await copyFile(env.configPath,path.join(prefix,'config.json'));
  extension = path.join(prefix,'extension');
  await writeFile(path.join(extension,'installation-smoke.txt'),'installed-extension-only');
  const oldExited = once(env.service,'exit');env.service.kill('SIGTERM');await oldExited;
  service=spawn(path.join(bin,'backlink-kit'),['start','--port',String(API_PORT)],{env:process.env,stdio:['ignore','pipe','pipe']});
  const base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Installed service startup timed out')),20000);
    let buffer='';
    service.stdout.on('data',chunk=>{
      buffer+=chunk;
      const match=buffer.match(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/$/m);
      if(match){clearTimeout(timer);resolve(match[0]);}
    });
    service.once('exit',()=>{clearTimeout(timer);reject(Error('Installed service exited before readiness'));});
  });
  browser=await launchBrowser({...env,base},{},extension);
}, {timeout:120000});

after(async () => {
  await browser?.context.close().catch(()=>{});
  if(service && service.exitCode===null){const exited=once(service,'exit');service.kill('SIGTERM');await exited;}
  await env?.stop();await env?.cleanup();
});

test('全新用户安装后的真实扩展与服务可填写、存档并从队列复原',async()=>{
  const marker=await browser.worker.evaluate(async()=>{
    const response=await fetch(chrome.runtime.getURL('installation-smoke.txt'));
    return response.text();
  });
  assert.equal(marker,'installed-extension-only','浏览器必须加载安装后的扩展，而不是仓库副本');
  const {page}=await openFixture(browser.context,'archive-form.html');
  await page.locator('#name').fill('Fresh install manual value');
  const panel=await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  await panel.getByRole('button',{name:'存档待验证',exact:true}).click();
  await panel.getByText('已存档到待处理',{exact:true}).waitFor();
  await page.close();
  await panel.locator('[data-tab=tasks]').click();
  const opened=browser.context.waitForEvent('page');
  await panel.getByRole('button',{name:'打开并复原',exact:true}).click();
  const restored=await opened;
  await restored.waitForFunction(()=>document.querySelector('#name')?.value==='Fresh install manual value');
  assert.equal(await restored.locator('#captcha').inputValue(),'');
  assert.equal(await restored.evaluate(()=>window.submits),0);
});
