const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createLibrary,safeURL}=require('../library.js');
const html=fs.readFileSync(path.join(__dirname,'../library.html'),'utf8');
class Node {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attrs={};this.events={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;}
  append(...items){this.children.push(...items.flat().map(v=>v instanceof Node?v:String(v)));}
  replaceChildren(...items){this.children=[];this.ownText='';this.append(...items);}
  setAttribute(k,v){this.attrs[k]=String(v);if(k==='value')this.value=String(v);}
  getAttribute(k){return this.attrs[k]??null;}
  addEventListener(k,v){this.events[k]=v;}
  focus(){this.focused=true;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  get textContent(){return this.ownText||this.children.map(v=>typeof v==='string'?v:v.textContent).join('');}
  set textContent(v){this.ownText=String(v);this.children=[];}
}
const descendants=n=>n.children.flatMap(v=>v instanceof Node?[v,...descendants(v)]:[]);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const row=(domain='one.example',extra={})=>({domain,submit_url:'https://'+domain+'/submit',scenario:'directory',fee:'free',dr:25,dr_date:'2026-10-22',dr_fresh:true,submission_status:'unsubmitted',submit_count:0,submitted_products:[],reuse_state:'ready',...extra});
function fixture(custom,search='?site=alpha'){
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Node()]));
 for(const [id,value]of Object.entries({site:'',status:'all',fee:'all',scenario:'all',sort:'dr','page-size':'50','batch-size':'10'}))nodes.get(id).value=value;
 const messages=[],downloads=[],saved={};
 const send=async(type,data={})=>{messages.push({type,...data});if(custom){const result=await custom(type,data);if(result!==undefined)return result;}
   if(type==='sites')return ['alpha','beta'];if(type==='batch:command')return [];
   if(type==='library:list')return {items:[row()],total:1,site:data.site||'',page:data.page||1,page_size:data.page_size||50};
   return {};};
 const app=createLibrary({document:{querySelector:s=>nodes.get(s.slice(1)),createElement:t=>new Node(t)},send,search,
  download:async(text,name)=>downloads.push({text,name}),storage:{get:async()=>saved,set:async data=>Object.assign(saved,data)}});
 const event=async(id,type='click',data={})=>nodes.get(id).events[type](data);
 return {app,nodes,messages,downloads,saved,event};
}
function button(f,action,domain){const container=domain?descendants(f.nodes.get('results')).find(n=>n.tagName==='tr'&&n.getAttribute('data-domain')===domain):f.nodes.get('results');return descendants(container).find(n=>n.getAttribute('data-action')===action);}
function checkRow(f,index=0){const boxes=descendants(f.nodes.get('results')).filter(n=>n.getAttribute('type')==='checkbox');boxes[index+1].checked=true;boxes[index+1].events.change();}

