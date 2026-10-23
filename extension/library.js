/* 外链库 v2；业务资格与跨页选择由后端重新核对，页面只保存筛选和明确选择。 */
(function () {
  const TYPES = {directory:'目录',launch:'Launch',resource:'资源页',roundup:'Roundup',community:'社区',comment:'评论',producthunt:'Product Hunt',other:'其他'};
  const FEES = {free:'免费',freemium:'免费+付费加速',paid:'付费',unknown:'未知'};
  const FILTERS = ['site','search','scenario','fee','status','dr-min','dr-max','sort','page-size'];
  const safeURL = value => {try {const u = new URL(value); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password;} catch {return false;}};
  function createLibrary({document, send, search='', download, storage, schedule}) {
    const $ = id => document.querySelector('#'+id);
    const state = {sites:[], items:[], selected:new Set(), excluded:new Set(), all:false, page:1, total:0, loaded:false, sitesReady:false, batches:[]};
    let version=0, saving=false, importing=null, previewSelection=null, deleteSelection=null, deleteStep=0, deleteCount=0, importGeneration=0, batchGeneration=0, bulkBusy=false;
    const opening=new Set(), uncertain=new Set();
    const node = (tag, attrs={}, ...children) => {
      const n=document.createElement(tag);
      for (const [k,v] of Object.entries(attrs)) k.startsWith('on') ? n.addEventListener(k.slice(2),v) : n.setAttribute(k,v);
      n.append(...children.flat().filter(v => v!=null)); return n;
    };
    const options=(id, map, first) => $(id).replaceChildren(...(first ? [node('option',{value:first[0]},first[1])] : []), ...Object.entries(map).map(([k,v])=>node('option',{value:k},v)));
    const query=()=>({site:$('site').value,q:$('search').value.trim(),scenario:$('scenario').value,fee:$('fee').value,
      submission_status:$('status').value,dr_min:$('dr-min').value,dr_max:$('dr-max').value,sort:$('sort').value,page:state.page,page_size:Number($('page-size').value||50)});
    const selection=()=>state.all ? {all_filtered:true,filters:query(),excluded_domains:[...state.excluded]} : {domains:[...state.selected]};
    const count=()=>state.all ? state.total-state.excluded.size : state.selected.size;
    const report=error=>{$('action-status').textContent=error.message; if($('batch-dialog').open)$('batch-preview-status').textContent=error.message; if($('delete-dialog').open)$('delete-message').textContent=error.message;};
    function redraw(id,...children) {const key=document.activeElement?.getAttribute?.('data-focus-key');const holder=$(id);holder.replaceChildren(...children); if(key) [...(holder.querySelectorAll?.('[data-focus-key]')||[])].find(n=>n.getAttribute('data-focus-key')===key)?.focus({preventScroll:true});}
    async function action(fn) {try {return await fn();} catch(error) {report(error);}}
    function selections() {
      $('bulk-bar').hidden=!count(); $('selected-count').textContent=`已选 ${count()} 条`;
      $('select-all').hidden=state.all || !state.items.length || !state.items.every(r=>state.selected.has(r.domain));
      $('select-all').textContent=`选择全部筛选结果 ${state.total} 条`;
      $('clear-selection').hidden=!count();
    }
    function row(item) {
      const selected=node('input',{type:'checkbox','aria-label':`选择 ${item.domain}`,'data-focus-key':'select:'+item.domain,onchange:()=>{if(state.all){selected.checked?state.excluded.delete(item.domain):state.excluded.add(item.domain);}else{selected.checked?state.selected.add(item.domain):state.selected.delete(item.domain);}render();}});
      selected.checked=state.all ? !state.excluded.has(item.domain) : state.selected.has(item.domain);
      const status=item.submission_status==='processing' ? '处理中' : item.submit_count ? `已提交·${item.submit_count}次` : '未提交';
      const title=(item.submitted_products||[]).map(p=>`${p.site} ${p.date}`).join('\n');
      const open=node('button',{'data-action':'view','data-focus-key':'view:'+item.domain,onclick:()=>openPlatform(item,false,open)},'打开');
      const fill=node('button',{'data-action':'fill','data-focus-key':'fill:'+item.domain,onclick:()=>openPlatform(item,true,fill)},'打开并填写');
      open.disabled=!safeURL(item.submit_url); fill.disabled=!canFill(item);
      return node('tr',{'data-domain':item.domain},
        node('td',{}, selected,' ', safeURL(item.submit_url) ? node('a',{href:item.submit_url,target:'_blank',rel:'noopener noreferrer'},item.domain) : item.domain),
        node('td',{class:item.dr_fresh?'':'stale'}, item.dr==='UNKNOWN' || item.dr==null ? '未查到' : String(item.dr), node('small',{},item.dr_date==='UNKNOWN'?'':item.dr_date),!item.dr_fresh?node('small',{},'待刷新'):null),
        node('td',{},TYPES[item.scenario]||'未分类'),node('td',{},FEES[item.fee]||'未知'),
        node('td',{title,class:item.submission_status==='submitted'?'selected-status':''},status),
        node('td',{},node('div',{class:'actions'},open,fill,node('button',{'data-action':'edit','data-focus-key':'edit:'+item.domain,onclick:()=>edit(item)},'编辑'),node('button',{'data-action':'delete','data-focus-key':'delete:'+item.domain,onclick:()=>askDelete({domains:[item.domain]},1)},'删除'))));
    }
    function canFill(item) {
      const site=$('site').value;
      // 汇总状态若与已知历史冲突，保留 public 的防重投边界。
      const submitted=Array.isArray(item.history)&&item.history.some(record=>record?.site===site&&
        ['unknown','outcome_unknown','submitted','live','verified','accepted','published','结果未知'].includes(record.status));
      return state.loaded && state.loadedSite===site && state.sites.includes(site) && !!site && !submitted && item.reuse_state==='ready' &&
        (!item.submission_status || item.submission_status==='unsubmitted') && !uncertain.has(`${site}|${item.domain}`) && safeURL(item.submit_url);
    }
    async function openPlatform(item, fill, button) {
      if (!state.loaded || !state.items.includes(item) || opening.has(item.domain) || fill&&!canFill(item) || !safeURL(item.submit_url)) return;
      const site=$('site').value; opening.add(item.domain); button.disabled=true;
      try {await send('library:open',{domain:item.domain,site,fill}); $('action-status').textContent=fill?'已打开并填写；此单页模式不自动提交。':'已打开平台。';}
      catch(error) {if(fill) uncertain.add(`${site}|${item.domain}`); $('action-status').textContent=error.message+'。打开或填写结果可能未知，请先核对页面。';}
      finally {opening.delete(item.domain); button.disabled=fill?!canFill(item):false;}
    }
    function render() {
      const select=node('input',{type:'checkbox','aria-label':'选择本页','data-focus-key':'select-page',onchange:()=>{for(const r of state.items){if(state.all){select.checked?state.excluded.delete(r.domain):state.excluded.add(r.domain);}else{select.checked?state.selected.add(r.domain):state.selected.delete(r.domain);}}render();}});
      select.checked=!!state.items.length&&state.items.every(r=>state.all?!state.excluded.has(r.domain):state.selected.has(r.domain));
      const table=node('table',{},node('thead',{},node('tr',{},node('th',{},select,' 平台'),...['DR','外链类型','付费类型','提交状态','操作'].map(t=>node('th',{},t)))),node('tbody',{},...state.items.map(row)));
      redraw('results',state.items.length?node('div',{class:'table-wrap'},table):node('div',{class:'empty'},'没有符合筛选的平台；可放宽筛选或导入文件。'));
      $('summary').textContent=`当前筛选 ${state.total} 个平台`;
      $('page-label').textContent=`第 ${state.page} / ${Math.max(1,Math.ceil(state.total/Number($('page-size').value||50)))} 页`;
      $('prev').disabled=state.page<=1; $('next').disabled=state.page*Number($('page-size').value||50)>=state.total;
      selections();
    }
    async function load() {
      const current=++version; state.loaded=false; state.items=[]; $('export').disabled=true; $('results').replaceChildren(node('div',{class:'empty'},'正在读取平台清单…'));  $('results').setAttribute('aria-busy','true'); $('notice').hidden=true;
      try {
        const q=query(); const value=await send('library:list',q);
        if(current!==version)return;
        if(!Array.isArray(value?.items)||!Number.isInteger(value.total)||value.total<0||q.site!==value.site) throw Error('清单响应不完整或目标产品不一致，请刷新。');
        state.items=value.items; state.total=value.total; state.loaded=true; state.loadedSite=q.site;
        if(state.page>1&&!state.items.length&&state.total) {state.page=Math.ceil(state.total/Number(q.page_size)); return load();}
        $('export').disabled=false; render();
        await storage?.set?.({libraryFilters:Object.fromEntries(FILTERS.map(id=>[id,$(id).value]))});
      } catch(error) {if(current===version){state.items=[];state.loaded=false;$('notice').textContent=error.message;$('notice').hidden=false;$('results').replaceChildren(node('div',{class:'empty'},'读取失败，请检查本机服务后刷新。'));}}
      finally {if(current===version)$('results').setAttribute('aria-busy','false');}
    }
    async function filtered() {state.page=1;state.all=false;state.selected.clear();state.excluded.clear();selections();await load();}
    function edit(item) {
      if(saving)return;
      $('editor').hidden=false;$('editor-heading').textContent=item?'编辑平台':'新增平台';
      for(const [id,key] of [['domain','domain'],['url','submit_url'],['scenario','scenario'],['fee','fee'],['note','note']]) $('record-'+id).value=item?.[key]|| (id==='fee'?'unknown':'');
      $('record-domain').readOnly=!!item;$('form-status').textContent='';$('record-domain').focus();
    }
    async function save(event) {
      event.preventDefault(); if(saving)return;
      const record={domain:$('record-domain').value.trim(),submit_url:$('record-url').value.trim(),scenario:$('record-scenario').value,fee:$('record-fee').value,note:$('record-note').value};
      if(!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(record.domain)||!safeURL(record.submit_url)) {$('form-status').textContent='请填写有效小写域名和不含账号密码的 HTTP(S) 提交地址。';return;}
      saving=true;$('save').disabled=true;$('record-fields').disabled=true;
      try {await send('library:save',{record}); const check=await send('library:list',{domain:record.domain,site:$('site').value,page_size:50,page:1});
        if(!check.items?.some(r=>r.domain===record.domain&&r.submit_url===record.submit_url)) throw Error('尚未读回一致的平台记录');
        $('form-status').textContent='已保存并读回平台。'; await load();
      }catch(error){$('form-status').textContent=error.message+'；保留输入，请先核对。';}finally{saving=false;$('save').disabled=false;$('record-fields').disabled=false;}
    }
    async function exportCSV(data) {if(!state.loaded)return; const value=await send('library:export',{data:{...data,site:$('site').value}});await download(value.csv,'fast-backlink-library.csv');$('action-status').textContent='已导出 CSV，可直接回导；不含产品资料和配方。';}
    async function bulk(actionName,value) {if(bulkBusy||!state.loaded||!count())return; bulkBusy=true; try {const result=await send('library:bulk',{data:{...selection(),action:actionName,value,site:$('site').value}});$('action-status').textContent=`已处理 ${result.changed??result.found??0} 条`;await load();} finally {bulkBusy=false;}}
    function askDelete(data,n) {deleteSelection={...data};deleteCount=n;deleteStep=0;$('delete-message').textContent=`彻底删除 ${n} 个平台，不可恢复`;$('delete-confirm').textContent='继续确认';$('delete-dialog').showModal();}
    async function refreshBatches() {
      const batches=await send('batch:command',{data:{action:'status'}});if(!Array.isArray(batches))throw Error('批量任务响应不完整');const changed=JSON.stringify(state.batches)!==JSON.stringify(batches);state.batches=batches;
      if(!changed)return false;
      const unresolved=batches.flatMap(b=>b.jobs.filter(j=>['manual','unknown'].includes(j.state)).map(j=>({...j,batch_id:b.id,site:b.site})));
      $('manual-open').textContent=`待人工 ${unresolved.length}`;
      $('batch-panel').hidden=!batches.length;
      redraw('batch-list',...batches.map(b=>node('div',{class:'task'},node('p',{},`${b.site} · 第 ${b.group}/${b.groups} 批 · 成功 ${b.counts.success} / 待人工 ${b.counts.manual} / 未知 ${b.counts.unknown} / 失败 ${b.counts.failed} / 剩余 ${b.counts.queued+b.counts.running} · ${b.state}`),node('div',{class:'actions'},...['pause','resume','stop'].map((cmd,i)=>{const button=node('button',{'data-focus-key':b.id+':'+cmd,onclick:()=>action(async()=>{await send('batch:command',{data:{action:cmd,id:b.id}});await refreshBatches();await load();})},['暂停','继续','停止'][i]);button.disabled=cmd==='resume'?b.state!=='paused':!['running','paused'].includes(b.state);return button;})))));
      const groups=new Map(); for(const j of unresolved){const key=j.state==='unknown'?'结果未知':j.reason.split('；')[0]||'其他卡点';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(j);}
      redraw('manual-list',...[...groups].flatMap(([reason,jobs])=>[node('h3',{},reason),...jobs.map(j=>node('div',{class:'task'},node('p',{},`${j.domain} · ${j.site} · ${j.reason}`),node('p',{class:'muted'},j.archived_at?`存档：${j.archived_at}`:'未存档，勿关标签'),node('div',{class:'actions'},node('button',{'data-focus-key':j.id+':open',onclick:()=>action(()=>send('batch:open',{data:j}))},j.archived_at?'打开并复原':'打开查看'),...['success','abandoned'].map((result,i)=>node('button',{'data-focus-key':j.id+':'+result,onclick:()=>action(async()=>{await send('batch:resolve',{data:{id:j.id,batch_id:j.batch_id,result,reason:i?'人工放弃':'人工标记已提交'}});await refreshBatches();await load();})},i?'放弃':'标记已提交')))))]));
      if(!unresolved.length)$('manual-list').replaceChildren(node('p',{},'暂无待人工条目。'));return changed;
    }
    async function previewBatch() {
      const generation=++batchGeneration;
      $('batch-confirm').disabled=true;previewSelection=null;
      const data={...selection(),site:$('batch-site').value,batch_size:Number($('batch-size').value)};
      const value=await send('batch:preview',{data});
      if(generation!==batchGeneration || data.site!==$('batch-site').value || data.batch_size!==Number($('batch-size').value))return;
      $('batch-preview-status').textContent=`可发 ${value.eligible.length} 条 / 跳过 ${value.skipped.length} 条\n`+value.skipped.map(r=>`${r.domain}：${r.reason}`).join('\n');
      previewSelection=data;$('batch-confirm').disabled=!value.eligible.length;
    }
    for(const id of ['scenario','record-scenario','bulk-type']) options(id,TYPES,id==='scenario'?['all','全部类型']:id==='record-scenario'?['','未分类']:null);
    $('scenario').append(node('option',{value:'unclassified'},'未分类'));
    for(const id of ['fee','record-fee','bulk-fee'])options(id,FEES,id==='fee'?['all','全部付费类型']:null);
    for(const id of FILTERS)$(id).addEventListener(id==='search'?'input':'change',()=>action(filtered));
    $('reload').addEventListener('click',()=>action(async()=>{if(!state.sitesReady)return start();await load();await refreshBatches();}));
    $('prev').addEventListener('click',()=>action(async()=>{if(state.page>1){state.page--;await load();}}));
    $('next').addEventListener('click',()=>action(async()=>{if(state.page*Number($('page-size').value)<state.total){state.page++;await load();}}));
    $('select-all').addEventListener('click',()=>{state.all=true;state.excluded.clear();render();});$('clear-selection').addEventListener('click',()=>{state.all=false;state.selected.clear();state.excluded.clear();render();});
    $('add').addEventListener('click',()=>edit());$('cancel-edit').addEventListener('click',()=>{if(!saving)$('editor').hidden=true;});$('record-form').addEventListener('submit',save);
    $('export').addEventListener('click',()=>action(()=>exportCSV({all_filtered:true,filters:query()})));$('export-selected').addEventListener('click',()=>action(()=>exportCSV(selection())));
    for(const [id,cmd,field] of [['change-type','scenario','bulk-type'],['change-fee','fee','bulk-fee'],['refresh-dr','refresh_dr'],['mark','mark'],['unmark','unmark']])$(id).addEventListener('click',()=>action(()=>bulk(cmd,field?$(field).value:undefined)));
    $('delete-selected').addEventListener('click',()=>{if(state.loaded&&count())askDelete(selection(),count());});$('delete-cancel').addEventListener('click',()=>{$('delete-dialog').close();deleteSelection=null;});
    $('delete-confirm').addEventListener('click',()=>action(async()=>{if(!deleteSelection)return;if(!deleteStep){deleteStep=1;$('delete-confirm').textContent='确认彻底删除';return;}const chosen=deleteSelection; deleteSelection=null;const n=deleteCount;await send('library:bulk',{data:{...chosen,action:'delete',confirmation:`DELETE ${n}`}});$('delete-dialog').close();deleteSelection=null;state.selected.clear();state.excluded.clear();state.all=false;await load();}));
    $('import-open').addEventListener('click',()=>{$('importer').hidden=!$('importer').hidden;});$('template').addEventListener('click',()=>download('url,type,fee,note\nhttps://example.com/submit,directory,free,\n','fast-backlink-template.csv'));
    $('import-file').addEventListener('change',()=>{importGeneration++;importing=null;$('import-confirm').disabled=true;});
    $('import-preview').addEventListener('click',()=>action(async()=>{const generation=++importGeneration; importing=null; $('import-confirm').disabled=true; const file=$('import-file').files?.[0];if(!file)throw Error('先选择 CSV 或 TXT 文件');const data={format:file.name.toLowerCase().endsWith('.csv')?'csv':'txt',text:await file.text()};const value=await send('library:import-preview',{data});if(generation!==importGeneration || file!==$('import-file').files?.[0])return;importing=data;$('import-status').textContent=`新增 ${value.added} 条 / 补全 ${value.updated} 条 / 跳过 ${value.skipped.length} 条\n`+value.skipped.map(r=>`第 ${r.line} 行：${r.reason}`).join('\n');$('import-confirm').disabled=false;}));
    $('import-confirm').addEventListener('click',()=>action(async()=>{if(!importing)return;$('import-confirm').disabled=true;const data=importing;importing=null;const value=await send('library:import',{data});$('import-status').textContent=`已新增 ${value.added} 条，补全 ${value.updated} 条。`+(value.dr_error?`DR 查询整批停止：${value.dr_error}`:'DR 补查完成。');await load();}));
    $('batch-start').addEventListener('click',()=>{if(!state.loaded||!count())return;$('batch-site').value=$('site').value;batchGeneration++;previewSelection=null;$('batch-confirm').disabled=true;$('batch-preview-status').textContent='检查资格后才能开始；开始时后端会再次核对。';$('batch-dialog').showModal();});
    for(const id of ['batch-site','batch-size'])$(id).addEventListener('change',()=>{batchGeneration++;previewSelection=null;$('batch-confirm').disabled=true;});
    $('batch-preview').addEventListener('click',()=>action(previewBatch));$('batch-cancel').addEventListener('click',()=>{batchGeneration++;previewSelection=null;$('batch-dialog').close();});
    $('batch-confirm').addEventListener('click',()=>action(async()=>{if(!previewSelection)return;const data=previewSelection;previewSelection=null;$('batch-confirm').disabled=true;await send('batch:command',{data:{...data,action:'start'}});$('batch-dialog').close();await refreshBatches();await load();}));
    $('manual-open').addEventListener('click',()=>action(async()=>{$('manual-panel').hidden=!$('manual-panel').hidden;await refreshBatches();}));
    async function start() {
      try {const sites=await send('sites');if(!Array.isArray(sites)||sites.some(site=>typeof site!=='string'))throw Error('产品列表读取失败');state.sites=sites;state.sitesReady=true;
        for(const id of ['site','batch-site'])options(id,Object.fromEntries(sites.map(s=>[s,s])),['','请选择产品']);
        const saved=(await storage?.get?.('libraryFilters'))?.libraryFilters||{};for(const id of FILTERS)if(saved[id]!=null)$(id).value=saved[id];
        const initial=new URLSearchParams(search).get('site');if(sites.includes(initial))$('site').value=initial;
        if(!sites.includes($('site').value))$('site').value='';
        await load();await refreshBatches(); if(schedule)schedule(()=>action(async()=>{const changed=await refreshBatches();if(changed)await load();}),4000);
      }catch(error){$('notice').textContent=error.message;$('notice').hidden=false;$('results').setAttribute('aria-busy','false');}
    }
    return {state,start,load,refreshBatches,selection};
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={createLibrary,safeURL};
  else {
    const send=async(type,data={})=>{const r=await chrome.runtime.sendMessage({type,...data});if(r?.error)throw Error(r.error);return r?.value;};
    const download=async(text,name)=>{const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),0);};
    BKIcon.hydrate();createLibrary({document,send,search:location.search,download,storage:chrome.storage.local,schedule:setInterval}).start();
  }
})();
