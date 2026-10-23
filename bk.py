#!/usr/bin/env python3
"""外链筛选、排队、备料、核验和人工续填（Python 3.11+，标准库）。"""
import argparse
from collections import Counter, defaultdict
from datetime import timedelta
import json
from pathlib import Path
import sys
from backlink_kit.core import (ROOT, atomic_json, config_lock, load_config, today, day, read_csv, write_csv, output_csv,
    append_note, enrich_dr, screen, fetch, compile_kit, check_kit, fillplan, make_queue, due,
    verify_row, outreach_drafts, domain, rules, interval)
from backlink_kit.fbcli import CLIError


def run_dir(conf):
    p=Path(conf['runs_dir'])/str(today())
    p.mkdir(parents=True,exist_ok=True)
    return p


def json_file(path):
    return json.loads(Path(path).read_text())


def kit_for(conf,site):
    from backlink_kit import kits as kits_module
    if site not in conf['sites']:
        raise ValueError('目标站必须是配置中的站点键')
    return kits_module.load(conf,site)[0]


def screen_command(args,conf):
    fields,existing=read_csv(conf['directories'])
    if args.urls:
        rows=[]
        for url in args.urls:
            found=next((r for r in existing if domain(r['domain'])==domain(url)),{})
            rows.append({**found,'domain':domain(url),'submit_url':url if '://' in url else 'https://'+url})
    else:
        rows=[dict(r) for r in existing if r['status']=='待核实']
    if args.source_domain:
        if len(rows)!=1: raise ValueError('--source-domain 必须配一个 URL')
        rows[0]['domain']=domain(args.source_domain)
        original=next((r for r in existing if domain(r['domain'])==rows[0]['domain']),{})
        rows[0]={**original,**rows[0]}
    else:
        from backlink_kit.sources import source_domain
        for row in rows:
            row['domain']=source_domain(conf,row['submit_url'],row.get('domain') if not args.urls else None)
            original=next((r for r in existing if domain(r['domain'])==row['domain']),{})
            row.update({k:v for k,v in original.items() if k not in row or row[k] in ('','UNKNOWN')})
    rows=rows[:args.limit] if args.limit is not None else rows
    if args.snapshot and len(rows)!=1:
        raise ValueError('--snapshot 必须配一个 URL')
    if args.apply and args.dry_run:
        raise ValueError('--apply 与 --dry-run 互斥')
    enrich_dr(rows,conf['ahrefs_script'],args.offline)
    results,browser=[],[]
    for row in rows:
        url=row.get('submit_url')
        if not url or url=='UNKNOWN':
            url='https://'+row['domain']
        if args.snapshot:
            result=screen(json_file(args.snapshot),url,row,snapshot=True)
        else:
            response={'status':'fetch_failed','reason':'offline','html':''} if args.offline else fetch(url,args.timeout)
            if response['status']=='ok':
                result=screen(response['html'],url,row)
            else:
                result={**row,'submit_url':url,'status':'待核实','observation':response['status'],'reasons':[response['reason']],'browser_required':True}
        results.append(result)
        if result.get('browser_required'):
            browser.append({'submit_url':url,'source_domain':row['domain'],'reason':result['reasons'],'task':'semantic_snapshot + 表单结构 → screen --snapshot'})
        if args.apply:
            current=next((r for r in existing if domain(r['domain'])==domain(row['domain'])),None)
            if current is None:
                current={k:'' for k in fields};existing.append(current)
            for key in fields:
                if key in result and key!='notes':
                    value=result[key]
                    current[key]=json.dumps(value,ensure_ascii=False) if isinstance(value,(dict,list,bool)) else str(value)
            append_note(current,'backlink-kit '+str(today())+' '+json.dumps(result.get('reasons',[]),ensure_ascii=False))
    out=run_dir(conf)
    output_csv(out/'screen.csv',results)
    atomic_json(out/'screen-browser-tasks.json',browser)
    approvals=[]
    draft_text=['# 待批草稿（未提交）','']
    for result in results:
        if result.get('draft_status')!='drafted':
            continue
        for site in conf['sites']:
            if site not in result.get('fit_sites','').lower():
                continue
            kit=kit_for(conf,site)['fields']
            approvals.append(dict(source_domain=result['domain'],site=site,scenario=result['scenario'],status='drafted',submit_url=result['submit_url'],target_url=kit['url']['value']))
            draft_text += ['## '+result['domain']+' / '+site, '状态：drafted；执行前须另行批准。', kit['name']['value'],kit['description']['value'],kit['url']['value'],'']
    output_csv(out/'approvals.csv',approvals,['source_domain','site','scenario','status','submit_url','target_url'])
    (out/'approval-drafts.md').write_text('\n'.join(draft_text))
    if not args.dry_run:
        from backlink_kit.sources import source_event
        for result in results:
            source_event(conf,result['domain'],'screen',result,out/'screen.csv')
    if args.apply:
        write_csv(conf['directories'],fields,existing,apply=True)
    print(json.dumps({'count':len(results),'results':str(out/'screen.csv'),'browser_tasks':len(browser),'conclusions':dict(Counter(r['status'] for r in results))},ensure_ascii=False))