test('分页接口默认50条，六列只显示规范字段；旧档案字段不进入编辑表单',async()=>{
 const f=fixture();await f.app.start();const request=f.messages.find(m=>m.type==='library:list');assert.equal(request.page_size,50);assert.equal(request.page,1);
 assert.equal(descendants(f.nodes.get('results')).filter(n=>n.tagName==='th').length,6);
 for(const id of ['record-admission','record-backlink','fit-options','record-dr','record-dr-date'])assert.equal(f.nodes.has(id),false);
 assert.match(f.nodes.get('summary').textContent,/1 个平台/);
});
test('未选择产品不自动选首项，已登记URL产品可选，未登记产品忽略',async()=>{
 const f=fixture(null,'?site=not-registered');await f.app.start();assert.equal(f.nodes.get('site').value,'');assert.equal(button(f,'fill').disabled,true);
 const g=fixture(null,'?site=beta');await g.app.start();assert.equal(g.nodes.get('site').value,'beta');
});
test('费用和类型按v2枚举；未知不显示成免费，处理中不显示成功',async()=>{
 const f=fixture((type,data)=>type==='library:list'?{items:[row('unknown.example',{fee:'unknown',scenario:'',submission_status:'processing',dr:'UNKNOWN',dr_fresh:false})],site:data.site,total:1}:undefined);
 await f.app.start();const text=f.nodes.get('results').textContent;for(const word of ['未知','未分类','处理中','未查到','待刷新'])assert.ok(text.includes(word));assert.doesNotMatch(text,/已提交/);
});
test('提交次数来自后端去重产品数，当前产品成功标记与历史tooltip保留',async()=>{
 const f=fixture((type,data)=>type==='library:list'?{items:[row('done.example',{submission_status:'submitted',submit_count:2,submitted_products:[{site:'alpha',date:'2026-10-22'},{site:'beta',date:'2026-10-21'}]})],site:data.site,total:1}:undefined);
 await f.app.start();const status=descendants(f.nodes.get('results')).find(n=>n.getAttribute('class')==='selected-status');assert.equal(status.textContent,'已提交·2次');assert.match(status.getAttribute('title'),/alpha 2026-10-22/);assert.equal(button(f,'fill').disabled,true);
});
test('跨页选择、全选筛选、取消以及更换筛选回第一页',async()=>{
 const f=fixture((type,data)=>type==='library:list'?{items:[row(data.page===2?'two.example':'one.example')],site:data.site,total:150}:undefined);
 await f.app.start();checkRow(f);await f.event('next');assert.equal(f.app.state.page,2);checkRow(f);assert.deepEqual(f.app.selection().domains,['one.example','two.example']);
 await f.event('select-all');assert.equal(f.app.selection().all_filtered,true);assert.equal(f.app.selection().filters.page,2);assert.equal(f.nodes.get('selected-count').textContent,'已选 150 条');
 f.nodes.get('fee').value='paid';await f.event('fee','change');assert.equal(f.app.state.page,1);assert.equal(f.app.state.all,false);assert.equal(f.app.state.selected.size,0);
});
test('筛选和每页数量持久化，过期读取不覆盖新数据',async()=>{
 const pending=deferred();let calls=0;
 const f=fixture((type,data)=>type==='library:list'?++calls===2?pending.promise:{items:[row(calls===1?'old.example':'new.example')],site:data.site,total:1}:undefined);
 await f.app.start();const older=f.app.load();await f.app.load();pending.resolve({items:[row('late.example')],site:'alpha',total:1});await older;
 assert.equal(f.app.state.items[0].domain,'new.example');assert.equal(f.saved.libraryFilters['page-size'],'50');
});
test('加载清除旧清单；错误不伪装空库，禁止导出过期数据且可以恢复',async()=>{
 let fail=false;const pending=deferred();let loading=false;
 const f=fixture((type,data)=>{if(type==='library:list'){if(fail)throw Error('连接断开');if(loading)return pending.promise;}});await f.app.start();loading=true;const task=f.app.load();assert.match(f.nodes.get('results').textContent,/正在读取/);assert.equal(f.nodes.get('export').disabled,true);pending.reject(Error('连接断开'));await task;
 assert.match(f.nodes.get('notice').textContent,/连接断开/);assert.equal(f.app.state.loaded,false);await f.event('export');assert.equal(f.downloads.length,0);
 loading=false;await f.app.load();assert.equal(f.app.state.loaded,true);
});
test('查看只打开，填写需要ready和当前产品无处理中历史，陈旧DOM不能继续操作',async()=>{
 const f=fixture();await f.app.start();await button(f,'view').events.click();assert.deepEqual(f.messages.at(-1),{type:'library:open',domain:'one.example',site:'alpha',fill:false});
 const old=button(f,'fill');await old.events.click();assert.equal(f.messages.at(-1).fill,true);
 f.nodes.get('site').value='';await f.event('site','change');const before=f.messages.length;await old.events.click();assert.equal(f.messages.length,before);
});
test('填写请求防双击，结果未知不自动重试，URL账号密码和脚本协议拒绝',async()=>{
 const pending=deferred();const f=fixture(type=>type==='library:open'?pending.promise:undefined);await f.app.start();const fill=button(f,'fill');const task=fill.events.click();await fill.events.click();assert.equal(f.messages.filter(m=>m.type==='library:open').length,1);pending.reject(Error('中断'));await task;assert.match(f.nodes.get('action-status').textContent,/结果可能未知/);await f.app.load();assert.equal(button(f,'fill').disabled,true);
 for(const url of ['javascript:alert(1)','https://'+'user:pass'+'@example.com/'])assert.equal(safeURL(url),false);
});
test('编辑只保存精简字段；重复保存受保护，读回失败保留输入',async()=>{
 const pending=deferred();const f=fixture(type=>type==='library:save'?pending.promise:undefined);await f.app.start();await f.event('add');
 for(const[id,value]of Object.entries({domain:'new.example',url:'https://new.example/submit',scenario:'directory',fee:'freemium',note:'保留备注'}))f.nodes.get('record-'+id).value=value;
 const data={preventDefault(){}};const task=f.event('record-form','submit',data);await f.event('record-form','submit',data);assert.equal(f.messages.filter(m=>m.type==='library:save').length,1);pending.resolve({});await task;
 assert.match(f.nodes.get('form-status').textContent,/尚未读回一致/);assert.equal(f.nodes.get('record-note').value,'保留备注');
 assert.deepEqual(Object.keys(f.messages.find(m=>m.type==='library:save').record).sort(),['domain','fee','note','scenario','submit_url']);
});
test('不安全平台名按文本显示，不通过HTML解析',async()=>{
 const f=fixture((type,data)=>type==='library:list'?{items:[row('<img src=x onerror=alert(1)>')],total:1,site:data.site}:undefined);await f.app.start();assert.ok(f.nodes.get('results').textContent.includes('<img'));assert.equal(descendants(f.nodes.get('results')).some(n=>n.tagName==='img'),false);
});
test('导出筛选全部走后端，所选只发送域名，不混入产品资料',async()=>{
 const f=fixture(type=>type==='library:export'?{csv:'\ufeffurl,domain,type,fee\n'}:undefined);await f.app.start();await f.event('export');assert.equal(f.messages.at(-1).data.all_filtered,true);assert.equal(f.downloads[0].name,'fast-backlink-library.csv');
 checkRow(f);await f.event('export-selected');assert.deepEqual(f.messages.at(-1).data.domains,['one.example']);assert.equal('kit' in f.messages.at(-1).data,false);
});
test('彻底删除需要两次确认，取消不写，ledger保留提示可见',async()=>{
 const f=fixture();await f.app.start();checkRow(f);await f.event('delete-selected');await f.event('delete-confirm');assert.equal(f.messages.some(m=>m.type==='library:bulk'),false);await f.event('delete-cancel');assert.equal(f.messages.some(m=>m.type==='library:bulk'),false);
 await f.event('delete-selected');await f.event('delete-confirm');await f.event('delete-confirm');const m=f.messages.find(m=>m.type==='library:bulk');assert.equal(m.data.confirmation,'DELETE 1');assert.equal(m.data.action,'delete');assert.match(html,/历史 ledger 保留/);
});
test('导入必须先预览，换文件清除确认；确认后自动补查DR错误明确可见',async()=>{
 const f=fixture(type=>type==='library:import-preview'?{added:2,updated:1,skipped:[{line:4,reason:'链接无效'}]}:type==='library:import'?{added:2,updated:1,dr_error:'Ahrefs quota'}:undefined);await f.app.start();await f.event('import-confirm');assert.equal(f.messages.some(m=>m.type==='library:import'),false);
 f.nodes.get('import-file').files=[{name:'synthetic.csv',text:async()=> 'url,type,fee,note\nhttps://one.example/,directory,free,'}];await f.event('import-preview');assert.match(f.nodes.get('import-status').textContent,/新增 2 条/);await f.event('import-confirm');assert.match(f.nodes.get('import-status').textContent,/DR 查询整批停止.*quota/);
 await f.event('import-file','change');assert.equal(f.nodes.get('import-confirm').disabled,true);
});
test('批量先选产品和资格预览，开始防双击并由后台重新筛选',async()=>{
 const f=fixture(type=>type==='batch:preview'?{eligible:[{domain:'one.example'}],skipped:[{domain:'paid.example',reason:'付费'}]}:undefined);await f.app.start();checkRow(f);await f.event('batch-start');assert.equal(f.nodes.get('batch-dialog').open,true);assert.equal(f.nodes.get('batch-confirm').disabled,true);
 await f.event('batch-preview');assert.match(f.nodes.get('batch-preview-status').textContent,/可发 1 条 \/ 跳过 1 条/);await f.event('batch-confirm');await f.event('batch-confirm');assert.equal(f.messages.filter(m=>m.type==='batch:command'&&m.data.action==='start').length,1);
});
test('人工列表按卡点分组，快照失败明确保留标签，放弃使用同一任务ID',async()=>{
 const batch={id:'batch',site:'alpha',state:'finished',group:2,groups:2,counts:{success:0,manual:2,unknown:1,failed:0,queued:0,running:0},jobs:[{id:'captcha',domain:'a.example',state:'manual',reason:'验证码',archived_at:'2026-10-22'},{id:'login',domain:'b.example',state:'manual',reason:'登录'},{id:'unknown',domain:'c.example',state:'unknown',reason:'无反馈'}]};
 const f=fixture(type=>type==='batch:command'?[batch]:undefined);await f.app.start();const text=f.nodes.get('manual-list').textContent;for(const word of ['验证码','登录','结果未知','未存档，勿关标签','打开并复原'])assert.ok(text.includes(word));
 const abandon=descendants(f.nodes.get('manual-list')).find(n=>n.tagName==='button'&&n.textContent==='放弃');await abandon.events.click();assert.equal(f.messages.find(m=>m.type==='batch:resolve').data.id,'captcha');
});
test('HTML沿用品牌控件，无内联脚本/事件、虚构总数或innerHTML',()=>{
 for(const asset of ['vendor/fbl/brand.css','ui/app.css','ui/icons.js','icons/icon-48.png','library.js'])assert.ok(html.includes(asset));
 assert.doesNotMatch(html,/<script(?![^>]*src=)[^>]*>/);assert.doesNotMatch(html,/\son(?:click|submit|change)=/);assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../library.js'),'utf8'),/innerHTML/);
});

