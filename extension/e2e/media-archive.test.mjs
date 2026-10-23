import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {EXPECTED, launchBrowser, openFixture, startEnvironment} from './support.mjs';
let env, browser;
before(async () => {env=await startEnvironment();browser=await launchBrowser(env);}, {timeout:120000});
after(async () => {await browser?.context.close();await env?.stop();await env?.cleanup();});

test('文件存档：素材数组重排仍复原原文件；内容变化则留空待确认，不自动换新图', async () => {
  const {page} = await openFixture(browser.context, 'file-upload.html');
  await page.waitForFunction(() => [...document.querySelectorAll('input[type=file]')].every(node => node.files.length > 0));
  const panel = await browser.context.newPage();
  await panel.goto(`chrome-extension://${browser.extensionId}/panel.html`);
  const saved = await panel.evaluate(async url => {
    const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
    return chrome.runtime.sendMessage({type:'panel:archive',tabId:tab.id});
  }, page.url());
  assert.equal(saved.error, undefined, JSON.stringify(saved));
  const url=page.url()+'#bk='+saved.value.id;
  const kitPath=path.join(env.root,'kits/probekits/kit.json');
  const kit=JSON.parse(await readFile(kitPath,'utf8'));kit.assets.reverse();
  await writeFile(kitPath,JSON.stringify(kit));
  await page.close();
  const restored=await browser.context.newPage();await restored.goto(url);
  await restored.waitForFunction(expected=>document.querySelector('#logo')?.files[0]?.name===expected,EXPECTED.logo,{timeout:20000});
  assert.equal(await restored.locator('#logo').evaluate(node=>node.files[0].name),EXPECTED.logo);
  await restored.close();
  const logo=path.join(env.root,'kits/probekits/assets',EXPECTED.logo);
  await writeFile(logo,Buffer.concat([await readFile(logo),Buffer.from('changed-content')]));
  const changed=await browser.context.newPage();await changed.goto(url);
  await changed.waitForFunction(()=>JSON.parse(document.documentElement.dataset.bkStatus||'{}').decisions?.some(
    row=>row.widget==='file'&&row.reason==='asset_changed'),null,{timeout:20000});
  assert.equal(await changed.locator('#logo').evaluate(node=>node.files.length),0);
});