def queue_command(args,conf):
    directories=read_csv(conf['directories'])[1]
    # 场景证据存独立结果，不扩张或改写真实 CSV 列。
    path=run_dir(conf)/'screen.csv'
    if path.exists():
        screens={domain(r['domain']):r for r in read_csv(path)[1]}
        for row in directories:
            evidence=screens.get(domain(row['domain']))
            if evidence and evidence.get('status')=='可投':
                row.update(scenario=evidence['scenario'],dr=evidence['dr'],dr_date=evidence['dr_date'])
    queue=make_queue(directories,read_csv(conf['ledger'])[1],conf,args.offline)
    output_csv(run_dir(conf)/'queue.csv',queue,['source_domain','site','scenario','submit_url','target_url','dr','dr_date','status'])
    print(json.dumps({'queued':len(queue),'path':str(run_dir(conf)/'queue.csv')},ensure_ascii=False))


def verify_command(args,conf):
    fields,rows=read_csv(conf['ledger'])
    indices=[i for i,r in enumerate(rows) if due(r)]
    out=run_dir(conf)
    output_csv(out/'verify-due.csv',[rows[i] for i in indices],fields)
    if args.list_only or args.offline:
        print(json.dumps({'due':len(indices),'fetched':0,'rows':[{'record_id':rows[i]['record_id'],'source_url':rows[i]['source_url']} for i in indices]},ensure_ascii=False))
        return
    if args.apply and args.dry_run:
        raise ValueError('--apply 与 --dry-run 互斥')
    results,browser=[],[]
    for i in indices:
        response=fetch(rows[i]['source_url'],args.timeout)
        result=verify_row(rows[i],response,conf['sites'])
        results.append(result)
        if response['status']=='browser_required' or result.get('observation')=='browser_required':
            browser.append({'record_id':rows[i]['record_id'],'source_url':rows[i]['source_url'],'reason':'浏览器补核公开 href；不可自动认定 removed'})
        rows[i]={k:result.get(k,'') for k in fields}
    output_csv(out/'verify.csv',results,fields+['observation'])
    atomic_json(out/'verify-browser-tasks.json',browser)
    if not args.dry_run:
        from backlink_kit.sources import source_event
        for result in results:
            source_event(conf,result['source_domain'],'history',result,out/'verify.csv')
    if args.apply:
        write_csv(conf['ledger'],fields,rows,apply=True)
    print(json.dumps({'due':len(indices),'fetched':len(results),'outcomes':dict(Counter(r['status'] for r in results)),'path':str(out/'verify.csv')},ensure_ascii=False))