test('迟到的A产品资格预览不能覆盖界面已选择的B产品或重新启用提交',async()=>{
 const pending=deferred();const f=fixture(type=>type==='batch:preview'?pending.promise:undefined);await f.app.start();checkRow(f);await f.event('batch-start');const task=f.event('batch-preview');f.nodes.get('batch-site').value='beta';await f.event('batch-site','change');pending.resolve({eligible:[{}],skipped:[]});await task;assert.equal(f.nodes.get('batch-confirm').disabled,true);await f.event('batch-confirm');assert.equal(f.messages.some(m=>m.type==='batch:command'&&m.data.action==='start'),false);
});
test('选择新文件使正在进行的旧预览失效，不能导入旧文件',async()=>{
 const pending=deferred();const f=fixture(type=>type==='library:import-preview'?pending.promise:undefined);await f.app.start();f.nodes.get('import-file').files=[{name:'A.csv',text:async()=> 'url\nhttps://a.example'}];const task=f.event('import-preview');await new Promise(setImmediate);f.nodes.get('import-file').files=[{name:'B.csv',text:async()=> 'url\nhttps://b.example'}];await f.event('import-file','change');pending.resolve({added:1,updated:0,skipped:[]});await task;assert.equal(f.nodes.get('import-confirm').disabled,true);await f.event('import-confirm');assert.equal(f.messages.some(m=>m.type==='library:import'),false);
});
test('跨页全选后取消第二页一行保留其余筛选结果，视觉和实际排除集合一致',async()=>{
 const f=fixture((type,data)=>type==='library:list'?{items:[row(data.page===2?'two.example':'one.example')],site:data.site,total:150}:undefined);await f.app.start();checkRow(f);await f.event('select-all');await f.event('next');const box=descendants(f.nodes.get('results')).find(n=>n.getAttribute('aria-label')==='选择 two.example');box.checked=false;await box.events.change();assert.equal(f.app.selection().all_filtered,true);assert.deepEqual(f.app.selection().excluded_domains,['two.example']);assert.equal(f.nodes.get('selected-count').textContent,'已选 149 条');await f.event('prev');const first=descendants(f.nodes.get('results')).find(n=>n.getAttribute('aria-label')==='选择 one.example');assert.equal(first.checked,true);
});
test('弹窗内资格失败可见，状态未变化时不重绘任务；完成转换刷新清单',async()=>{
 let statusCalls=0;const f=fixture(type=>{if(type==='batch:preview')throw Error('请选择有效产品');if(type==='batch:command'){statusCalls++;return [];}});await f.app.start();checkRow(f);await f.event('batch-start');await f.event('batch-preview');assert.match(f.nodes.get('batch-preview-status').textContent,/请选择有效产品/);assert.equal(await f.app.refreshBatches(),false);
});


