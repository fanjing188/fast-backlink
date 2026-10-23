import copy
from datetime import timedelta
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backlink_kit import core as c
from backlink_kit import handoff as h
from backlink_kit import browser as b
import bk
from tests.support import fixture_config, legacy_kit

FIX=Path(__file__).parent/'fixtures'


def kit():
    return legacy_kit()


def snapshot():
    return json.loads((FIX/'snapshot.json').read_text())


class ScreeningTests(unittest.TestCase):
    def test_all_scenarios_twice(self):
        conclusions={'directory':'可投','launch':'可投','roundup':'可投','resource':'可投','community':'需批准','comment':'需批准','producthunt':'需批准','github':'不做','paid':'不做'}
        for scenario,expected in conclusions.items():
            for i in (1,2):
                with self.subTest(scenario=scenario,i=i):
                    source=(FIX/f'{scenario}-{i}.html').read_text()
                    r=c.screen(source,'https://source.example/submit',{'dr':30,'dr_date':str(c.today())})
                    self.assertEqual(r['scenario'],scenario)
                    self.assertEqual(r['status'],expected)
                    self.assertTrue(r['reasons'] or scenario in ('github','community','producthunt','comment'))
    def test_unknown_never_passes(self):
        for missing in ('dr','dr_date'):
            meta={'dr':'30','dr_date':str(c.today()),missing:'UNKNOWN'}
            self.assertEqual(c.screen((FIX/'directory-1.html').read_text(),'https://x.example',meta)['status'],'待核实')
        self.assertFalse(c.fresh_dr({'dr':'nan','dr_date':str(c.today())}))
        self.assertFalse(c.fresh_dr({'dr':30,'dr_date':str(c.today()-timedelta(days=31))}))
    def test_safety_precedence(self):
        for text,expected in [('CAPTCHA','待饼哥'),('Email verification code','待饼哥'),('verify ownership','待饼哥'),('must link back','不做'),('An irrevocable license over all contents','不做')]:
            body=(FIX/'directory-1.html').read_text().replace('No backlink required.','')+text
            self.assertEqual(c.screen(body,'https://x.example')['status'],expected)
    def test_password_snapshot(self):
        r=c.screen(snapshot(),'https://x.example',snapshot=True)
        self.assertEqual(r['status'],'待饼哥')
        self.assertIn('user_input_required: password',r['reasons'])
    def test_fetch_failure_retry_and_403(self):
        with patch.object(c,'urlopen',side_effect=OSError('offline')) as mock:
            self.assertEqual(c.fetch('https://x.example')['status'],'fetch_failed')
            self.assertEqual(mock.call_count,2)
        from urllib.error import HTTPError
        with patch.object(c,'urlopen',side_effect=HTTPError('https://x.example',403,'Forbidden',{},None)) as mock:
            self.assertEqual(c.fetch('https://x.example')['status'],'browser_required')
            self.assertEqual(mock.call_count,1)
            mock.side_effect.close()
    def test_read_page_wrappers(self):
        self.assertEqual(len(c.snapshot_fields({'result':{'snapshot':snapshot()}})),7)