def kits_command(args,conf):
    from backlink_kit import kits as kits_module
    if args.kits_action=='new':
        import re
        if not args.site or not re.fullmatch('[a-z][a-z0-9-]*',args.site):
            raise ValueError('站点键只允许小写字母、数字和连字符')
        homepage=kits_module.homepage(args.url) if args.url else ''
        with config_lock(args.config):
            conf=load_config(args.config)
            if args.site in conf['sites']:
                raise ValueError('站点已登记')
            directory=kits_module.kit_dir(conf,args.site)
            if (directory/'kit.json').exists(): raise ValueError('资料包已存在')
            template: dict=kits_module.empty_kit(args.site)
            template['source']='待补充事实来源'
            for key in sorted({v for v in rules('kit-fields').values()}|set(kits_module.REQUIRED_KEYS)):
                template['fields'][key]=kits_module.variant('')
            if homepage:
                template['fields'].update(url=kits_module.variant(homepage),domain=kits_module.variant(domain(homepage)),
                                          url_bare=kits_module.variant(homepage.split('://',1)[1].rstrip('/')))
            kits_module.save(conf,args.site,template)
            raw=json_file(args.config)
            raw['sites'][args.site]={'domain':domain(homepage) if homepage else '','kit':args.site+'/kit.json'}
            atomic_json(args.config,raw)
        message='已登记网址；启动或重启服务后，在素材库补齐名称、介绍和图片。' if homepage else '补齐事实、图片和config中的domain，再运行 kits --check'
        print(json.dumps({'site':args.site,'template':str(directory/'kit.json'),'message':message},ensure_ascii=False))
        return
    if args.kits_action=='migrate':
        report=kits_module.migrate(conf,apply=args.apply)
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 0 if all(e['status'] in ('已迁移','已经是 v2，跳过') for e in report['kits']) else 1
    if args.kits_action=='summary':
        print(json.dumps([kits_module.kit_summary(conf,site) for site in conf['sites']],ensure_ascii=False,indent=2))
        return
    errors={}
    profile=kits_module.profile(conf)
    for site,settings in conf['sites'].items():
        if args.kits_action != 'check' and not args.check:
            # 只允许从 markdown 重建到独立目录；真实资料目录不就地覆盖。
            target=kits_module.kit_dir(conf,site)
            if target.resolve()==Path(conf['kits_source']).resolve():
                raise ValueError('生成目录不可与真实资料目录相同')
            kits_module.save(conf,site,kits_module.from_v1(site,compile_kit(Path(conf['kits_source'])/(site+'.md'))))
        kit,directory=kits_module.load(conf,site)
        found,warnings=kits_module.check(kit,directory,profile)
        if not settings.get('domain'): found.append('config: 缺少目标域名')
        errors[site]={'errors':found,'warnings':warnings}
    print(json.dumps(errors,ensure_ascii=False,indent=2))
    return int(any(v['errors'] for v in errors.values()))


def fb_report_command(args,conf):
    """Fast-Backlink 周报：读扩展日志算自动填写率、未匹配标签、失败控件、复原成功率。"""
    from backlink_kit import fbreport
    report,output,count=fbreport.write(conf['logs_dir'],days=args.days,output=args.output)
    if args.learn:
        from backlink_kit.fbstores import LearningStore
        learned=LearningStore(conf['learned_file']).rebuild(conf['sources_dir'])
        report['learned']=learned['labels']
    print(json.dumps({'days':args.days,'entries':count,'path':str(output),
                      'sources':len(report['sources']),'restore_success_rate':report['restore_success_rate']},ensure_ascii=False))
    if args.json:
        print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0


def outreach_command(args,conf):
    queue=read_csv(args.queue or run_dir(conf)/'queue.csv')[1]
    ledger=read_csv(conf['ledger'])[1]
    source=Path(conf['outreach_template']).read_text()
    template=source.split('Subject:',1)[1].split('## 记账',1)[0].strip()
    template='Subject:'+template
    drafts=outreach_drafts(queue,ledger,{s:kit_for(conf,s) for s in conf['sites']},template)
    out=run_dir(conf)
    if args.snapshot:
        if len(drafts)!=1:
            raise ValueError('Contact 快照需队列只含一条符合门槛的外联草稿')
        draft=drafts[0]
        contact_kit=kit_for(conf,draft['site'])
        subject,_,message=draft['body'].partition('\n\n')
        contact_kit['fields']['subject']={'value':subject.removeprefix('Subject:').strip()}
        contact_kit['fields']['message']={'value':message}
        atomic_json(out/'contact-fillplan.json',fillplan(json_file(args.snapshot),contact_kit))
    (out/'outreach-drafts.md').write_text('# 外联草稿（未发送）\n\n{why_fit} 须按来源页填写；不可直接发送未核实占位符。\n\n'+'\n\n'.join('## '+d['source_domain']+' / '+d['site']+'\n状态：drafted\n\n'+d['body'] for d in drafts))
    output_csv(out/'outreach-approvals.csv',[{k:v for k,v in d.items() if k!='body'} for d in drafts],['source_domain','site','status'])
    print(json.dumps({'drafted':len(drafts),'sent':0},ensure_ascii=False))


