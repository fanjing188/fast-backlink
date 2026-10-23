"""人工交接状态、续填和带令牌的本机列表服务。"""
from contextlib import contextmanager
from datetime import datetime, timedelta
import fcntl
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlsplit, urlunsplit, parse_qs
import uuid
from .core import atomic_json, day, today, rules, fillplan, snapshot_fields, sensitive, semantic_key, output_csv
from . import kits
from .browser import BrowserCLI, BrowserAuthorizationRequired, execute_plan


def stamp():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def safe_fields(items):
    fields=[]
    allowed=set(rules('labels'))|{'label'}
    for item in items:
        if item.get('key') not in allowed or sensitive(item) or item.get('action')=='stop' or item.get('value') is None:
            continue
        fields.append({k:item[k] for k in ('key','label','value')})
    return fields


def merge_fields(items, extra):
    # extra 是 [{'label','value'}]：执行人在卡点前实际填过/选过的值，按标签覆盖。
    fields=safe_fields(items)
    for e in extra or []:
        label=e['label'].strip()
        if not label or e.get('value') in (None,''):
            raise ValueError('--set 需要“标签=值”')
        entry={'key':semantic_key({'label':label}) or 'label','label':label,'value':e['value']}
        if sensitive(entry):
            raise ValueError('不能保存密码、验证码或支付类字段：'+label)
        fields=[f for f in fields if f['label']!=label]+[entry]
    return fields


def save_progress(root, source, site, url, plan, steps=None, step=0, blocker='人工验证', location='当前表单', extra=None):
    if urlsplit(url).scheme not in ('http','https') or not urlsplit(url).hostname:
        raise ValueError('invalid_submit_url')
    clean_steps=[]
    for entry in steps or []:
        nxt=entry.get('next',{})
        if nxt and (nxt.get('label') not in rules('navigation')['next_labels'] or nxt.get('role')!='button'):
            raise ValueError('仅允许已记录且明确的下一步按钮，不允许提交动作')
        clean_steps.append({'fields':safe_fields(entry.get('fields',[])),'next':nxt})
    if step<0 or step>len(clean_steps):
        raise ValueError('invalid_step')
    record=dict(id=uuid.uuid4().hex,source_domain=source,site=site,submit_url=url,step=step,steps=clean_steps,fields=merge_fields(plan['items'],extra),blocker=blocker,blocker_location=location,created_at=stamp(),status='待处理',message='')
    atomic_json(Path(root)/(record['id']+'.json'),record)
    return record


class Store:
    def __init__(self,root,conf=None):
        self.conf=conf
        self.root=Path(root)
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)

    def path(self,ident):
        if not re.fullmatch('[0-9a-f]{32}',ident):
            raise ValueError('invalid_id')
        return self.root/(ident+'.json')

    def load(self,ident):
        return json.loads(self.path(ident).read_text())

    def save(self,record):
        atomic_json(self.path(record['id']),record)

    @contextmanager
    def lock(self,ident):
        self.path(ident)
        with (self.root/(ident+'.lock')).open('a') as f:
            try:
                fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('同一项正在续填') from None
            try:
                yield
            finally:
                fcntl.flock(f,fcntl.LOCK_UN)

    def rows(self):
        result=[]
        for p in sorted(self.root.glob('*.json')):
            if not re.fullmatch('[0-9a-f]{32}',p.stem):
                continue
            r=self.load(p.stem)
            if not r.get('archive') and r['status'] in ('待处理','待人工','待授权') and (today()-day(r['created_at'])).days>=rules('policy')['handoff_days']:
                r['status']='需重新备料';r['message']='进度超过有效期'
            if r['status']=='续填中':
                # 进程崩溃或服务重启后绝不自动重放。
                r={**r,'status':'结果未知','message':'续填正在执行或曾中断，先人工读回，禁止重放'}
            result.append(r)
        return result

    def transition(self,ident,action,runs,reason='',extension_data=None,extension_api=None):
        with self.lock(ident):
            r=self.load(ident)
            if action=='done':
                if extension_data is not None and r['status']=='待核实':
                    return r
                if r['status'] not in ('待人工','结果未知','续填中'):
                    raise ValueError('尚未交接人工，不能标记完成')
                if extension_data is not None:
                    extension_api.remember(extension_api.context(r['site'],r['submit_url'],r),extension_data)
                elif self.conf:
                    collect_completed_values(r,self.conf)
                r.update(status='待核实',completed_at=stamp(),message='人工声明完成；次日读回后才能记 submitted')
                # 完成回执按 ID 幂等；不触碰 ledger。
                path=Path(runs)/str(today())/'handoff-done.csv'
                from .core import read_csv
                with (self.root/'.done.lock').open('a') as receipts:
                    fcntl.flock(receipts,fcntl.LOCK_EX)
                    rows=read_csv(path)[1] if path.exists() else []
                    if not any(x['id']==ident for x in rows):
                        rows.append({k:r[k] for k in ('id','source_domain','site','submit_url','completed_at','status')})
                        output_csv(path,rows)
            elif action=='skip':
                if not reason.strip():
                    raise ValueError('跳过必须填写原因')
                if r['status'] in ('待核实','已跳过'):
                    raise ValueError('终态不可重复操作')
                r.update(status='已跳过',skip_reason=reason,skipped_at=stamp(),message=reason)
            else:
                raise ValueError('invalid_action')
            self.save(r)
            if self.conf and (action=='done' or extension_data is not None):
                from .sources import source_event
                source_event(self.conf,r['source_domain'],'history',r,self.path(ident))
            return r


