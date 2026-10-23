"""共享的浏览器执行逻辑；回执未知时立即停止，字段读回失败不重放。"""
import json
from datetime import datetime
import subprocess
import time
import sys
from pathlib import Path
from urllib.parse import urlsplit
from .core import ROOT, fillplan, semantic_key, sensitive, snapshot_fields, unwrap, rules

# 只读取当前页公开表单；敏感控件永远不返回值。
FORM_JS = r'''() => Array.from(document.querySelectorAll('input,textarea,select')).filter(e=>e.type!=='hidden' && !e.disabled && !e.readOnly && !['submit','button','reset'].includes(e.type) && e.getClientRects().length).map(e=>{const label=e.labels?.length?Array.from(e.labels).map(l=>l.innerText).join(' '):(e.getAttribute('aria-label')||e.placeholder||e.name||''); const kind=[e.type,e.autocomplete,e.name,label].join(' ').toLowerCase(); const blocked=/password|one-time|otp|captcha|verification code|card|cc-|密码|验证码|银行卡/.test(kind); const selector=e.id?'#'+CSS.escape(e.id):(e.name?e.tagName.toLowerCase()+'[name='+JSON.stringify(e.name)+']':''); return {label,inputType:e.type,role:e.tagName==='SELECT'?'combobox':'textbox',required:e.required,maxlength:e.maxLength>=0?e.maxLength:null,selector:selector&&document.querySelectorAll(selector).length===1?selector:'',options:e.options?Array.from(e.options).map(o=>({text:o.text,value:o.value})):[],...(blocked?{}:{value:e.type==='file'?Array.from(e.files||[]).map(f=>f.name):e.tagName==='SELECT'?Array.from(e.selectedOptions).map(o=>o.text):e.value})};})'''


def collect_snapshot(api, root=None):
    options = {'root': root} if root else {}
    # 预算取上限 6000；仍分页就按游标翻页合并（同一快照）。
    snap=unwrap(api('semantic_snapshot', {'options':{'mode':'interactive','budget':6000,**options}}))
    if 'items' not in snap or not snap.get('binding') or not snap.get('snapshotId'):
        raise ValueError('snapshot_unavailable')
    # 每页快照编号不同（同一前缀 :s1/:s2…），元素记住自己所在页的编号，填写时用它。
    for item in snap['items']:
        item.setdefault('snapshotId',snap['snapshotId'])
    pages=0
    while snap.get('nextCursor'):
        pages+=1
        if pages>5:
            raise ValueError('snapshot_incomplete：页面过长，超过5页仍未读完')
        more=unwrap(api('semantic_snapshot', {'options':{'mode':'interactive','budget':6000,'cursor':snap['nextCursor'],**options}}))
        if more.get('binding')!=snap['binding'] or not more.get('snapshotId'):
            raise ValueError('snapshot_incomplete：翻页时页面已变化，请重试')
        for item in more.get('items',[]):
            item.setdefault('snapshotId',more['snapshotId'])
        snap['items']=snap['items']+more.get('items',[])
        snap['nextCursor']=more.get('nextCursor')
    coverage=snap.get('coverage',{})
    # truncated 是元素文字被截短，不是漏字段；跳过的 iframe（如 reCAPTCHA）不含我们要填的字段，只记备注。
    notes=[]
    if coverage.get('skippedFrames') or coverage.get('contentShieldSkippedFrames'):
        notes.append('页面有未读取的 iframe（如验证码），其中的字段需人工处理')
    snap['coverage_note']='；'.join(notes)
    form_js = FORM_JS
    if root:
        form_js = form_js.replace("document.querySelectorAll('input,textarea,select')", "document.querySelector("+json.dumps(root)+").querySelectorAll('input,textarea,select')")
    extra=api('js.evaluate', {'expression':'('+form_js+')()','world':'isolated'})
    extra=unwrap(extra)
    if isinstance(extra,dict):
        extra=extra.get('value',extra.get('result'))
    if not isinstance(extra,list):
        raise ValueError('form_readback_unavailable')
    fields=snapshot_fields(snap)
    for f in fields:
        matches=[x for x in extra if x['label']==f['label']]
        if len(matches)==1:
            f.update(matches[0])
        else:
            f['ambiguous']=True
    snap['fields']=fields
    content=unwrap(api('semantic_snapshot', {'options':{'mode':'content',**options}}))
    snap['text']=' '.join(x.get('name','') for x in content.get('items',[]))
    return snap