class PlanTests(unittest.TestCase):
    def test_mapping_and_options(self):
        plan=c.fillplan(snapshot(),kit())
        by={r['key']:r for r in plan['items']}
        self.assertEqual(by['name']['value'],'ProbeKits')
        self.assertEqual(by['category']['value'],'Hardware Testing')
        self.assertEqual(by['logo']['action'],'files.upload')
        self.assertEqual(by['password']['action'],'stop')
        self.assertIsNone(by['password']['value'])
        self.assertEqual(by['captcha']['action'],'stop')
        self.assertEqual(by['short_description']['value'],kit()['fields']['short_description']['value'])
    def test_longest_whole_variant(self):
        s={'items':[{'ref':'n','role':'textbox','name':'Description','maxlength':60}]}
        plan=c.fillplan(s,kit())
        self.assertEqual(plan['items'][0]['value'],kit()['fields']['tagline']['value'])
        s['items'][0]['maxlength']=5
        self.assertEqual(c.fillplan(s,kit())['items'][0]['action'],'stop')
    def test_sensitive_types(self):
        for f in [{'name':'Card number'},{'fieldKind':'payment'},{'inputType':'password'},{'fieldKind':'otp'}]:
            self.assertIsNotNone(c.sensitive(f))
    def test_rebind_refs_and_not_old_ref(self):
        p=c.fillplan(snapshot(),kit())
        saved=h.safe_fields(p['items'])
        new=snapshot()
        for item in new['items']:item['ref']='new-'+item['ref']
        result=c.fillplan(new,kit(),saved_fields=saved)
        self.assertEqual(result['items'][0]['ref'],'new-a')
        self.assertEqual(result['items'][0]['value'],'ProbeKits')
    def test_duplicate_semantics_stop(self):
        saved=[{'key':'name','label':'Different','value':'one'},{'key':'name','label':'Another','value':'two'}]
        result=c.fillplan(snapshot(),kit(),saved_fields=saved)
        self.assertEqual(result['items'][0]['action'],'stop')
    def test_kit_validation(self):
        import struct
        with tempfile.TemporaryDirectory() as temp:
            k=kit()
            for i,image in enumerate(k['images']):
                path=Path(temp)/f'{i}.png'
                path.write_bytes(b'\x89PNG\r\n\x1a\n'+b'\x00\x00\x00\x0dIHDR'+struct.pack('>II',image['width'],image['height']))
                image['path']=str(path)
            self.assertEqual(c.check_kit(k),[])
            k['images'][0]['width']=7
            self.assertTrue(c.check_kit(k))


class CSVTests(unittest.TestCase):
    def test_bom_order_notes_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            for name in ('ledger','directories'):
                path=Path(temp)/(name+'.csv')
                fields=['notes','extra','status']
                rows=[{'notes':'已有内容\n第二行','extra':'保留','status':'待核实'}]
                c.write_csv(path,fields,rows)
                self.assertTrue(path.read_bytes().startswith(b'\xef\xbb\xbf'))
                columns,read=c.read_csv(path)
                self.assertEqual(columns,fields);self.assertEqual(read,rows)
                c.append_note(read[0],'新增')
                c.write_csv(path,columns,read,apply=True)
                self.assertEqual(c.read_csv(path)[1][0]['notes'],'已有内容\n第二行；新增')
                self.assertEqual(len(list(Path(temp).glob(name+'.csv.*.bak'))),1)
    def test_real_data_write_guard(self):
        with self.assertRaises(ValueError):
            c.write_csv(c.REAL_DATA/'ledger.csv',[],[])
        with self.assertRaises(ValueError):
            c.write_csv(c.REAL_DATA/'directories.csv',[],[])