def report_command(args,conf):
    ledger=read_csv(conf['ledger'])[1]
    dirs=read_csv(conf['directories'])[1]
    start=today()-timedelta(days=today().weekday())
    recent=lambda x:day(x) is not None and start<=day(x)<=today()
    public=sum(recent(r['first_public_at']) for r in ledger)
    submitted=sum(recent(r['submitted_at']) for r in ledger)
    domains={domain(r['source_domain']) for r in ledger if recent(r.get('last_checked_at')) or recent(r.get('submitted_at'))}
    for path in Path(conf['runs_dir']).glob('*/screen.csv'):
        if recent(path.parent.name):
            domains.update(domain(r['domain']) for r in read_csv(path)[1])
    pending=sum(r['status']=='待饼哥' for r in dirs)
    lines=[f'本周新公开 {public} / 新提交 {submitted} / 处理域 {len(domains)} / 待饼哥 {pending}']
    scenarios=defaultdict(list)
    for row in ledger:
        scenarios[row['channel_type']].append(row)
    lines+=['','按场景公开率（已到期且可判定的提交；unknown 不入分母）：']
    for scenario,rows in sorted(scenarios.items()):
        eligible=[r for r in rows if day(r.get('submitted_at')) and day(r['submitted_at'])+timedelta(days=interval({**r,'status':'submitted'}))<=today() and r['status'].lower() in ('submitted','pending','public','alive','live','removed')]
        n=sum(bool(day(r.get('first_public_at'))) or r['status'].lower() in ('public','alive','live') for r in eligible)
        lines.append(f'- {scenario}: {n}/{len(eligible)}'+(f' ({n/len(eligible):.1%})' if eligible else ' (UNKNOWN)'))
    reasons=Counter()
    for row in dirs:
        if row['status'] not in ('待饼哥','待核实','不做'):
            continue
        for key,patterns in rules('keywords')['signals'].items():
            from backlink_kit.core import hits
            if hits(row.get('notes',''),patterns):
                reasons[key]+=1
    lines+=['','卡住原因分布：'+json.dumps(dict(reasons),ensure_ascii=False)]
    path=run_dir(conf)/'queue.csv'
    lines+=['队列长度：'+str(len(read_csv(path)[1]) if path.exists() else 0)]
    text='\n'.join(lines)+'\n'
    (run_dir(conf)/'bk-report.md').write_text(text)
    print(text,end='')