def checked_reply(reply):
    if not isinstance(reply,dict):
        raise ValueError('outcome_unknown')
    if reply.get('outcomeUnknown') or reply.get('outcome_unknown'):
        raise ValueError('outcome_unknown')
    if reply.get('error') or reply.get('code') or reply.get('ok') is False or reply.get('status') in ('user_input_required','approval_denied','task_paused'):
        # 保留原错误码，便于区分可重试的只读失败（如 page_not_ready）。
        raise ValueError('browser_stopped:'+str(reply.get('error') or reply.get('code') or reply.get('status') or 'failed'))
    return reply


def execute_plan(plan, api, capture):
    results=[]
    for item in plan['items']:
        if item['action']=='stop':
            results.append({'key':item['key'],'label':item['label'],'status':'stop','reason':item['reason']})
            continue
        # 每一项重新取快照并按语义重定位，绝不继续使用失效 ref。
        snap=capture()
        matches=[f for f in snapshot_fields(snap) if f['label']==item['label'] and not sensitive(f)]
        if len(matches)!=1 or matches[0].get('ambiguous'):
            results.append({'key':item['key'],'label':item['label'],'status':'failed','reason':'字段定位不唯一'})
            break
        field=matches[0]
        params={'binding':snap['binding'],'snapshotId':field.get('snapshotId') or snap['snapshotId'],'ref':field['ref']}
        action=item['action']
        if action=='ref_fill':
            params['text']=item['value']
        elif action=='select':
            action='ref_select_option';params.update(values=[item['value']],by='label')
        elif action=='files.upload':
            if not field.get('selector'):
                results.append({'key':item['key'],'label':item['label'],'status':'failed','reason':'上传 selector 缺失'})
                break
            params={'selector':field['selector'],'paths':[item['value']]}
        else:
            raise ValueError('invalid_action')
        try:
            checked_reply(api(action,params))
            observed=capture()
            values=[f for f in snapshot_fields(observed) if f['label']==item['label'] and not sensitive(f)]
            actual=values[0].get('value') if len(values)==1 else None
            expected=Path(item['value']).name if action=='files.upload' else item['value']
            ok=actual==expected or isinstance(actual,list) and actual==[expected]
            results.append({'key':item['key'],'label':item['label'],'status':'filled' if ok else 'failed','actual':actual,'reason':'' if ok else '实际值与计划不符；停止，不重放'})
            if not ok:
                break
        except Exception as exc:
            # 运行时 BrowserError 也必须落成未知回执，不能丢失交接记录。
            code=getattr(exc,'code',None) or type(exc).__name__
            results.append({'key':item['key'],'label':item['label'],'status':'unknown','reason':str(code)})
            break
    unresolved=any(r['status']!='filled' for r in results) or len(results)!=len(plan['items'])
    return {'status':'outcome_unknown' if any(r['status']=='unknown' for r in results) else 'user_input_required' if unresolved else 'filled','results':results,'filled':sum(r['status']=='filled' for r in results)}



def select_edge(edges, instance=None):
    edges=[b for b in edges if b.get('connected') and b.get('browser','').lower()=='edge' and not b.get('incognito')]
    if instance:
        found=next((b for b in edges if b.get('instanceId')==instance),None)
        if not found:
            raise ValueError('指定的 Edge 实例未连接：'+str(instance))
        return found
    if not edges:
        raise ValueError('没有已连接的 Edge 普通窗口')
    def activity(edge):
        value=edge.get('lastActiveAt') or edge.get('lastActive') or edge.get('lastActivityAt') or edge.get('lastSeenAt') or 0
        try:return float(value)
        except (ValueError,TypeError):
            try:return datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()
            except ValueError:return 0
    return max(edges,key=lambda b:(bool(b.get('primary') or b.get('isPrimary')),activity(b),str(b['instanceId'])))

class BrowserAuthorizationRequired(ValueError):
    pass