class VerifyTests(unittest.TestCase):
    def row(self,**kw):
        return dict(record_id='x',site='probekits',target_url='https://probekits.com/tools',source_url='https://directory.example/tool',source_domain='directory.example',status='submitted',channel_type='directory',submitted_at=str(c.today()-timedelta(days=8)),first_public_at='',raw_href='',notes='',**kw)
    def response(self,body,url='https://directory.example/tool'):
        return dict(status='ok',html='<p>A complete publicly readable directory entry with sufficient content.</p>'+body,url=url)
    def verify(self,row,response):
        return c.verify_row(row,response,{'probekits':{'domain':'probekits.com'}})
    def test_due_intervals(self):
        r=self.row();self.assertTrue(c.due(r))
        r['submitted_at']=str(c.today()-timedelta(days=2));self.assertFalse(c.due(r))
        r['channel_type']='comment';self.assertTrue(c.due(r))
        r['status']='public';r['submitted_at']=str(c.today()-timedelta(days=27));self.assertFalse(c.due(r))
    def test_link_found_and_exact_hostname(self):
        r=self.verify(self.row(),self.response('<a href="https://probekits.com/tools?x=1" rel="ugc nofollow">Probe Kits</a>'))
        self.assertEqual(r['status'],'public');self.assertEqual(r['anchor_text'],'Probe Kits');self.assertEqual(r['rel'],'ugc nofollow')
        self.assertEqual(r['raw_href'],'https://probekits.com/tools?x=1')
        self.assertEqual(r['next_check_at'],str(c.today()+timedelta(days=28)))
        r=self.verify(self.row(),self.response('<a href="https://probekits.com.evil.test">Bad</a>'))
        self.assertEqual(r['status'],'submitted')
    def test_two_readable_absences_only(self):
        row=self.verify(self.row(),self.response('<a href="https://probekits.com">Link</a>'))
        first=self.verify(row,self.response('No link here.'))
        self.assertEqual(first['status'],'public')
        second=self.verify(first,self.response('No link here.'))
        self.assertEqual(second['status'],'removed')
    def test_failure_breaks_absence_streak(self):
        row=self.verify(self.row(),self.response('<a href="https://probekits.com">Link</a>'))
        row=self.verify(row,self.response('No link'))
        row=self.verify(row,{'status':'fetch_failed'})
        self.assertEqual(row['status'],'unknown')
        row=self.verify(row,self.response('No link'))
        self.assertNotEqual(row['status'],'removed')
    def test_rendering_and_redirect_not_absence(self):
        row=self.verify(self.row(),self.response('<a href="https://probekits.com">Link</a>'))
        row=self.verify(row,self.response('Enable JavaScript to view this page'))
        self.assertEqual(row['observation'],'browser_required')
        for i in range(2):row=self.verify(row,self.response('No link','https://directory.example/login'))
        self.assertNotEqual(row['status'],'removed')


class QueueOutreachTests(unittest.TestCase):
    def test_queue_dedup_fit_and_history(self):
        cfg=fixture_config()
        dirs=[dict(domain='directory.example',submit_url='https://directory.example/submit',scenario='directory',status='可投',fit_sites='ProbeKits|RaumLens',dr=30,dr_date=str(c.today()))]*2
        ledger=[dict(source_domain='directory.example',site='RAUMLENS',status='unknown')]
        q=c.make_queue(dirs,ledger,cfg,offline=True)
        self.assertEqual(len(q),1);self.assertEqual(q[0]['site'],'probekits')
        ledger.append(dict(source_domain='directory.example',site='ProbeKits',status='blocked',last_checked_at=str(c.today())))
        self.assertEqual(c.make_queue(dirs,ledger,cfg,offline=True),[])
    def test_dr_stop_codes(self):
        class Fake:
            class SafeParser:pass
            def load_key(self):return 'fake'
            def run(self,args,key):
                import sys
                print('code=quota',file=sys.stderr);return 3
        with patch.object(c.importlib.util,'module_from_spec',return_value=Fake()),patch.object(c.importlib.util,'spec_from_file_location') as spec:
            spec.return_value.loader.exec_module=lambda m:None
            with self.assertRaisesRegex(ValueError,'quota'):
                c.enrich_dr([{'domain':'x.example'}],'unused')
    def test_outreach_limits_lifetime_and_placeholder(self):
        queue=[dict(source_domain=f'x{i}.example',site='probekits',scenario='resource',submit_url='https://x.example',dr=30,dr_date=str(c.today())) for i in range(20)]
        ledger=[dict(source_domain='x0.example',channel_type='outreach',submitted_at='2020-01-01',status='submitted')]
        for i in range(8):ledger.append(dict(source_domain=f'old{i}.example',channel_type='outreach',submitted_at=str(c.today()),status='submitted'))
        result=c.outreach_drafts(queue,ledger,{'probekits':kit()},'{product_name} {why_fit}')
        self.assertEqual(len(result),2)
        self.assertNotIn('x0.example',[r['source_domain'] for r in result])
        self.assertIn('{why_fit}',result[0]['body'])
    def test_same_source_multiple_sites_one_draft(self):
        queue=[dict(source_domain='x.example',site='probekits',scenario='resource',dr=30,dr_date=str(c.today()))]*2
        self.assertEqual(len(c.outreach_drafts(queue,[],{'probekits':kit()},'{why_fit}')),1)
    def test_daily_limit_exhausted(self):
        ledger=[dict(source_domain=f'x{i}.example',channel_type='outreach',submitted_at=str(c.today()),status='submitted') for i in range(10)]
        self.assertEqual(c.outreach_drafts([dict(source_domain='new.example',site='probekits',scenario='resource')],ledger,{'probekits':kit()},''),[])