def handoff_command(args,conf):
    from backlink_kit.handoff import Store, save_progress, render, make_server
    store=Store(conf['handoff_dir'],conf)
    if args.handoff_action=='save':
        record=save_progress(store.root,args.source_domain,args.site,args.url,json_file(args.plan),json_file(args.steps) if args.steps else [],args.step,args.blocker,args.location,[dict(zip(('label','value'),x.split('=',1))) if '=' in x else {'label':x,'value':None} for x in args.set])
        from backlink_kit.sources import source_event
        source_event(conf,record['source_domain'],'handoff',record,store.path(record['id']),by='plan')
        if args.steps:
            steps=json_file(args.steps)+[{'fields':json_file(args.plan)['items']}]
            source_event(conf,record['source_domain'],'capture',{'steps':steps},args.steps)
        if args.set:
            from backlink_kit.handoff import merge_fields
            extra=[dict(zip(('label','value'),x.split('=',1))) for x in args.set]
            source_event(conf,record['source_domain'],'memory',merge_fields([],extra),store.path(record['id']),record['site'],by='manual')
        print(json.dumps(record,ensure_ascii=False))
    elif args.handoff_action=='list':
        info=store.root/'server.json'
        address=json_file(info).get('url') if info.exists() else '服务未运行；bk.py handoff serve'
        print('列表页：'+address+'（地址来自服务登记，未验证服务存活）')
        for row in sorted(store.rows(),key=lambda r:(r['site'],r['created_at'])):
            if not args.all and row['status'] in ('待核实','已跳过'): continue
            print(' | '.join(str(row.get(k,'')) for k in ('id','source_domain','site','blocker','created_at','status','message')))
    elif args.handoff_action=='render':
        Path(args.output).write_text(render(store.rows(),'#',args.all))
        print(args.output)
    elif args.handoff_action=='serve':
        server,address=make_server(conf,args.port,args.token_file)
        import signal
        # launchd 停止时发 SIGTERM，按 Ctrl-C 同样清理登记文件。
        signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        print(address,flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            (store.root/'server.json').unlink(missing_ok=True)
    elif args.handoff_action in ('done','skip','next'):
        if args.handoff_action=='next':
            from backlink_kit.handoff import complete_next
            print(json.dumps(complete_next(store,args.id,conf),ensure_ascii=False));return
        print(json.dumps(store.transition(args.id,args.handoff_action,conf['runs_dir'],getattr(args,'reason','')),ensure_ascii=False))


def capture_command(args,conf):
    # 在已登录 Edge 普通窗口打开提交页，取快照后关闭本次工作页；只读，不填写。
    import secrets
    from backlink_kit.browser import BrowserCLI
    session=run_dir(conf)/('capture-'+secrets.token_hex(6)+'.session')
    browser=BrowserCLI(conf['browser_script'],session,conf.get('edge_instance'))
    try:
        browser.open(args.url)
        snap=browser.capture(args.root)
    finally:
        try:
            browser.close()
        finally:
            session.unlink(missing_ok=True)
    out=Path(args.output)
    from backlink_kit.sources import source_domain, source_event
    name=source_domain(conf,args.url,args.source_domain)
    snap.update(url=args.url,source_domain=name)
    atomic_json(out,snap)
    source_event(conf,name,'capture',snap,out)
    print(json.dumps({'snapshot':str(out),'fields':[f.get('label') for f in snap.get('fields',[])]},ensure_ascii=False))



def source_command(args,conf):
    from backlink_kit.sources import SourceStore, import_library, statistics, basic, submitted
    store=SourceStore(conf['sources_dir'])
    if args.source_action=='import':
        if args.apply==args.dry_run: raise ValueError('必须且只能选择 --dry-run 或 --apply')
        records,report=import_library(conf)
        if args.apply:
            store.import_records(records)
            report.update(statistics(store.rows()))
        print(json.dumps(report,ensure_ascii=False,indent=2));return
    if args.source_action=='show':
        print(json.dumps(store.load(args.domain),ensure_ascii=False,indent=2));return
    ledger=read_csv(conf['ledger'])[1]
    rows=[r for r in store.rows() if (not args.status or r['admission'].get('value','待核实')==args.status)
        and (not args.fit or args.fit.lower() in basic(r,'fit_sites').lower().split('|'))
        and (not args.not_submitted or not submitted(r,args.not_submitted,ledger))]
    print(json.dumps(rows,ensure_ascii=False,indent=2))


def campaign_command(args,conf):
    from backlink_kit import kits as kits_module
    from backlink_kit.sources import SourceStore, import_library, campaign
    from backlink_kit.handoff import save_progress
    kit,directory=kits_module.load(conf,args.site)
    errors,warnings=kits_module.check(kit,directory,kits_module.profile(conf))
    if not conf['sites'][args.site].get('domain'):errors.append('config: 缺少目标域名')
    if errors: raise ValueError('资料包校验失败：'+'；'.join(errors))
    records=SourceStore(conf['sources_dir']).rows()
    origin='library'
    if not records and args.dry_run:
        imported,_=import_library(conf);records=list(imported.values());origin='import-preview'
    if not records and not args.dry_run:raise ValueError('资源库为空；先 source import --dry-run，核对后 --apply')
    result=campaign(records,read_csv(conf['ledger'])[1],args.site,kit)
    existing=[]
    for path in Path(conf['handoff_dir']).glob('*.json'):
        row=json_file(path)
        if row.get('source_domain') and row.get('site'):existing.append(row)
    duplicate=[];new=[]
    for row in result['handoff']:
        if any(domain(r['source_domain'])==row['source_domain'] and r['site']==args.site and r.get('status')!='已跳过' for r in existing):
            duplicate.append(row['source_domain'])
        else:new.append(row)
    report=dict(site=args.site,library_origin=origin,sources=len(records),ready=len(result['ready']),
        handoff=len(new),existing_handoff=duplicate,need_capture=result['capture'],excluded=result['excluded'])
    if not args.dry_run:
        out=run_dir(conf);rows=[]
        for row in result['ready']+new:
            path=out/('campaign-'+args.site+'-'+row['source_domain']+'.json')
            atomic_json(path,{'source_domain':row['source_domain'],'site':args.site,'submit_url':row['submit_url'],'plans':row['plans'],'steps':row['steps']})
            if row in result['ready']:
                rows.append({k:row[k] for k in ('source_domain','site','submit_url','dr','dr_date')}|{'plan':str(path)})
            else:
                blockers=row['blockers']
                stopped=[i for i,p in enumerate(row['plans']) if p['status']!='ready']+[b['step'] for b in blockers]
                stop_at=min(stopped) if stopped else len(row['plans'])-1
                previous=[{'fields':p['items'],'next':step['next']} for p,step in zip(row['plans'][:stop_at],row['steps'][:stop_at])]
                record=save_progress(conf['handoff_dir'],row['source_domain'],args.site,row['submit_url'],row['plans'][stop_at],previous,len(previous),
                    ','.join(b['kind'] for b in blockers) or '字段需人工补充','；'.join(b['location'] for b in blockers) or '当前表单')
                from backlink_kit.sources import source_event
                source_event(conf,row['source_domain'],'handoff',record,Path(conf['handoff_dir'])/(record['id']+'.json'),by='plan')
        output_csv(out/('campaign-'+args.site+'.csv'),rows,['source_domain','site','submit_url','dr','dr_date','plan'])
        output_csv(out/('campaign-'+args.site+'-capture.csv'),result['capture'],['source_domain','site','submit_url','reason'])
    print(json.dumps(report,ensure_ascii=False,indent=2))


def fillplan_command(args,conf):
    from backlink_kit.sources import SourceStore, source_domain, source_event
    snap=json_file(args.snapshot)
    url=snap.get('url','')
    name=source_domain(conf,url,args.source_domain or snap.get('source_domain')) if url or args.source_domain else None
    record=SourceStore(conf['sources_dir']).load(name) if name else None
    saved=record['memories'].get(args.site,{}).get('fields',[]) if record else []
    extra=[dict(zip(('label','value'),x.split('=',1))) if '=' in x else {'label':x,'value':None} for x in args.set]
    from backlink_kit.handoff import merge_fields
    saved=merge_fields(saved,extra)
    if extra and not name:raise ValueError('--set 写回需要 --source-domain 或带URL的快照')
    result=fillplan(snap,kit_for(conf,args.site),saved)
    result.update(source_domain=name,site=args.site,submit_url=url)
    if args.output: atomic_json(args.output,result)
    if name:
        source_event(conf,name,'memory',result['items'],args.output or args.snapshot,args.site,by='plan')
        if extra:source_event(conf,name,'memory',merge_fields([],extra),args.output or args.snapshot,args.site,by='manual')
    print(json.dumps(result,ensure_ascii=False,indent=2))

def ai_command(args,conf):
    from backlink_kit.ai import check
    fields=args.field or ['Your Website','Short description','How did you hear about us?']
    result=check(conf,args.site,fields)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if result.get('ok') else 2


def assets_command(args,conf):
    from backlink_kit.assets import export, reuse
    result = export(conf,args.output) if args.asset_action=='export' else reuse(conf,args.site)
    print(json.dumps(result,ensure_ascii=False,indent=2))


def fb_command(args,conf):
    """Fast-Backlink Agent CLI：输出 JSON，页面动作经本机服务转给扩展。"""
    from backlink_kit.fbcli import run
    return run(args,conf)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',default=str(ROOT/'config.json'))
    commands=parser.add_subparsers(dest='command',required=True)
    p=commands.add_parser('screen');p.add_argument('urls',nargs='*');p.add_argument('--snapshot');p.add_argument('--source-domain');p.add_argument('--limit',type=int);p.add_argument('--timeout',type=float,default=10)
    p.add_argument('--dry-run',action='store_true');p.add_argument('--apply',action='store_true');p.add_argument('--offline',action='store_true')
    p=commands.add_parser('queue');p.add_argument('--offline',action='store_true')
    p=commands.add_parser('capture');p.add_argument('url');p.add_argument('--output',required=True);p.add_argument('--root');p.add_argument('--source-domain')
    p=commands.add_parser('fillplan');p.add_argument('--snapshot',required=True);p.add_argument('--site',required=True);p.add_argument('--output');p.add_argument('--source-domain');p.add_argument('--set',action='append',default=[])
    p=commands.add_parser('verify');p.add_argument('--dry-run',action='store_true');p.add_argument('--apply',action='store_true');p.add_argument('--offline',action='store_true');p.add_argument('--list-only',action='store_true');p.add_argument('--timeout',type=float,default=10)
    p=commands.add_parser('outreach');p.add_argument('--queue');p.add_argument('--snapshot')
    p=commands.add_parser('kits');p.add_argument('kits_action',nargs='?',choices=['new','check','migrate','summary']);p.add_argument('site',nargs='?');p.add_argument('--url',help='新产品首页，自动登记域名');p.add_argument('--check',action='store_true');p.add_argument('--apply',action='store_true')
    p=commands.add_parser('source');sub=p.add_subparsers(dest='source_action',required=True)
    p=sub.add_parser('import');p.add_argument('--dry-run',action='store_true');p.add_argument('--apply',action='store_true')
    p=sub.add_parser('show');p.add_argument('domain')
    p=sub.add_parser('list');p.add_argument('--status');p.add_argument('--fit');p.add_argument('--not-submitted')
    p=commands.add_parser('campaign');p.add_argument('--site',required=True);p.add_argument('--dry-run',action='store_true')
    p=commands.add_parser('assets');sub=p.add_subparsers(dest='asset_action',required=True)
    p=sub.add_parser('export');p.add_argument('--output',required=True)
    p=sub.add_parser('reuse');p.add_argument('--site',required=True)
    commands.add_parser('report')
    p=commands.add_parser('fb-report');p.add_argument('--days',type=int,default=7);p.add_argument('--output');p.add_argument('--json',action='store_true');p.add_argument('--learn',action='store_true')
    p=commands.add_parser('ai');sub=p.add_subparsers(dest='ai_action',required=True)
    p=sub.add_parser('check');p.add_argument('--site');p.add_argument('--field',action='append',default=[])
    p=commands.add_parser('fb',help='Fast-Backlink Agent CLI（JSON）');sub=p.add_subparsers(dest='fb_action',required=True)
    common=argparse.ArgumentParser(add_help=False)
    common.add_argument('--service');common.add_argument('--pretty',action='store_true');common.add_argument('--json',action='store_true',help=argparse.SUPPRESS)
    p=sub.add_parser('status',parents=[common]);p.add_argument('--wait',type=float,default=5)
    p=sub.add_parser('tabs',parents=[common]);p.add_argument('--wait',type=float,default=10)
    p=sub.add_parser('open',parents=[common]);p.add_argument('url',nargs='?');p.add_argument('--site');p.add_argument('--item');p.add_argument('--no-fill',action='store_true');p.add_argument('--force',action='store_true');p.add_argument('--wait',type=float,default=60)
    p=sub.add_parser('fill',parents=[common]);p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--site');p.add_argument('--item');p.add_argument('--force',action='store_true');p.add_argument('--open',action='store_true');p.add_argument('--wait',type=float,default=60)
    p=sub.add_parser('ai',parents=[common]);p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--site');p.add_argument('--item');p.add_argument('--apply',action='store_true');p.add_argument('--min-conf',type=float,default=0.9);p.add_argument('--open',action='store_true');p.add_argument('--wait',type=float,default=90)
    p=sub.add_parser('restore',parents=[common]);p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--site');p.add_argument('--item');p.add_argument('--snapshot');p.add_argument('--wait',type=float,default=60)
    p=sub.add_parser('remember',parents=[common]);p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--site');p.add_argument('--item');p.add_argument('--wait',type=float,default=60)
    p=sub.add_parser('snapshot',parents=[common]);p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--site');p.add_argument('--item');p.add_argument('--output');p.add_argument('--wait',type=float,default=60)
    p=sub.add_parser('steps',parents=[common]);p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--site');p.add_argument('--item');p.add_argument('--wait',type=float,default=30)
    p=sub.add_parser('state',parents=[common]);p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--site');p.add_argument('--item');p.add_argument('--wait',type=float,default=30)
    p=sub.add_parser('done',parents=[common]);p.add_argument('id',nargs='?');p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--open',action='store_true');p.add_argument('--steps');p.add_argument('--wait',type=float,default=60)
    p=sub.add_parser('skip',parents=[common]);p.add_argument('id');p.add_argument('--reason',required=True)
    p=sub.add_parser('queue',parents=[common]);p.add_argument('--site')
    for name in ('sites','kits','health'):p=sub.add_parser(name,parents=[common])
    p=sub.add_parser('snapshots',parents=[common]);p.add_argument('--source');p.add_argument('--url');p.add_argument('--fingerprint');p.add_argument('--limit',type=int,default=20)
    p=sub.add_parser('logs',parents=[common]);p.add_argument('--days',type=int,default=7);p.add_argument('--level');p.add_argument('--cat');p.add_argument('--site');p.add_argument('--source');p.add_argument('--limit',type=int,default=500)
    p=sub.add_parser('report',parents=[common]);p.add_argument('--days',type=int,default=7)
    p=sub.add_parser('settings',parents=[common]);p.add_argument('--patch');p.add_argument('--set',action='append',default=[])
    p=sub.add_parser('batch',parents=[common]);batch_sub=p.add_subparsers(dest='batch_action',required=True)
    p=batch_sub.add_parser('start');p.add_argument('--site',required=True);p.add_argument('--domains',required=True);p.add_argument('--batch-size',type=int,default=10);p.add_argument('--wait',type=float,default=60)
    p=batch_sub.add_parser('status');p.add_argument('id',nargs='?');p.add_argument('--wait',type=float,default=10)
    p=batch_sub.add_parser('stop');p.add_argument('id');p.add_argument('--wait',type=float,default=10)
    p=sub.add_parser('cancel',parents=[common]);p.add_argument('id')
    p=sub.add_parser('call',parents=[common]);p.add_argument('call_action');p.add_argument('--args');p.add_argument('--args-file');p.add_argument('--tab',type=int);p.add_argument('--url');p.add_argument('--wait',type=float,default=60);p.add_argument('--patch');p.add_argument('--set',action='append',default=[])
    p=commands.add_parser('handoff');sub=p.add_subparsers(dest='handoff_action',required=True)
    p=sub.add_parser('list');p.add_argument('--all',action='store_true');p=sub.add_parser('serve');p.add_argument('--port',type=int,default=0);p.add_argument('--token-file')
    p=sub.add_parser('render');p.add_argument('--output',required=True);p.add_argument('--all',action='store_true')
    p=sub.add_parser('save');p.add_argument('--plan',required=True);p.add_argument('--source-domain',required=True);p.add_argument('--site',required=True);p.add_argument('--url',required=True);p.add_argument('--step',type=int,default=0);p.add_argument('--steps');p.add_argument('--blocker',required=True);p.add_argument('--location',default='当前表单');p.add_argument('--set',action='append',default=[],metavar='标签=值')
    for action in ('done','skip','next'):
        p=sub.add_parser(action);p.add_argument('id')
        if action=='skip':p.add_argument('--reason',required=True)
    args=parser.parse_args(argv)
    try:
        conf=load_config(args.config)
        handler=globals()[args.command.replace('-','_')+'_command']
        return handler(args,conf) or 0
    except CLIError as exc:
        print(json.dumps(exc.payload,ensure_ascii=False),file=sys.stderr)
        return exc.code
    except (OSError,ValueError,KeyError) as exc:
        print('停止：'+str(exc),file=sys.stderr)
        return 2


if __name__=='__main__':
    sys.exit(main())