def resume(store,ident,conf,browser_factory=BrowserCLI):
    with store.lock(ident):
        r=store.load(ident)
        if r['status'] not in ('待处理','待授权'):
            raise ValueError('当前状态不允许续填；未知结果必须先人工核对')
        if (today()-day(r['created_at'])).days>=rules('policy')['handoff_days']:
            r.update(status='需重新备料',message='进度已过期');store.save(r);return r
        reuse=r['status']=='待授权'
        r.update(status='续填中',started_at=stamp());store.save(r)
        browser=browser_factory(conf['browser_script'],store.root/(ident+'.session'))
        if hasattr(browser,'edge_instance'): browser.edge_instance=conf.get('edge_instance')
        # 只有待授权时复用原任务；其他情况原任务已关闭，新建任务。
        if reuse and r.get('browser_task'):
            browser.task=r['browser_task']
        wrote=False;opened=False
        try:
            browser.open(r['submit_url'])
            opened=True
            kit,_=kits.load(conf,r['site'])
            results=[];notes=[]
            for index in range(r['step']+1):
                saved=r['steps'][index]['fields'] if index<r['step'] else r['fields']
                snap=browser.capture()
                plan=fillplan(snap,kit,saved_fields=saved)
                matching=sum(any(x['key']==f['key'] and x['label']==f['label'] and x['action']!='stop' for x in plan['items']) for f in saved)
                # 匹配不全也照填能对上的字段，把页面交给人补，不再整页放弃。
                low=bool(saved) and matching/len(saved)<rules('policy')['match_threshold']
                if low:
                    missed=[f['label'] for f in saved if not any(x['label']==f['label'] and x['action']!='stop' for x in plan['items'])]
                    notes.append(f'第 {index+1} 步表单和保存时不一致，只复原能对上的字段；没对上：'+'、'.join(missed))
                wrote=True
                result=execute_plan(plan,browser.run,browser.capture)
                # 联动下拉：选完上级后下级选项才出现，重读页面再补填，最多再两轮。
                for _ in range(2):
                    if result['status']=='outcome_unknown' or any(x['status']=='failed' for x in result['results']):
                        break
                    done={x['label'] for x in result['results'] if x['status']=='filled'}
                    again=fillplan(browser.capture(),kit,saved_fields=saved)
                    todo=[x for x in again['items'] if x['action']!='stop' and x['label'] not in done]
                    if not todo:
                        break
                    more=execute_plan({'items':todo},browser.run,browser.capture)
                    latest={x['label']:x for x in result['results']}
                    latest.update({x['label']:x for x in more['results']})
                    result={'status':more['status'] if more['status']=='outcome_unknown' else result['status'],'results':list(latest.values())}
                results+=result['results']
                r['results']=results;store.save(r)
                if result['status']=='outcome_unknown':
                    r.update(status='结果未知',message='动作结果未知，不重放');break
                failed=[x for x in result['results'] if x['status']=='failed']
                if failed:
                    notes.append('；'.join(x['label']+': '+x['reason'] for x in failed))
                if index<r['step'] and (failed or low):
                    # 中间步骤不完整就不自动点下一步，停在这一步交给人。
                    notes.append(f'停在第 {index+1} 步，没有自动进入下一步')
                if (failed or low) or index==r['step']:
                    count=sum(x['status']=='filled' for x in results)
                    stops=[x['label']+': '+x.get('reason','') for x in results if x['status'] not in ('filled','failed')]
                    r.update(status='待人工',message=f'已填好 {count} 项，卡点在：{r["blocker_location"]}；{r["blocker"]}；'+'；'.join(notes+stops))
                    break
                if index<r['step']:
                    nxt=r['steps'][index]['next']
                    if nxt.get('label') not in rules('navigation')['next_labels']:
                        raise ValueError('未记录安全的下一步动作')
                    current=browser.capture()
                    matches=[f for f in current['items'] if f.get('name')==nxt['label'] and f.get('role')=='button']
                    if len(matches)!=1:
                        raise ValueError('下一步定位失败')
                    from .browser import checked_reply
                    checked_reply(browser.run('ref_click',{'binding':current['binding'],'snapshotId':matches[0].get('snapshotId') or current['snapshotId'],'ref':matches[0]['ref']}))
            keep=opened
            browser.close(keep=keep)
            if keep:
                r['message']+=('；Edge 已切到该提交页' if getattr(browser,'focus',lambda url:False)(r['submit_url']) else '；请在 Edge 的工作窗口里找到该提交页')
        except BrowserAuthorizationRequired as exc:
            r.update(status='待授权',browser_task=browser.task,message=str(exc))
        except (ValueError,OSError,KeyError) as exc:
            if wrote:
                r.update(status='结果未知',message=str(exc)+'；先人工读回，不重放')
            else:
                # 还没填写任何字段，只是打开或读取失败，可以再点开始。
                r.update(status='待处理',message='打开或读取页面失败：'+str(exc)+'；可再点开始')
            # 页面已打开就交给人看，不关页；没打开才普通关闭。
            keep=opened
            try:
                browser.close(keep=keep)
                if keep:
                    r['message']+=('；Edge 已切到该页面' if getattr(browser,'focus',lambda url:False)(r['submit_url']) else '；页面保留在 Edge 工作窗口')
            except (ValueError,OSError):
                pass
        if getattr(browser,'selected_instance',None):
            r['edge_instance']=browser.selected_instance
        if getattr(browser,'task',None):
            r['browser_task']=browser.task
        if getattr(browser,'tab',None) is not None:
            r['browser_tab']=browser.tab
        store.save(r)
        return r