class FakeBrowser:
    instance=None
    def __init__(self,*args):
        type(self).instance=self
        self.step=0;self.values={};self.calls=[];self.closed=None
    def open(self,url):self.calls.append(('open',url))
    def capture(self):
        label='Product name' if self.step==0 else 'Website URL'
        key='name' if self.step==0 else 'url'
        item=dict(ref=f'new-{len(self.calls)}',name=label,label=label,role='textbox',value=self.values.get(key,''))
        return dict(binding={'taskId':'f'},snapshotId=str(len(self.calls)),fields=[item],items=[item,{'ref':'next','role':'button','name':'Next'}])
    def run(self,action,params):
        self.calls.append((action,params))
        if action=='ref_click':self.step+=1
        if action=='ref_fill':self.values['name' if self.step==0 else 'url']=params['text']
        return {'ok':True}
    def close(self,keep=False):self.closed=keep


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.store=h.Store(self.root/'handoff')
        self.conf=fixture_config();self.conf.update(handoff_dir=str(self.store.root),runs_dir=str(self.root/'runs'))
    def save(self,**kwargs):
        return h.save_progress(self.store.root,'directory.example','probekits','https://directory.example/submit',c.fillplan(snapshot(),kit()),**kwargs)
    def test_roundtrip_no_refs_no_sensitive(self):
        r=self.save()
        self.assertEqual(self.store.load(r['id']),r)
        self.assertNotIn('ref',r['fields'][0]);self.assertNotIn('password',json.dumps(r))
    def test_html_escaped_and_buttons(self):
        r=self.save(blocker='<script>bad()</script>')
        html=h.render(self.store.rows(),'/token/')
        self.assertIn('开始',html);self.assertIn('我已完成',html);self.assertIn('跳过',html)
        self.assertNotIn('<script>',html);self.assertIn('&lt;script&gt;',html)
    def test_states_and_done_not_submitted(self):
        r=self.save()
        with self.assertRaises(ValueError):self.store.transition(r['id'],'done',self.conf['runs_dir'])
        r['status']='待人工';self.store.save(r)
        done=self.store.transition(r['id'],'done',self.conf['runs_dir'])
        self.assertEqual(done['status'],'待核实')
        path=Path(self.conf['runs_dir'])/str(c.today())/'handoff-done.csv'
        self.assertEqual(len(c.read_csv(path)[1]),1)
        with self.assertRaises(ValueError):self.store.transition(r['id'],'done',self.conf['runs_dir'])
    def test_skip_reason_required(self):
        r=self.save()
        with self.assertRaises(ValueError):self.store.transition(r['id'],'skip',self.conf['runs_dir'])
        self.assertEqual(self.store.transition(r['id'],'skip',self.conf['runs_dir'],'无需继续')['status'],'已跳过')
    def test_expired_no_browser(self):
        r=self.save();r['created_at']=str(c.today()-timedelta(days=15));self.store.save(r)
        self.assertEqual(self.store.rows()[0]['status'],'需重新备料')
        self.assertEqual(h.resume(self.store,r['id'],self.conf,FakeBrowser)['status'],'需重新备料')
    def test_unknown_cannot_replay(self):
        r=self.save();r['status']='结果未知';self.store.save(r)
        with self.assertRaises(ValueError):h.resume(self.store,r['id'],self.conf,FakeBrowser)
    def test_lock(self):
        r=self.save()
        with self.store.lock(r['id']):
            with self.assertRaises(ValueError):
                with self.store.lock(r['id']):pass
    def test_multistep_resume_rebind_and_readback(self):
        first={'key':'name','label':'Product name','value':'ProbeKits','action':'ref_fill'}
        final={'key':'url','label':'Website URL','value':'https://probekits.com/','action':'ref_fill'}
        r=h.save_progress(self.store.root,'directory.example','probekits','https://directory.example/start',{'items':[final]},steps=[{'fields':[first],'next':{'label':'Next','role':'button'}}],step=1)
        result=h.resume(self.store,r['id'],self.conf,FakeBrowser)
        self.assertEqual(result['status'],'待人工')
        self.assertEqual(FakeBrowser.instance.values,{'name':'ProbeKits','url':'https://probekits.com/'})
        self.assertTrue(FakeBrowser.instance.closed)
        self.assertIn('已填好 2 项',result['message'])
    def test_form_change_low_ratio_no_fill(self):
        r=self.save()
        result=h.resume(self.store,r['id'],self.conf,FakeBrowser)
        # 表单对不上时不放弃：交出页面给人补，并写明哪些没对上。
        self.assertEqual(result['status'],'待人工')
        self.assertIn('没对上',result['message'])
        self.assertTrue(FakeBrowser.instance.closed)
    def test_no_submit_step(self):
        with self.assertRaises(ValueError):self.save(steps=[{'fields':[],'next':{'role':'button','label':'Submit'}}],step=1)


