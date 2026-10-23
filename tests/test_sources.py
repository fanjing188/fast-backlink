"""资源库与复用流程只使用临时副本和假浏览器。"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout, redirect_stderr
from copy import deepcopy
from datetime import timedelta
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bk
from backlink_kit import core as c, sources as s, handoff as h, browser as b
from tests.test_kit import kit, FakeBrowser
from tests.support import fixture_config


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.conf=fixture_config()
        self.conf.update({key:str(self.root/key) for key in ('directories','ledger','handoff_dir','runs_dir','sources_dir','raw_sources_dir')})
        self.conf['kits_dir']=str(self.root/'kits');Path(self.conf['kits_dir']).mkdir()
        c.atomic_json(Path(self.conf['kits_dir'])/'probekits.json',kit())
        for folder in ('handoff_dir','runs_dir','raw_sources_dir'):Path(self.conf[folder]).mkdir()
        c.write_csv(self.conf['directories'],['domain','submit_url','status','fit_sites','dr','dr_date','last_verified','notes'],[])
        c.write_csv(self.conf['ledger'],['record_id','source_domain','site','status','submitted_at','first_public_at','last_checked_at'],[])
        self.config=self.root/'config.json';c.atomic_json(self.config,self.conf)
        self.store=s.SourceStore(self.conf['sources_dir'])

    def source(self,name='x.example'):
        row=dict(domain=name,submit_url='https://'+name+'/submit',status='可投',fit_sites='ProbeKits',scenario='directory',
                 dr='25',dr_date=str(c.today()),cost='free',backlink_required=False,license_risk=False,automation_forbidden=False)
        self.store.update(name,'screen',row,s.evidence('manual-proof','Free submission; no backlink required',by='manual'))
        return self.store.update(name,'capture',{'fields':[{'label':'Product name','inputType':'text','required':True,'maxlength':50}]},s.evidence('capture'))

    def cli(self,*args):
        output=io.StringIO()
        with redirect_stdout(output),redirect_stderr(io.StringIO()):code=bk.main(['--config',str(self.config),*args])
        return code,output.getvalue()

    def test_atomic_lock_concurrent_updates_and_index(self):
        self.source()
        def write(i):
            return self.store.update('x.example','history',dict(record_id=str(i),site='probekits',status='submitted'),s.evidence('ledger'))
        with ThreadPoolExecutor(max_workers=5) as pool:list(pool.map(write,range(25)))
        self.assertEqual(len(self.store.load('x.example')['history']),25)
        self.assertEqual(c.read_csv(self.store.root/'index.csv')[1][0]['history'],'25')
        self.assertEqual(list(self.store.root.glob('.bk-*')),[])

    def test_manual_precedence_and_evidence_accumulates(self):
        self.source()
        self.store.update('x.example','screen',{'status':'不做','dr':'1'},s.evidence('new-auto'))
        row=self.store.load('x.example')
        self.assertEqual(row['admission']['value'],'可投');self.assertEqual(s.basic(row,'dr'),'25')
        self.assertEqual(len(row['admission']['evidence']),2)
        self.store.update('x.example','screen',{'status':'不做'},s.evidence('manual',by='manual'))
        self.assertEqual(self.store.load('x.example')['admission']['value'],'不做')

    def test_fingerprint_stable_refs_values_and_keeps_old_structure(self):
        row=self.source();original=row['recipe']['fingerprint']
        row=self.store.update('x.example','capture',{'fields':[{'label':'Product name','ref':'changed','value':'private','inputType':'text','required':True,'maxlength':50}]},s.evidence('capture2'))
        self.assertEqual(row['recipe']['fingerprint'],original)
        row=self.store.update('x.example','capture',{'fields':[{'label':'Product name','inputType':'text','maxlength':10}]},s.evidence('capture3'))
        self.assertEqual(row['recipe']['state'],'表单已变');self.assertEqual(len(row['recipe_versions']),1)
        self.assertNotIn('private',json.dumps(row))

    def test_memory_exact_labels_and_manual_mapping(self):
        self.source()
        fields=[{'key':'category','label':'Topics','value':'Computing'},{'key':'category','label':'Categories','value':'Hardware'}]
        self.store.update('x.example','memory',fields,s.evidence('actual',by='manual'),'probekits')
        self.store.update('x.example','memory',[dict(key='name',label='Topics',value='wrong')],s.evidence('plan',by='plan'),'probekits')
        memory=self.store.load('x.example')['memories']['probekits']
        self.assertEqual(memory['labels']['Topics'],'category')
        snap={'fields':[dict(label=x['label'],role='combobox',options=[x['value']],key=memory['labels'][x['label']]) for x in fields]}
        plan=c.fillplan(snap,kit(),memory['fields'])
        self.assertEqual([x['value'] for x in plan['items']],['Computing','Hardware'])
        self.assertEqual(c.semantic_key({'label':'Your web site domain name or URL'}),'url')
        self.assertEqual(c.semantic_key({'label':'Your e-mail address'}),'email')
        self.assertIsNone(c.semantic_key({'label':'First Name'}))

    def test_memory_never_saves_sensitive(self):
        self.source()
        self.store.update('x.example','memory',[dict(key='password',label='Other',value='SECRET'),dict(key='label',label='Card number',value='SECRET')],s.evidence('actual',by='manual'),'probekits')
        self.assertNotIn('SECRET',json.dumps(self.store.load('x.example')))

    def test_history_idempotence_and_actual_review_days(self):
        self.source()
        row=dict(record_id='id',site='probekits',status='public',submitted_at='2026-10-01',first_public_at='2026-10-04',raw_href='https://probekits.com',rel='nofollow')
        for _ in range(2):self.store.update('x.example','history',row,s.evidence('ledger'))
        record=self.store.load('x.example')
        self.assertEqual(len(record['history']),1);self.assertEqual(record['review_days_actual'],[3])

    def test_import_dry_run_and_apply_idempotent_preserve_manual(self):
        fields=['domain','submit_url','status','fit_sites','dr','dr_date','last_verified','notes']
        c.write_csv(self.conf['directories'],fields,[dict(domain='x.example',submit_url='https://tally.so/r/abc',status='不做',fit_sites='ProbeKits',dr=25,dr_date=str(c.today()),last_verified=str(c.today()),notes='manual')])
        c.write_csv(self.conf['ledger'],['record_id','source_domain','site','status','submitted_at','first_public_at'],[dict(record_id='1',source_domain='x.example',site='probekits',status='public',submitted_at='2026-10-01',first_public_at='2026-10-03')])
        run=Path(self.conf['runs_dir'])/str(c.today());run.mkdir()
        c.output_csv(run/'screen.csv',[dict(domain='tally.so',submit_url='https://tally.so/r/abc',status='可投')])
        c.atomic_json(run/'snap-x.example.json',{'url':'https://tally.so/r/abc','fields':[{'label':'Product name','inputType':'text'}]})
        c.atomic_json(run/'plan-x.example-probekits.json',{'status':'ready','items':[dict(key='name',label='Product name',value='ProbeKits',action='ref_fill')]})
        c.atomic_json(Path(self.conf['raw_sources_dir'])/'x.example.json',{'requested_url':'https://x.example','text':'No backlink required; Free submission'})
        record=h.save_progress(self.conf['handoff_dir'],'x.example','probekits','https://tally.so/r/abc',{'items':[]},extra=[dict(label='Topics',value='Computing')],blocker='captcha')
        before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        code,out=self.cli('source','import','--dry-run');report=json.loads(out)
        self.assertEqual(code,0);self.assertEqual(report['total'],1)
        self.assertEqual(report['with_recipe'],1);self.assertEqual(report['with_history'],1)
        self.assertFalse(self.store.root.exists())
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.assertEqual(self.cli('source','import','--apply')[0],0)
        first=self.store.load('x.example')
        self.assertEqual(first['admission']['value'],'不做');self.assertIn('tally.so',first['form_hosts'])
        self.assertEqual(first['memories']['probekits']['labels']['Topics'],'category')
        self.assertEqual(self.cli('source','import','--apply')[0],0)
        self.assertEqual(self.store.load('x.example'),first)
        self.assertEqual(self.cli('source','list','--status','不做','--fit','probekits')[0],0)
        self.assertEqual(json.loads(self.cli('source','list','--not-submitted','probekits')[1]),[])

    def test_campaign_filters_and_missing_stale_recipes(self):
        good=self.source();missing=self.source('missing.example');missing['recipe']=None
        old=self.source('old.example');old['recipe']['checked_at']=str(c.today()-timedelta(days=15))
        unrelated=self.source('unrelated.example');unrelated['basic']['fit_sites']['value']='RaumLens'
        low=self.source('low.example');low['basic']['dr']['value']='9'
        dated=self.source('dated.example');dated['basic']['dr_date']['value']='2020-01-01'
        history=self.source('history.example');history['history']=[dict(site='ProbeKits',status='unknown')]
        ledger=self.source('ledger.example')
        result=s.campaign([good,good,missing,old,unrelated,low,dated,history,ledger],
                          [dict(source_domain='ledger.example',site='probekits',status='pending')],'probekits',kit())
        self.assertEqual({x['source_domain'] for x in result['ready']},{'x.example'})
        self.assertEqual({x['source_domain'] for x in result['capture']},{'missing.example','old.example'})
        self.assertEqual(len(result['excluded']),5)

    def test_campaign_direct_handoff_and_dry_run_no_write(self):
        self.source()
        self.store.update('x.example','capture',{'fields':[dict(label='Product name',inputType='text'),dict(label='CAPTCHA',inputType='text')]},s.evidence('capture'))
        self.store.update('x.example','capture',{'fields':[dict(label='Product name',inputType='text'),dict(label='CAPTCHA',inputType='text')]},s.evidence('fresh-capture'))
        # 使用临时有效图片，避免依赖真实素材是否存在。
        k=kit();k['images']=[]
        with patch.object(bk,'check_kit',return_value=[]):
            before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
            code,out=self.cli('campaign','--site','probekits','--dry-run')
            self.assertEqual(code,0);self.assertEqual(json.loads(out)['handoff'],1)
            self.assertEqual(before,{str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
            self.assertEqual(self.cli('campaign','--site','probekits')[0],0)
            records=h.Store(self.conf['handoff_dir']).rows()
            self.assertEqual(len(records),1);self.assertEqual(records[0]['blocker'],'captcha')
            self.assertEqual(self.cli('campaign','--site','probekits')[0],0)
            self.assertEqual(len(h.Store(self.conf['handoff_dir']).rows()),1)
        self.assertTrue((Path(self.conf['runs_dir'])/str(c.today())/'campaign-probekits.csv').exists())

    def test_fillplan_set_and_handoff_save_writeback(self):
        snap=self.root/'snap.json';c.atomic_json(snap,{'url':'https://x.example/submit','fields':[dict(label='Topics',inputType='text')]})
        self.assertEqual(self.cli('fillplan','--snapshot',str(snap),'--site','probekits','--set','Topics=Computing','--output',str(self.root/'plan.json'))[0],0)
        memory=self.store.load('x.example')['memories']['probekits']['fields']
        self.assertEqual(memory[0]['value'],'Computing');self.assertEqual(memory[0]['by'],'manual')
        self.assertEqual(self.cli('handoff','save','--plan',str(self.root/'plan.json'),'--source-domain','x.example','--site','probekits','--url','https://x.example/submit','--blocker','captcha','--set','Categories=Hardware')[0],0)
        self.assertEqual(self.store.load('x.example')['memories']['probekits']['labels']['Categories'],'category')

    def test_capture_cli_root_source_and_writeback_with_fake_browser(self):
        class CaptureBrowser:
            instance=None
            def __init__(self,*args):self.args=args;self.closed=False;type(self).instance=self
            def open(self,url):self.url=url
            def capture(self,root):
                self.root=root
                return {'fields':[dict(label='Product name',inputType='text')]}
            def close(self):self.closed=True
        with patch.object(b,'BrowserCLI',CaptureBrowser):
            code,out=self.cli('capture','https://tally.so/r/abc','--source-domain','x.example','--root','main','--output',str(self.root/'snapshot.json'))
        self.assertEqual(code,0);self.assertEqual(CaptureBrowser.instance.root,'main');self.assertTrue(CaptureBrowser.instance.closed)
        record=self.store.load('x.example')
        self.assertIn('tally.so',record['form_hosts']);self.assertTrue(record['recipe'])

    def test_site_mapping_overrides_global_when_executing(self):
        browser=FakeBrowser()
        plan={'items':[dict(key='url',label='Product name',action='ref_fill',value='https://probekits.com/')]}
        result=b.execute_plan(plan,browser.run,browser.capture)
        self.assertEqual(result['status'],'filled')

    def test_multistep_campaign_stops_at_first_blocker(self):
        self.source()
        steps=[dict(fields=[dict(label='Product name',inputType='text')],next=dict(role='button',label='Next')),
               dict(fields=[dict(label='Website URL',inputType='text'),dict(label='CAPTCHA',inputType='text')])]
        for _ in range(2):self.store.update('x.example','capture',{'steps':steps},s.evidence('steps'))
        with patch.object(bk,'check_kit',return_value=[]):
            self.assertEqual(self.cli('campaign','--site','probekits')[0],0)
        row=h.Store(self.conf['handoff_dir']).rows()[0]
        self.assertEqual(row['step'],1);self.assertEqual(row['steps'][0]['next']['label'],'Next')
        self.assertEqual(row['fields'][0]['key'],'url')

    def test_verify_apply_only_submitted_and_history_writeback(self):
        fields=['record_id','source_domain','source_url','site','target_url','status','submitted_at','next_check_at','first_public_at','last_checked_at','notes','raw_href','rel']
        submitted=dict(record_id='submitted',source_domain='x.example',source_url='https://x.example/public',site='probekits',target_url='https://probekits.com',status='submitted',submitted_at='2020-01-01',next_check_at='2020-01-02')
        rows=[submitted,dict(submitted,record_id='draft',status='drafted'),dict(submitted,record_id='unknown',status='unknown',submitted_at='UNKNOWN')]
        c.write_csv(self.conf['ledger'],fields,rows)
        response=dict(status='ok',url='https://x.example/public',html='<p>A publicly readable listing with full product information</p><a href="https://probekits.com">ProbeKits</a>')
        with patch.object(bk,'fetch',return_value=response) as fetch:
            code,out=self.cli('verify','--apply')
        self.assertEqual(code,0);self.assertEqual(fetch.call_count,1)
        self.assertEqual(self.store.load('x.example')['history'][0]['status'],'public')
        self.assertEqual(c.read_csv(self.conf['ledger'])[1][1]['status'],'drafted')

    def test_new_kit_registration_template_fails_check(self):
        self.assertEqual(self.cli('kits','new','newsite')[0],0)
        config=json.loads(self.config.read_text())
        self.assertIn('newsite',config['sites'])
        from backlink_kit import kits as kits_module
        path=Path(self.conf['kits_dir'])/'newsite'/'kit.json'
        self.assertTrue(path.exists())
        loaded,directory=kits_module.load(self.conf,'newsite')
        errors,warnings=kits_module.check(loaded,directory,kits_module.profile(self.conf))
        self.assertTrue(errors)
        self.assertEqual(self.cli('kits','new','newsite')[0],2)

    def test_handoff_grouping_done_readback_and_next_same_site(self):
        store=h.Store(self.conf['handoff_dir'],self.conf)
        plan={'items':[dict(key='name',label='Product name',action='ref_fill',value='ProbeKits')]}
        current=h.save_progress(store.root,'x.example','probekits','https://x.example',plan)
        current.update(status='待人工',browser_task='task',browser_tab=1);store.save(current)
        other=h.save_progress(store.root,'other.example','raumlens','https://other.example',plan)
        nxt=h.save_progress(store.root,'next.example','probekits','https://next.example',plan)
        next_id=h.next_item(store,'probekits')['id']
        self.assertEqual(next_id,nxt['id'])
        class Readback(FakeBrowser):
            def capture(self):return {'fields':[dict(label='Topics',role='textbox',value='Computing'),dict(label='Password',inputType='password',value='SECRET')]}
            def open(self,url):raise AssertionError('完成时不得打开页面')
        original=h.collect_completed_values
        with patch.object(h,'collect_completed_values',side_effect=lambda r,conf:original(r,conf,Readback)):
            result=h.complete_next(store,current['id'],self.conf,FakeBrowser)
        self.assertEqual(result['completed']['status'],'待核实');self.assertEqual(result['next']['id'],nxt['id'])
        memory=self.store.load('x.example')['memories']['probekits']['fields']
        self.assertEqual(memory[0]['value'],'Computing');self.assertNotIn('SECRET',json.dumps(memory))
        self.assertEqual(self.store.load('x.example')['history'][0]['status'],'待核实')
        page=h.render(store.rows(),'/test/')
        self.assertIn('<h2>probekits</h2>',page);self.assertIn('<h2>raumlens</h2>',page)
        self.assertNotIn('x.example</td>',page);self.assertIn('x.example</td>',h.render(store.rows(),'/test/',True))
        self.assertIn('已复原',page);self.assertIn('处理完了，下一个',page)
        self.assertEqual(store.load(other['id'])['status'],'待处理')

    def test_done_readback_failure_does_not_block(self):
        store=h.Store(self.conf['handoff_dir'],self.conf)
        r=h.save_progress(store.root,'x.example','probekits','https://x.example',{'items':[]})
        r.update(status='待人工',browser_task='task',browser_tab=1);store.save(r)
        with patch.object(b.BrowserCLI,'capture',side_effect=ValueError('page gone')):
            result=store.transition(r['id'],'done',self.conf['runs_dir'])
        self.assertEqual(result['status'],'待核实')



class BoundaryTests(unittest.TestCase):
    def test_verify_unknown_without_submission_not_due(self):
        for status in ('candidate','drafted','approved','blocked','unknown'):
            self.assertFalse(c.due(dict(status=status,next_check_at='2020-01-01',submitted_at='UNKNOWN')))
        self.assertTrue(c.due(dict(status='unknown',submitted_at='2020-01-01',next_check_at='2020-01-02')))

    def test_edge_instance_selection(self):
        edges=[dict(browser='edge',connected=True,instanceId='old',lastActiveAt='2026-10-01'),
               dict(browser='edge',connected=True,instanceId='new',lastActiveAt='2026-10-16')]
        self.assertEqual(b.select_edge(edges)['instanceId'],'new')
        edges[0]['primary']=True
        self.assertEqual(b.select_edge(edges)['instanceId'],'old')
        self.assertEqual(b.select_edge(edges,'new')['instanceId'],'new')
        with self.assertRaises(ValueError):b.select_edge(edges,'missing')
        with self.assertRaises(ValueError):b.select_edge([])
        edges[0].pop('primary');edges[0]['lastActiveAt']=9;edges[1]['lastActiveAt']=10
        self.assertEqual(b.select_edge(edges)['instanceId'],'new')

    def test_root_scope_all_reads(self):
        calls=[]
        def api(action,params):
            calls.append((action,params))
            if action=='js.evaluate':return {'value':[]}
            return dict(binding={'documentId':'x'},snapshotId='1',items=[])
        b.collect_snapshot(api,'main form')
        for action,params in calls:
            if action=='semantic_snapshot':self.assertEqual(params['options']['root'],'main form')
            else:self.assertIn('document.querySelector("main form").querySelectorAll',params['expression'])

    def test_source_domain_and_hard_gates(self):
        body='<p>Free submission. No backlink required. Hardware directory.</p><input aria-label="Product name">'
        row=c.screen(body,'https://tally.so/r/x',dict(domain='source.example',dr=30,dr_date=str(c.today())))
        self.assertEqual(row['domain'],'source.example');self.assertEqual(row['form_host'],'tally.so')
        for extra in ['Using automated tools to scrape or harvest data from our website','Free launches require displaying our badge on your website','Featured Listings start at just $29']:
            self.assertEqual(c.screen(body+extra,'https://x.example',dict(dr=30,dr_date=str(c.today())))['status'],'不做')

    def test_empty_disabled_plan_never_ready(self):
        for snap in ({'items':[]},{'fields':[dict(label='charsLeft',inputType='text',disabled=True)]}):
            self.assertEqual(c.fillplan(snap,kit())['status'],'user_input_required')


if __name__=='__main__':unittest.main()