test('public 防重投边界保留：ready 与当前产品未知历史冲突时禁止填写，其他产品历史不串用', async () => {
  for (const status of ['unknown', 'outcome_unknown', 'submitted', '结果未知']) {
    const f = fixture((type, data) => type === 'library:list' ? {
      items: [row('locked.example', {history: [{site: 'alpha', status}]}),
        row('other.example', {history: [{site: 'beta', status}]})], total: 2, site: data.site,
    } : undefined);
    await f.app.start();
    assert.equal(button(f, 'fill', 'locked.example').disabled, true, status);
    assert.equal(button(f, 'fill', 'other.example').disabled, false, status);
    await button(f, 'fill', 'locked.example').events.click();
    assert.equal(f.messages.some(message => message.type === 'library:open'), false);
  }
});

test('public 域名长度校验保留：超长标签和总长拒绝，不修正标识也不发送保存', async () => {
  for (const domain of ['a'.repeat(64) + '.example', ('a'.repeat(60) + '.').repeat(5) + 'example']) {
    const f = fixture(); await f.app.start(); await f.event('add');
    f.nodes.get('record-domain').value = domain;
    f.nodes.get('record-url').value = 'https://safe.example/submit';
    await f.event('record-form', 'submit', {preventDefault() {}});
    assert.equal(f.messages.some(message => message.type === 'library:save'), false);
    assert.equal(f.nodes.get('record-domain').value, domain);
    assert.match(f.nodes.get('form-status').textContent, /域名/);
  }
});