class ExecutionTests(unittest.TestCase):
    def test_fill_safe_fields_before_stopping(self):
        browser=FakeBrowser()
        plan={'items':[{'key':'password','label':'Password','action':'stop','reason':'user_input_required'}, {'key':'name','label':'Product name','action':'ref_fill','value':'ProbeKits'}]}
        result=b.execute_plan(plan,browser.run,browser.capture)
        self.assertEqual(result['status'],'user_input_required');self.assertEqual(result['filled'],1)
    def test_unknown_no_retry(self):
        browser=FakeBrowser();calls=[]
        def api(action,params):calls.append(action);return {'outcomeUnknown':True}
        plan={'items':[{'key':'name','label':'Product name','action':'ref_fill','value':'ProbeKits'}]*2}
        result=b.execute_plan(plan,api,browser.capture)
        self.assertEqual(result['status'],'outcome_unknown');self.assertEqual(calls,['ref_fill'])
    def test_readback_mismatch_stops(self):
        browser=FakeBrowser()
        result=b.execute_plan({'items':[{'key':'name','label':'Product name','action':'ref_fill','value':'ProbeKits'}]},lambda *x:{'ok':True},browser.capture)
        self.assertEqual(result['results'][0]['status'],'failed')



class IntegrationTests(unittest.TestCase):
    def test_snapshot_collection_preserves_constraints_and_no_secret(self):
        def api(action,params):
            if action=='semantic_snapshot':return snapshot()
            return {'value':[{'label':'Product name','maxlength':30,'selector':'#n','inputType':'text','value':'Before'}]}
        collected=b.collect_snapshot(api)
        self.assertEqual(collected['fields'][0]['maxlength'],30)
        self.assertEqual(collected['fields'][0]['value'],'Before')
    def test_cli_screen_apply_only_copy_and_notes(self):
        from contextlib import redirect_stdout
        import io
        with tempfile.TemporaryDirectory() as temp:
            tmp=Path(temp);cfg=fixture_config();cfg.update(directories=str(tmp/'directories.csv'),runs_dir=str(tmp/'runs'),sources_dir=str(tmp/'sources'))
            fields=['domain','submit_url','status','notes','dr','dr_date','fit_sites','fields']
            c.write_csv(cfg['directories'],fields,[dict(domain='fixture.example',submit_url='https://fixture.example/submit',status='待核实',notes='原注记',dr='20',dr_date=str(c.today()),fit_sites='ProbeKits',fields='')])
            c.atomic_json(tmp/'config.json',cfg)
            response={'status':'ok','html':(FIX/'directory-2.html').read_text(),'url':'https://fixture.example/submit'}
            with patch.object(bk,'fetch',return_value=response),redirect_stdout(io.StringIO()):
                self.assertEqual(bk.main(['--config',str(tmp/'config.json'),'screen','--apply']),0)
            columns,rows=c.read_csv(cfg['directories'])
            self.assertEqual(columns,fields);self.assertTrue(rows[0]['notes'].startswith('原注记；'))
            self.assertEqual(rows[0]['status'],'可投')
            self.assertTrue(list(tmp.glob('directories.csv.*.bak')))
    def test_password_page_blocker_without_editable_field(self):
        s={'text':'Please complete CAPTCHA before submitting','items':[{'ref':'n','name':'Product name','role':'textbox'}]}
        plan=c.fillplan(s,kit())
        self.assertEqual(plan['status'],'user_input_required')
        self.assertIn('captcha',[r['key'] for r in plan['items']])
    def test_handoff_label_changed_same_semantics(self):
        saved=[{'key':'name','label':'Tool name','value':'ProbeKits'}]
        s={'items':[{'ref':'changed','role':'textbox','name':'Product name'}]}
        p=c.fillplan(s,kit(),saved_fields=saved)
        self.assertEqual(p['items'][0]['value'],'ProbeKits')
        self.assertEqual(p['items'][0]['ref'],'changed')
    def test_outreach_unknown_dr_no_draft(self):
        rows=[dict(source_domain='x.example',site='probekits',scenario='resource',dr='UNKNOWN',dr_date='UNKNOWN')]
        self.assertEqual(c.outreach_drafts(rows,[],{'probekits':kit()},'body'),[])
    def test_login_page_does_not_remove_link(self):
        v=VerifyTests()
        row=v.verify(v.row(),v.response('<a href="https://probekits.com">Link</a>'))
        for _ in range(2):row=v.verify(row,v.response('Sign in to see the directory and product information.'))
        self.assertNotEqual(row['status'],'removed')
        self.assertEqual(row['observation'],'browser_required')
    def test_contact_draft_placeholders_stop(self):
        k=kit();k['fields']['message']={'value':'Here is our suggestion. {why_fit}'}
        plan=c.fillplan({'items':[{'ref':'m','role':'textbox','name':'Message'}]},k)
        self.assertEqual(plan['items'][0]['action'],'stop')
    def test_formjs_masks_credentials(self):
        self.assertIn('blocked?{}:',b.FORM_JS)
        self.assertIn('one-time',b.FORM_JS)
    def test_server_token_host_origin_checks_without_listener(self):
        class FakeServer:
            def __init__(self,address,handler):
                self.address=address;self.handler=handler;self.server_port=12345
        with tempfile.TemporaryDirectory() as temp:
            conf={'handoff_dir':temp,'runs_dir':temp}
            with patch.object(h,'ThreadingHTTPServer',FakeServer):
                server,url=h.make_server(conf)
            self.assertEqual(server.address,('127.0.0.1',0))
            handler=object.__new__(server.handler)
            handler.server=server;handler.path='/'+url.split('/')[-2]+'/'
            handler.headers={'Host':'127.0.0.1:12345','Origin':'http://127.0.0.1:12345'}
            self.assertTrue(handler.allowed())
            handler.headers['Origin']='https://evil.example'
            self.assertFalse(handler.allowed())
            handler.headers.pop('Origin');handler.headers['Host']='evil.example'
            self.assertFalse(handler.allowed())
    def test_site_fill_unknown_progress_never_replayed(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(b,'collect_snapshot',return_value=snapshot()),patch.object(b,'execute_plan',return_value={'status':'outcome_unknown','results':[],'filled':0}):
                result=b.site_fill({'scenario':'directory','plan_json':json.dumps(c.fillplan(snapshot(),kit())),'handoff_dir':temp,'source_domain':'x.example','site':'probekits','submit_url':'https://x.example'}, {})
            record=h.Store(temp).load(result['handoff_id'])
            self.assertEqual(record['status'],'结果未知')


class AdditionalBoundaryTests(unittest.TestCase):
    def test_runtime_error_still_saves_unknown_result(self):
        browser=FakeBrowser()
        def api(*args):raise RuntimeError('not safe to replay')
        plan={'items':[{'key':'name','label':'Product name','action':'ref_fill','value':'ProbeKits'}]}
        result=b.execute_plan(plan,api,browser.capture)
        self.assertEqual(result['status'],'outcome_unknown')
    def test_snapshot_pages_merge_and_iframe_note(self):
        base=snapshot();first=dict(base,items=base['items'][:1],nextCursor='c1',coverage={'skippedFrames':1})
        rest=dict(base,items=base['items'][1:],nextCursor=None)
        def api(action,params):
            if action=='js.evaluate':return {'value':[]}
            return rest if params['options'].get('cursor') else first
        snap=b.collect_snapshot(api)
        self.assertEqual(len(snap['items']),len(base['items']));self.assertIn('iframe',snap['coverage_note'])
    def test_snapshot_page_change_stops(self):
        base=snapshot()
        def api(action,params):
            if action=='js.evaluate':return {'value':[]}
            return dict(base,binding={'documentId':'other'}) if params['options'].get('cursor') else dict(base,nextCursor='c1')
        with self.assertRaisesRegex(ValueError,'snapshot_incomplete'):b.collect_snapshot(api)
    def test_no_secret_stop_fields_saved(self):
        with tempfile.TemporaryDirectory() as temp:
            record=h.save_progress(Path(temp),'x.example','probekits','https://x.example',{'items':[{'key':'password','label':'Password','value':'SHOULD_NEVER_APPEAR','action':'ref_fill'},{'key':'email','label':'Email','value':'team@example.com','action':'ref_fill'}]})
            self.assertNotIn('SHOULD_NEVER_APPEAR',json.dumps(record))
    def test_approval_scenario_rejected_by_fill_tool(self):
        for scenario in ('community','comment','producthunt','github','paid'):
            with self.assertRaises(ValueError):b.site_fill({'scenario':scenario},{})


class AuthorizationTests(unittest.TestCase):
    def test_authorization_uses_same_task_on_second_start(self):
        class PendingBrowser(FakeBrowser):
            approved=False
            def open(self,url):
                self.task=getattr(self,'task',None) or 'existing-task'
                if not self.approved:raise b.BrowserAuthorizationRequired('请批准已有任务')
                super().open(url)
        with tempfile.TemporaryDirectory() as temp:
            store=h.Store(Path(temp)/'handoff');conf=fixture_config();conf['runs_dir']=str(Path(temp)/'runs')
            plan={'items':[{'key':'name','label':'Product name','value':'ProbeKits','action':'ref_fill'}]}
            r=h.save_progress(store.root,'x.example','probekits','https://x.example',plan)
            pending=h.resume(store,r['id'],conf,PendingBrowser)
            self.assertEqual(pending['status'],'待授权');self.assertEqual(pending['browser_task'],'existing-task')
            PendingBrowser.approved=True
            done=h.resume(store,r['id'],conf,PendingBrowser)
            self.assertEqual(done['status'],'待人工');self.assertEqual(done['browser_task'],'existing-task')

class OutreachHistoryTests(unittest.TestCase):
    def test_roundup_history_blocks_second_email(self):
        rows=[dict(source_domain='x.example',site='probekits',scenario='resource',dr=30,dr_date=str(c.today()))]
        ledger=[dict(source_domain='x.example',channel_type='roundup',status='submitted',submitted_at='2026-09-01')]
        self.assertEqual(c.outreach_drafts(rows,ledger,{'probekits':kit()},'{why_fit}'),[])
    def test_unknown_send_date_stops_daily_budget(self):
        with self.assertRaisesRegex(ValueError,'发送日期未知'):
            c.outreach_drafts([],[dict(source_domain='x.example',channel_type='outreach',status='unknown',submitted_at='UNKNOWN')],{},'')

if __name__=='__main__':unittest.main()