def focus_edge(url):
    # 把 Edge 切到该来源站最新打开的标签页；首次需要在系统弹窗允许控制 Edge。
    import subprocess
    origin=urlsplit(url).scheme+'://'+urlsplit(url).netloc
    script='''on run argv
set prefix to item 1 of argv
tell application "Microsoft Edge"
set hitW to missing value
set hitI to 0
repeat with w in windows
set i to 0
repeat with t in tabs of w
set i to i + 1
if (URL of t) starts with prefix then
set hitW to w
set hitI to i
end if
end repeat
end repeat
if hitW is missing value then return "notfound"
set active tab index of hitW to hitI
set index of hitW to 1
activate
end tell
return "ok"
end run'''
    try:
        run=subprocess.run(['osascript','-e',script,origin],capture_output=True,text=True,timeout=15)
    except (OSError,subprocess.TimeoutExpired):
        return False
    return run.stdout.strip()=='ok'


def completion_controls(r, base):
    esc=lambda x:html.escape(str(x),quote=True)
    return ''.join(f'<form method="post" action="{esc(base)}"><input type="hidden" name="id" value="{esc(r["id"])}"><input type="hidden" name="action" value="{action}"><button>{label}</button></form>'
        for action,label in [('done','我已完成'),('next','处理完了，下一个')])


def progress_summary(r):
    results=r.get('results',[])
    filled=sum(x.get('status')=='filled' for x in results)
    remaining=[x.get('label','') for x in results if x.get('status')!='filled']
    remaining+= [r.get('blocker',''),r.get('blocker_location','')]
    return f'已复原 {filled} 项；还需人工：'+'；'.join(dict.fromkeys(x for x in remaining if x))


def extension_url(url,ident):
    parts=urlsplit(url)
    fragment=parts.fragment+('&' if parts.fragment else '')+'bk='+ident
    return urlunsplit(parts._replace(fragment=fragment))


