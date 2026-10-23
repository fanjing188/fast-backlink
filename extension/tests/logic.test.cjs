const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const L = require('../logic.js');
global.BKLogic = L;
const D = require('../dom.js');
const rules = {labels:JSON.parse(fs.readFileSync(new URL('../../rules/labels.json',`file://${__dirname}/`))),sensitive:JSON.parse(fs.readFileSync(new URL('../../rules/keywords.json',`file://${__dirname}/`))).sensitive};
const context = () => ({fields:[{label:'Topics',key:'category',value:'Computing'}], memory:{fields:[{label:'Topics',key:'category',value:'Other'}],labels:{'Special':'name'}}, recipe:{steps:[{fields:[{label:'Unusual',key:'name'}]}]}, kit:{name:{value:'Kit'},category:{value:'Utilities / Hardware Testing'},description:{value:'Long description'},tagline:{value:'Short'}}, files:[]});
test('归一和共享同义词，与 Python 的 URL/email 优先规则一致',() => {
  assert.equal(L.normalize(' A  B '),'a b');
  for (const label of ['E-mail Address','email','your email']) assert.equal(L.semantic({label},rules),'email');
  assert.equal(L.semantic({label:'Site title'},rules),'name');
  assert.equal(L.semantic({label:'Contact name'},rules),undefined);
  assert.equal(L.semantic({label:'Domain name or URL'},rules),'url');
});
test('敏感字段优先，禁止精确记忆绕过',() => {
  for (const label of ['Password','验证码','OTP','Card number','SMS code']) {
    assert.ok(L.sensitive({label},rules));
    assert.equal(L.match({label}, {...context(),fields:[{label,value:'secret'}]},rules),undefined);
  }
  assert.ok(L.sensitive({label:'Secret',inputType:'password'},rules));
  assert.ok(L.sensitive({label:'X',autocomplete:'cc-number'},rules));
});
test('原标签 > 来源记忆/映射 > 配方映射 > 全局资料',() => {
  const c = context();
  assert.equal(L.match({label:'Topics',options:['Computing','Other']},c,rules),'Computing');
  c.fields=[];
  assert.equal(L.match({label:'Topics',options:['Computing','Other']},c,rules),'Other');
  assert.equal(L.match({label:'Special'},c,rules),'Kit');
  assert.equal(L.match({label:'Unusual'},c,rules),'Kit');
  assert.equal(L.match({label:'Product name'},c,rules),'Kit');
  c.memory.fields=[{label:'A',key:'name',value:'A'},{label:'B',key:'name',value:'B'}];
  assert.equal(L.match({label:'Product name'},c,rules),undefined);
});
test('选项原文，歧义不填，长文本不截断',() => {
  assert.equal(L.option('Computing',['Computing','Other']),'Computing');
  assert.equal(L.option('Utilities / Hardware Testing',['Hardware','Art']),'Hardware');
  assert.equal(L.option('Hardware',['Hardware tool','Hardware test']),undefined);
  assert.equal(L.match({label:'Description',maxlength:5},context(),rules),'Short');
  assert.equal(L.match({label:'Product name',maxlength:2},context(),rules),undefined);
});
test('标记只移除 bk，连接地址只允许本机固定端口',() => {
  const id='a'.repeat(32);
  assert.deepEqual(L.marker(`https://a.example/f#bk=${id}&step=2`),{id,url:'https://a.example/f#step=2'});
  assert.equal(L.marker('https://a.example/#bk=bad'),undefined);
  assert.equal(L.config('http://127.0.0.1:18780/'+'x'.repeat(40)+'/'),'http://127.0.0.1:18780/'+'x'.repeat(40)+'/');
  assert.equal(L.config('http://127.0.0.1:18790/'+'y'.repeat(40)+'/'),'http://127.0.0.1:18790/'+'y'.repeat(40)+'/');
  // 只认 127.0.0.1：别的本机名、外部域名、非 http、缺令牌都拒绝。
  for(const base of ['https://evil.example/','http://localhost:18780/','http://127.0.0.1.evil.example:18780/','https://127.0.0.1:18780/'+'z'.repeat(40)+'/','http://127.0.0.1:18780/short/']) assert.throws(() => L.config(base));
});
test('DOM 标签优先、敏感控件从不读取 value',() => {
  const element={labels:[{childNodes:[{nodeType:3,textContent:'Original'}]}],getAttribute:()=>null};
  assert.equal(D.label(element,{}),'Original');
  const secret={type:'password',name:'secret',getAttribute:()=>null,get value(){throw Error('敏感值被读取');}};
  const field=D.describe(secret,rules,{getElementById:()=>null});
  assert.equal(field.sensitive,true);
  assert.equal(D.read(secret,field),undefined);
  const aria={getAttribute:key => key==='aria-labelledby'?'a b':null};
  assert.equal(D.label(aria,{getElementById:id => ({textContent:id})}),'a b');
});
for (const [tag,content] of [['SELECT','请选择ComputingOther'],['TEXTAREA','已有描述'],['INPUT','']]) {
  test(`包裹 ${tag} 的标签排除控件内容，保留嵌套说明文字`,() => {
    const text = textContent => ({nodeType:3,textContent});
    const control = {tagName:tag,childNodes:[text(content)],textContent:content};
    const label = {tagName:'LABEL',childNodes:[text(' Topics '),control,{tagName:'SPAN',childNodes:[text('说明')]},{tagName:'BUTTON',childNodes:[text('帮助')]}]};
    const element = {...control,labels:[label],getAttribute:()=>null};
    assert.equal(D.label(element,{}),'Topics 说明');
    label.childNodes = [text('Topics '),control];
    assert.equal(D.label(element,{}),'Topics');
    assert.equal(L.match({...D.describe(element,rules,{}),options:['请选择','Computing','Other']},context(),rules),'Computing');
  });
}
test('原生 setter 和 input/change 事件，零 click',async () => {
  const events=[];
  class Input {set value(value){this.actual=value;} get value(){return this.actual;} }
  const input=new Input(); input.ownerDocument={defaultView:{Event:class {constructor(type,options){this.type=type;this.options=options;}}}};
  input.dispatchEvent=event => events.push(event.type); input.click=()=>{throw Error('不得点击');};
  Object.defineProperty(input,'value',{get(){return this.actual;},set(){throw Error('React 实例 setter 不应被调用');}});
  assert.equal(await D.fill(input,{inputType:'text'},'Hello'),true);
  assert.equal(input.value,'Hello'); assert.deepEqual(events,['input','change']);
  assert.equal(await D.fill(input,{sensitive:true},'secret'),false);
});
test('manifest 权限和后台网络边界',() => {
  const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',`file://${__dirname}/`)));
  assert.deepEqual(manifest.host_permissions,['http://127.0.0.1:*/*']);
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('debugger'));
  assert.equal(manifest.manifest_version,3);
  assert.equal(manifest.content_scripts[0].all_frames,true);
});
test('空占位选项不阻止填表，复选只按原文选择',() => {
  assert.equal(D.read({options:[],value:'',selectedOptions:[{textContent:'请选择'}]},{}),'');
  assert.equal(L.match({label:'我接受条款',inputType:'checkbox',options:['我接受条款']},context(),rules),undefined);
  const c=context(); c.memory.fields=[{label:'Hardware',value:'Hardware',key:'label'}];
  assert.equal(L.match({label:'Hardware',inputType:'checkbox'},c,rules),'Hardware');
});
test('SPA 路由片段保留，标记移除不重编码原路由',() => {
  const id='b'.repeat(32);
  assert.equal(L.marker(`https://source.example/#/submit/one&bk=${id}`).url,'https://source.example/#/submit/one');
});