test('public 保存期间锁定原编辑上下文，新增和收起不能清空正在保存的输入', async () => {
  const pending = deferred();
  const f = fixture(type => type === 'library:save' ? pending.promise : undefined);
  await f.app.start(); await f.event('add');
  f.nodes.get('record-domain').value = 'new.example';
  f.nodes.get('record-url').value = 'https://new.example/submit';
  f.nodes.get('record-note').value = '未保存输入';
  const task = f.event('record-form', 'submit', {preventDefault() {}});
  assert.equal(f.nodes.get('record-fields').disabled, true);
  await f.event('add'); await f.event('cancel-edit');
  assert.equal(f.nodes.get('editor').hidden, false);
  assert.equal(f.nodes.get('record-note').value, '未保存输入');
  pending.resolve({}); await task;
  assert.equal(f.nodes.get('record-fields').disabled, false);
});

test('清单加载立即撤销旧items，负数total和跨产品响应不能导出或继续填写', async () => {
  const pending = deferred(); let response;
  const f = fixture((type, data) => type === 'library:list' && response ? response : undefined);
  await f.app.start(); response = pending.promise;
  const task = f.app.load(); assert.equal(f.app.state.items.length, 0);
  pending.resolve({items: [], site: 'alpha', total: -1}); await task;
  assert.equal(f.app.state.loaded, false); assert.equal(f.nodes.get('export').disabled, true);
  response = {items: [row()], site: 'beta', total: 1}; await f.app.load();
  assert.match(f.nodes.get('notice').textContent, /目标产品不一致/);
});

test('产品服务失败可刷新恢复，持久化只写库筛选且失效产品不获填写资格', async () => {
  let failed = true;
  const f = fixture(type => {
    if (type === 'sites' && failed) throw Error('产品服务不可达');
  }, '');
  f.saved.libraryFilters = {site: 'removed-product', 'page-size': '20'};
  f.saved.preferredSite = 'beta';
  await f.app.start(); assert.match(f.nodes.get('notice').textContent, /产品服务不可达/);
  failed = false; await f.event('reload');
  assert.equal(f.nodes.get('notice').hidden, true);
  assert.equal(f.nodes.get('site').value, ''); assert.equal(button(f, 'fill').disabled, true);
  assert.equal(f.saved.preferredSite, 'beta'); assert.equal(f.saved.libraryFilters['page-size'], '20');
});

test('CSV BOM 和 TXT 原文发送预览并按同一文件确认，不在前端丢失导入内容', async () => {
  for (const [name, text, format] of [
    ['synthetic.csv', '\ufeffurl,type,fee,note\r\nhttps://one.example/,directory,free,合成备注', 'csv'],
    ['synthetic.txt', 'https://one.example/\nhttps://two.example/', 'txt'],
  ]) {
    if (format === 'csv') assert.equal(text.charCodeAt(0), 0xfeff);
    const f = fixture(type => type === 'library:import-preview' ? {added: 1, updated: 0, skipped: []} : undefined);
    await f.app.start(); f.nodes.get('import-file').files = [{name, text: async () => text}];
    await f.event('import-preview'); await f.event('import-confirm');
    assert.deepEqual(f.messages.find(message => message.type === 'library:import-preview').data, {format, text});
    assert.deepEqual(f.messages.find(message => message.type === 'library:import').data, {format, text});
  }
});


test('public 浏览器入口继续解包 value/error，后台失败可读且刷新后恢复', async () => {
  const vm = require('node:vm');
  const f = fixture();
  const sandbox = {
    document: {querySelector: selector => f.nodes.get(selector.slice(1)), createElement: tag => new Node(tag)},
    chrome: {
      runtime: {sendMessage: async () => ({error: '后台：请先配置本机服务'})},
      storage: {local: {get: async () => ({}), set: async () => {}}},
    },
    BKIcon: {hydrate() {}}, location: {search: '?site=alpha'}, URL, URLSearchParams, Blob,
    setTimeout, setInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../library.js'), 'utf8'), sandbox);
  await new Promise(setImmediate);
  assert.match(f.nodes.get('notice').textContent, /后台：请先配置本机服务/);
  sandbox.chrome.runtime.sendMessage = async message => ({value: message.type === 'sites' ? ['alpha'] :
    message.type === 'batch:command' ? [] : {items: [row()], site: message.site, total: 1}});
  await f.event('reload');
  assert.equal(f.nodes.get('notice').hidden, true);
  assert.equal(button(f, 'fill').disabled, false);
});