def render(rows,base,show_all=False):
    esc=lambda x:html.escape(str(x),quote=True)
    groups={}
    for r in rows:
        if not show_all and r['status'] in ('待核实','已跳过'): continue
        groups.setdefault(r['site'],[]).append(r)
    body=[]
    for site,items in sorted(groups.items()):
        body.append('<h2>'+esc(site)+'</h2><table><thead><tr>'+''.join('<th>'+x+'</th>' for x in ['来源','卡点','状态','恢复进度','操作'])+'</tr></thead><tbody>')
        for r in items:
            controls=''
            if r['status'] in ('待处理','待授权'):
                controls=f'<a target="_blank" rel="noopener noreferrer" href="{esc(extension_url(r["submit_url"],r["id"]))}">开始</a><form method="post" action="{esc(base)}" target="_blank"><input type="hidden" name="id" value="{esc(r["id"])}"><input type="hidden" name="action" value="start"><button>后台填</button></form>'
            if r['status'] in ('待人工','结果未知','续填中'):
                controls+=completion_controls(r,base)
            controls+=f'<form method="post" action="{esc(base)}"><input type="hidden" name="id" value="{esc(r["id"])}"><input type="hidden" name="action" value="skip"><input name="reason" required placeholder="跳过原因"><button>跳过</button></form>'
            cells=[r['source_domain'],r.get('blocker',''),r['status'],progress_summary(r)]
            body.append('<tr>'+''.join('<td>'+esc(x)+'</td>' for x in cells)+'<td>'+controls+'</td></tr>')
        body.append('</tbody></table>')
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>外链人工续填</title><style>body{font:16px system-ui;margin:24px}table{border-collapse:collapse;width:100%}td,th{padding:12px;border:1px solid #bbb;text-align:left}form{display:inline-block;margin:4px}button,input{font:inherit;padding:6px}</style><h1>外链人工续填</h1><p>未安装扩展时，“开始”只打开页面，不会自动填。处理卡点并自行提交后，点“我已完成”；这只记录待核实，不算提交。</p><a href="'+esc(base+('' if show_all else '?all=1'))+'">'+('隐藏已完成/已跳过' if show_all else '显示全部')+'</a>'+''.join(body)+'</html>'


def collect_completed_values(record,conf,browser_factory=BrowserCLI):
    # 只绑定已交接的原页；读取失败不阻断人工完成，也绝不新开或重放。
    if not record.get('browser_task') or record.get('browser_tab') is None:
        return
    try:
        browser=browser_factory(conf['browser_script'],Path(conf['handoff_dir'])/(record['id']+'.session'))
        browser.task=record['browser_task'];browser.tab=record['browser_tab']
        snap=browser.capture()
        values=[]
        for f in snapshot_fields(snap):
            if sensitive(f): continue
            value=f.get('value')
            if isinstance(value,list): value=value[0] if len(value)==1 else None
            if value in ('',None): continue
            values.append(dict(key=semantic_key(f) or 'label',label=f['label'],value=value))
        from .sources import source_event
        source_event(conf,record['source_domain'],'memory',values,'handoff:'+record['id']+':completed-readback',record['site'],by='manual')
    except (OSError,ValueError,KeyError,RuntimeError):
        return


def next_item(store,site):
    return next((r for r in sorted(store.rows(),key=lambda x:(x['created_at'],x['id']))
                 if r['site']==site and r['status'] in ('待处理','待授权')),None)


def complete_next(store,ident,conf,browser_factory=BrowserCLI):
    current=store.transition(ident,'done',conf['runs_dir'])
    nxt=next_item(store,current['site'])
    return dict(completed=current,next=resume(store,nxt['id'],conf,browser_factory) if nxt else None)


def load_token(path):
    # 常驻服务用固定令牌，地址重启不变；文件仅本人可读。
    path=Path(path).expanduser()
    if path.exists():
        token=path.read_text().strip()
        if len(token)>=32:
            return token
    path.parent.mkdir(parents=True,exist_ok=True)
    token=secrets.token_urlsafe(32)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:
        f.write(token+'\n')
    return token


def make_server(conf,port=0,token_file=None):
    store=Store(conf['handoff_dir'],conf)
    token=load_token(token_file) if token_file else secrets.token_urlsafe(32)
    route='/'+token+'/'
    from .agent_bridge import AgentBridge
    bridge=AgentBridge()
    active=set()
    import threading
    guard=threading.Lock()

    def run_resume(ident):
        try:
            resume(store,ident,conf)
        except Exception as exc:
            try:
                with store.lock(ident):
                    r=store.load(ident)
                    if r['status']=='续填中':
                        r.update(status='结果未知',message=str(exc)+'；先人工读回，不重放');store.save(r)
            except Exception:
                pass
        finally:
            with guard:
                active.discard(ident)

    def progress(ident):
        esc=lambda x:html.escape(str(x),quote=True)
        r=store.load(ident)
        running=ident in active
        tip='正在 Edge 里打开并填写，稍等…' if running else {'待人工':'已填好。处理卡点并自己点提交后，回到列表点「我已完成」。','待处理':'没有填写成功，可以回到列表再点开始。','待授权':'请在 Edge 扩展里批准后，回列表再点开始。'}.get(r['status'],'请回到列表查看。')
        refresh='<meta http-equiv="refresh" content="2">' if running else ''
        return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'+refresh+'<meta name="viewport" content="width=device-width"><title>续填进度</title>'
            '<style>body{font:16px system-ui;margin:24px;max-width:760px}p{line-height:1.6}.s{font-size:20px;font-weight:600}</style>'
            f'<h1>{esc(r["source_domain"])} → {esc(r["site"])}</h1><p class="s">{esc(r["status"])}</p><p>{esc(tip)}</p>'
            f'<p>{esc(r.get("message",""))}</p>'+ (completion_controls(r,route) if r['status'] in ('待人工','结果未知') else '')+f'<p>卡点说明：{esc(r.get("blocker_location",""))}</p><p><a href="{esc(route)}">返回列表</a></p></html>')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):
            pass
        def reply(self,status,body):
            raw=body.encode()
            self.send_response(status)
            self.send_header('Content-Type','text/html; charset=utf-8')
            self.send_header('Content-Length',str(len(raw)))
            self.send_header('Cache-Control','no-store')
            self.send_header('Referrer-Policy','same-origin')
            self.send_header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
            self.end_headers();self.wfile.write(raw)
        def allowed(self):
            host=f'127.0.0.1:{self.server.server_port}'
            origin=self.headers.get('Origin')
            path_ok=self.path in (route,route+'?all=1') or re.fullmatch(re.escape(route)+r'item/[0-9a-f]{32}',self.path) is not None
            return path_ok and self.headers.get('Host')==host and (not origin or origin=='http://'+host)
        def api_request(self):
            return urlsplit(self.path).path.startswith(route+'api/')
        def api_allowed(self):
            origin=self.headers.get('Origin')
            return (self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}'
                    and (self.extension_origin() or (origin is None and self.headers.get('X-Fast-Backlink')=='1'))
                    and self.api_request())
        def extension_origin(self):
            return re.fullmatch(r'chrome-extension://[a-p]{32}',self.headers.get('Origin','')) is not None
        def api_reply(self,status,body,mime='application/json; charset=utf-8'):
            raw=body if isinstance(body,bytes) else json.dumps(body,ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type',mime)
            self.send_header('Content-Length',str(len(raw)))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            if self.api_allowed() and self.extension_origin():
                self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
                self.send_header('Vary','Origin')
            self.end_headers();self.wfile.write(raw)
        def do_OPTIONS(self):
            if not self.api_allowed() or not self.extension_origin():
                return self.api_reply(403,{'error':'禁止访问'})
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
            self.send_header('Vary','Origin')
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers','Content-Type, X-Fast-Backlink')
            self.end_headers()
        def api_limit(self,endpoint):
            # 素材上传和日志批量最大，其余保持小体积，减少误用面。
            return {'kit':16_000_000,'asset':16_000_000,'logs':4_000_000,'snapshot':3_000_000,
                    'agent/command':4_000_000,'agent/result':4_000_000,
                    'ai_suggest':262144}.get(endpoint,262144)
        def handle_api(self,method):
            if not self.api_allowed():
                return self.api_reply(403,{'error':'禁止访问'})
            endpoint=urlsplit(self.path).path[len(route+'api/'):]
            if self.extension_origin():
                # 扩展的任意请求都是心跳；agent/next 另外记 polling。
                bridge.touch()
            try:
                query={k:v[0] for k,v in parse_qs(urlsplit(self.path).query).items()}
                data=None
                if method=='POST':
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=self.api_limit(endpoint) or self.headers.get('Content-Type','').split(';')[0]!='application/json':
                        raise ValueError('invalid_json_request')
                    data=json.loads(self.rfile.read(size))
                    if not isinstance(data,dict): raise ValueError('invalid_json_request')
                if endpoint.startswith('agent/'):
                    return self.handle_agent(endpoint,method,query,data)
                from .extension_api import ExtensionAPI
                api=ExtensionAPI(conf,store)
                if method=='GET':
                    if endpoint=='file':
                        raw,mime=api.file(query['site'],query['id'],query.get('sha256'))
                        return self.api_reply(200,raw,mime)
                    if endpoint=='stage':
                        return self.api_reply(200,api.stage(query['site'],query['id'],query.get('sha256')))
                    result=api.get(endpoint,query)
                else:
                    result=api.post(endpoint,data)
                return self.api_reply(200,result)
            except (ValueError,KeyError,TypeError,OSError,IndexError) as exc:
                return self.api_reply(409,{'error':str(exc) if isinstance(exc,ValueError) else '请求或资源不可用'})
        def handle_agent(self,endpoint,method,query,data):
            if endpoint=='agent/status':
                if method!='GET': raise ValueError('invalid_method')
                return self.api_reply(200,bridge.status())
            if endpoint=='agent/next':
                # 扩展 service worker 的 fetch 通常不带 Origin；本地令牌 + 专用头即边界。
                if method!='GET':
                    return self.api_reply(403,{'error':'禁止访问'})
                command=bridge.next(query.get('wait',20),query.get('version',''))
                return self.api_reply(200,{'command':command} if command else {})
            if endpoint=='agent/result':
                if method!='POST':
                    return self.api_reply(403,{'error':'禁止访问'})
                return self.api_reply(200,bridge.complete(data.get('id',''),data.get('result'),data.get('error')))
            if endpoint=='agent/command':
                if method!='POST': raise ValueError('invalid_method')
                return self.api_reply(200,bridge.submit(data.get('action'),data.get('args') or {},data.get('wait',60)))
            if endpoint=='agent/cancel':
                if method!='POST': raise ValueError('invalid_method')
                return self.api_reply(200,bridge.cancel(data.get('id','')))
            raise ValueError('invalid_endpoint')
        def do_GET(self):
            if self.api_request():
                return self.handle_api('GET')
            if not self.allowed():
                return self.reply(403,'禁止访问')
            if self.path not in (route,route+'?all=1'):
                try:
                    return self.reply(200,progress(self.path.rsplit('/',1)[1]))
                except (OSError,ValueError,KeyError):
                    return self.reply(404,'没有这一项')
            self.reply(200,render(store.rows(),route,self.path.endswith('?all=1')))
        def do_POST(self):
            if self.api_request():
                return self.handle_api('POST')
            if not self.allowed():
                return self.reply(403,'禁止访问')
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=8192:
                    raise ValueError('请求过大')
                data=parse_qs(self.rfile.read(size).decode())
                ident,action=data['id'][0],data['action'][0]
                if action=='start':
                    if self.path!=route:
                        raise ValueError('无效请求')
                    with guard:
                        if ident not in active:
                            if store.load(ident)['status'] not in ('待处理','待授权'):
                                raise ValueError('当前状态不允许续填；未知结果必须先人工核对')
                            active.add(ident)
                            threading.Thread(target=run_resume,args=(ident,),daemon=True).start()
                    self.send_response(303);self.send_header('Location',route+'item/'+ident);self.end_headers()
                    return
                elif action=='next':
                    current=store.transition(ident,'done',conf['runs_dir'])
                    nxt=next_item(store,current['site'])
                    if nxt:
                        with guard:
                            if nxt['id'] not in active:
                                active.add(nxt['id'])
                                threading.Thread(target=run_resume,args=(nxt['id'],),daemon=True).start()
                        self.send_response(303);self.send_header('Location',route+'item/'+nxt['id']);self.end_headers();return
                else:
                    store.transition(ident,action,conf['runs_dir'],data.get('reason',[''])[0])
                self.send_response(303);self.send_header('Location',route);self.end_headers()
            except (ValueError,KeyError,OSError) as exc:
                self.reply(409,html.escape(str(exc)))
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    # 测试和诊断可以直接看命令通道状态，不必再开第二个端口。
    server.bridge=bridge
    address=f'http://127.0.0.1:{server.server_port}{route}'
    atomic_json(store.root/'server.json',{'url':address,'pid':os.getpid()})
    return server,address