class BrowserCLI:
    def __init__(self, script, session, edge_instance=None):
        self.script,self.session=script,str(session)
        self.task=None;self.tab=None
        self.edge_instance=edge_instance
        self.selected_instance=None

    def call(self, operation, params):
        try:
            run=subprocess.run([sys.executable,self.script,'--session',self.session,operation,'-'],input=json.dumps(params),text=True,capture_output=True,timeout=70)
        except subprocess.TimeoutExpired:
            raise ValueError('outcome_unknown') from None
        try:
            reply=json.loads(run.stdout)
        except ValueError:
            raise ValueError('outcome_unknown') from None
        # browsers 等只读命令直接返回列表。
        if not (isinstance(reply,list) and operation in ('browsers','list')):
            checked_reply(reply)
        if run.returncode:
            raise ValueError('browser_stopped')
        return unwrap(reply)

    def open(self,url):
        if self.task:
            return self.finish_open(url)
        browsers=self.call('browsers',{})
        if isinstance(browsers,dict):
            browsers=browsers.get('browsers',browsers.get('instances',[]))
        edges=[b for b in browsers if b.get('browser','').lower()=='edge' and b.get('connected')]
        selected=select_edge(edges,self.edge_instance)
        self.selected_instance=selected['instanceId']
        print('使用 Edge 实例：'+str(self.selected_instance),file=sys.stderr)
        created=self.call('create',{'title':'外链人工续填','allowedOrigins':[urlsplit(url).scheme+'://'+urlsplit(url).netloc],'instanceId':self.selected_instance,'incognito':False})
        self.task=created.get('taskId') or created.get('task',{}).get('id') or created.get('id')
        if not self.task:
            raise ValueError('task_id_missing')
        return self.finish_open(url)

    def finish_open(self,url):
        # 新任务创建后会短暂处于授权中，最多等 15 秒再判定需要人工批准。
        for _ in range(16):
            state=self.call('get',{'taskId':self.task})
            task=state.get('task',state)
            if task.get('state') not in ('pending_approval','authorizing'):
                break
            time.sleep(1)
        if task.get('state') in ('pending_approval','authorizing'):
            raise BrowserAuthorizationRequired('请在 Edge 扩展批准已有任务，再点开始；未派发填写')
        if task.get('state')!='ready':
            raise ValueError('browser_not_ready')
        opened=self.run('new_tab',{'url':url})
        self.tab=opened.get('tabId') or opened.get('id')
        if self.tab is None:
            raise ValueError('tab_id_missing')

    def run(self,action,params):
        return self.call('run',{'taskId':self.task,**({'tabId':self.tab} if self.tab is not None else {}),'action':action,**params})

    def capture(self, root=None):
        # 页面刚打开或跳转中会报 page_not_ready；读取是只读动作，等一会儿重试。
        for attempt in range(15):
            try:
                return collect_snapshot(self.run, root)
            except ValueError as exc:
                if 'page_not_ready' not in str(exc) or attempt==14:
                    raise
                time.sleep(2)

    def focus(self,url):
        from .handoff import focus_edge
        return focus_edge(url)

    def close(self,keep=False):
        if self.task:
            return self.call('close',{'taskId':self.task,**({'keepTabs':True,'handoffReason':'user_requested'} if keep else {})})


def site_screen(args, namespace):
    def api(action,params):
        if action=='semantic_snapshot':
            return namespace['semantic_snapshot'](**params.get('options',{}))
        return {'value':namespace['evaluate'](params['expression'])}
    return collect_snapshot(api)


def site_fill(args, namespace):
    from .handoff import save_progress
    scenario=args.get('scenario')
    if rules('policy')['scenarios'].get(scenario) not in ('preapproved','outreach'):
        raise ValueError('此场景只允许草稿或禁止执行，不能调用填表工具')
    def api(action,params):
        if action=='semantic_snapshot':
            return namespace['semantic_snapshot'](**params.get('options',{}))
        if action=='js.evaluate':
            return {'value':namespace['evaluate'](params['expression'])}
        if action=='files.upload':
            return namespace['upload_files'](params['selector'],paths=params['paths'])
        snapshot={'binding':params['binding'],'snapshotId':params['snapshotId']}
        if action=='ref_fill':
            return namespace['ref_fill'](snapshot,params['ref'],params['text'])
        return namespace['ref_select_option'](snapshot,params['ref'],params['values'],by='label')
    capture=lambda:collect_snapshot(api)
    snapshot=capture()
    plan=json.loads(args['plan_json'])
    result=execute_plan(plan,api,capture)
    if result['status']!='filled':
        blockers=[x['key'] for x in plan['items'] if x['action']=='stop']
        progress=save_progress(Path(args['handoff_dir']),args['source_domain'],args['site'],args['submit_url'],plan,args.get('steps',[]),args.get('step',0),args.get('blocker',','.join(blockers) or '字段读回失败'),args.get('blocker_location','当前表单'))
        if result['status']=='outcome_unknown':
            progress['status']='结果未知'
            from .core import atomic_json
            atomic_json(Path(args['handoff_dir'])/(progress['id']+'.json'),progress)
        result['handoff_id']=progress['id']
    return result
