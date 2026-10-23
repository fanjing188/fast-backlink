const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classify}=require('../lib/batch-page.js');
const {create}=require('../lib/batch.js');

test('四种结果：跳感谢页、验证码、表单报错、无反馈超时；提交前成功文字无效',()=>{
  assert.equal(classify({url:'https://fixture.example/thank-you',attempted:true}).result,'success');
  assert.equal(classify({success:'Thank you, submission received',attempted:true}).result,'success');
  assert.equal(classify({captcha:true,attempted:true}).result,'manual');
  assert.equal(classify({error:'Invalid listing URL',attempted:true}).result,'failed');
  assert.equal(classify({attempted:true,timedOut:true}).result,'unknown');
  assert.equal(classify({success:'submitted',attempted:false}),null);
  assert.equal(classify({missing:['授权同意']} ).result,'manual');
  assert.equal(classify({hasForm:false}).result,'failed');
  for(const key of ['login','payment','email'])assert.equal(classify({[key]:true}).result,'manual');
});

test('否定、说明文案及提交前已存在的成功文字都不能证明本次成功', () => {
  for (const success of ['Your listing has not been submitted', 'How to get submitted to our directory', 'Submission not received']) {
    assert.equal(classify({attempted: true, success}), null, success);
  }
  const success = 'Thank you, submission received';
  assert.equal(classify({attempted: true, success, url: 'https://fixture.example/submit', baseline: {success, url: 'https://fixture.example/submit'}}), null);
  assert.equal(classify({attempted: true, success, url: 'https://fixture.example/submit', baseline: {success: '', url: 'https://fixture.example/submit'}}).result, 'success');
});

function fixture(){
  const calls=[],data={},removed=[],opened=[];
  const batches=[{id:'b',state:'running',jobs:Array.from({length:20},(_,i)=>({id:String(i),group:Math.floor(i/10)+1,state:'queued',url:'https://fixture.example/'+i,started:0}))}];
  const tabs=new Map();let tabId=0,time=1000,failArchive=false;
  const request=async(endpoint,query,body)=>{
    calls.push({endpoint,body}); const jobs=batches[0].jobs;
    if(endpoint==='batch_status')return structuredClone(batches);
    if(endpoint==='batch_claim'){
      if(jobs.some(j=>j.state==='running'))return [];
      const next=jobs.find(j=>j.state==='queued');if(!next||batches[0].state!=='running')return [];
      return jobs.filter(j=>j.group===next.group&&j.state==='queued').map(j=>{j.state='running';return {...j,batch_id:'b',lease:'one',owner:body.owner};});
    }
    if(endpoint==='batch_result'){
      const j=jobs.find(j=>j.id===body.id);Object.assign(j,{state:body.result,reason:body.reason});return {archive_saved:!!body.frames?.length};
    }
    throw Error(endpoint);
  };
  const executor=create({request,storage:{get:async key=>({[key]:structuredClone(data[key])}),set:async v=>Object.assign(data,structuredClone(v))},
    ownerId:async()=> 'owner',now:()=>time,
    tabs:{create:async({url,active})=>{assert.equal(active,false);const tab={id:++tabId,url};tabs.set(tab.id,tab);return tab;},get:async id=>{if(!tabs.has(id))throw Error('closed');return tabs.get(id);},remove:async id=>{removed.push(id);tabs.delete(id);}},
    inspect:async (id,options)=>{const j=Object.values(data.batchJobs).find(j=>j.tabId===id);if(j.id==='1')return {result:'manual',reason:'验证码'};if(j.id==='2')return {result:'failed',reason:'表单报错'};if(j.id==='3')return {result:'unknown',reason:'无反馈'};return options.attempted?{result:'success'}:{canSubmit:true,frameId:0};},
    submit:async id=>{const j=Object.values(data.batchJobs).find(j=>j.tabId===id);batches[0].jobs.find(x=>x.id===j.id).attempted_at='now';},
    archive:async()=>{if(failArchive)throw Error('iframe unreadable');return [{steps:[{fields:[{label:'Product name',value:'Synthetic'}]}]}];},
    open:async(id,job)=>opened.push(job.id)});
  return {executor,batches,data,calls,removed,opened,setTime:n=>time=n,failArchive:()=>failArchive=true};
}
test('两批20条：待人工不占名额，逐条回执落盘后推进，未知不重试',async()=>{
  const f=fixture();await f.executor.tick();assert.equal(f.opened.length,10);
  await f.executor.tick();assert.equal(f.opened.length,10);
  await f.executor.tick();assert.equal(f.opened.length,20);
  await f.executor.tick();await f.executor.tick();
  assert.equal(f.batches[0].jobs.filter(j=>j.state==='success').length,17);
  assert.equal(f.batches[0].jobs[1].state,'manual');assert.equal(f.batches[0].jobs[3].state,'unknown');
  assert.equal(f.calls.filter(c=>c.endpoint==='batch_result'&&c.body.id==='3').length,1);
  assert.equal(f.removed.length,19);assert.deepEqual(Object.keys(f.data.batchJobs),[]);
});
test('存档失败保留标签；暂停不点击，重建执行器不会再次领取活动任务',async()=>{
  const f=fixture();f.failArchive();await f.executor.tick();f.batches[0].state='paused';await f.executor.tick();
  assert.equal(f.removed.includes(2),false);assert.equal(f.batches[0].jobs[0].attempted_at,undefined);
  await f.executor.tick();assert.equal(f.opened.length,10);
  f.setTime(180000);await f.executor.tick();assert.equal(f.batches[0].jobs[0].state,'unknown');
});
