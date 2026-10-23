"""不监听端口；直接驱动 HTTP Handler 与临时资源库。"""
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backlink_kit import core as c, handoff as h, sources as s
from backlink_kit.extension_api import ExtensionAPI
from tests.test_kit import kit
from tests.support import fixture_config


class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.conf = fixture_config()
        self.conf.update({k: str(self.root/k) for k in ('handoff_dir','runs_dir','sources_dir','kits_dir','ledger')})
        self.conf['learned_file'] = str(self.root/'learned.json')
        Path(self.conf['kits_dir']).mkdir()
        self.image = self.root/'logo.png'; self.image.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
        k = kit(); k['images'] = [dict(key='logo',path=str(self.image))]
        c.atomic_json(Path(self.conf['kits_dir'])/'probekits.json',k)
        self.store = h.Store(self.conf['handoff_dir'],self.conf)
        self.record = h.save_progress(self.store.root,'source.example','probekits','https://source.example/submit',{'items':[]})
        self.api = ExtensionAPI(self.conf,self.store)
        self.payload = dict(id=self.record['id'],steps=[dict(fields=[
            dict(label='Topics',value='Computing',inputType='select-one',options=['Computing','Other']),
            dict(label='Product name',value='Human edit'),
            dict(label='Secret',inputType='password',value='NEVER_SAVE'),
            dict(label='Card number',autocomplete='cc-number',value='NEVER_SAVE'),
            dict(label='Logo',inputType='file',value='/private/secret'),
            dict(label='SMS code',value='NEVER_SAVE')])])

    def test_remember_results_done_history_and_idempotence(self):
        self.api.post('results',dict(id=self.record['id'],results=[dict(label='Product name',status='filled'),dict(label='Password',status='filled')]))
        self.assertEqual(len(self.store.load(self.record['id'])['results']),1)
        self.api.post('remember',self.payload)
        source = self.api.library.load('source.example')
        self.assertEqual(source['memories']['probekits']['fields'][0]['by'],'manual')
        self.assertEqual(source['recipe']['steps'][0]['fields'][0]['options'],['Computing','Other'])
        self.assertFalse(source['recipe']['complete'])
        self.assertNotIn('NEVER_SAVE',json.dumps(source))
        self.assertNotIn('/private/secret',json.dumps(source))
        self.payload['complete'] = True
        self.assertEqual(self.api.post('done',self.payload)['status'],'待核实')
        self.assertTrue(self.api.library.load('source.example')['recipe']['complete'])
        self.api.post('done',self.payload)
        receipts = c.read_csv(Path(self.conf['runs_dir'])/str(c.today())/'handoff-done.csv')[1]
        self.assertEqual(len(receipts),1)
        self.assertEqual(self.api.library.load('source.example')['history'][0]['status'],'待核实')
        self.assertFalse((self.root/'ledger.csv').exists())

    def test_manual_new_source_recipe_and_url_lookup(self):
        payload = {**self.payload,'site':'probekits','url':'https://new.example/form'}; payload.pop('id')
        self.api.post('remember',payload)
        result = self.api.get('source',dict(site='probekits',url=payload['url']))
        self.assertEqual(result['source_domain'],'new.example')
        self.assertTrue(result['recipe'])
        self.assertEqual(result['memory']['fields'][0]['value'],'Computing')
        with self.assertRaises(ValueError): self.api.get('source',dict(site='probekits',url='https://tally.so/r/unknown'))

    def test_files_only_registered_index(self):
        self.assertEqual(self.api.file('probekits','0')[0],self.image.read_bytes())
        for ident in ('../logo.png',str(self.image),'1','-1'):
            with self.assertRaises(ValueError): self.api.file('probekits',ident)

    def test_lock_and_parallel_source_writes(self):
        with self.store.lock(self.record['id']):
            with self.assertRaises(ValueError): self.api.post('remember',self.payload)
        def write(i):
            self.api.post('remember',dict(site='probekits',url='https://parallel.example/form',steps=[{'fields':[{'label':f'Field {i}','value':str(i)}]}]))
        with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(write,range(10)))
        source = self.api.library.load('parallel.example')
        self.assertEqual(len(source['memories']['probekits']['fields']),10)
        self.assertEqual(len(c.read_csv(self.api.library.root/'index.csv')[1]),1)

    def handler(self,path,origin='chrome-extension://'+'a'*32,host='127.0.0.1:18780',data=None):
        class FakeServer:
            def __init__(self,address,handler): self.server_port=18780; self.handler=handler
        with patch.object(h,'ThreadingHTTPServer',FakeServer): server,url = h.make_server(self.conf)
        handler = object.__new__(server.handler); handler.server=server
        handler.path=url.split('18780')[1]+path
        handler.headers={'Host':host,'Origin':origin,'Content-Type':'application/json'}
        raw=json.dumps(data or {}).encode(); handler.headers['Content-Length']=str(len(raw))
        handler.rfile=io.BytesIO(raw); handler.wfile=io.BytesIO(); handler.response_headers={}
        handler.send_response=lambda status: setattr(handler,'status',status)
        handler.send_header=lambda k,v: handler.response_headers.update({k:v})
        handler.end_headers=lambda: None
        return handler

    def test_extension_header_without_origin_and_preflight_boundaries(self):
        for method in ('GET','POST','OPTIONS'):
            for origin in (None,'','null','https://evil.example','http://127.0.0.1:18780','chrome-extension://bad','chrome-extension://'+'a'*32):
                with self.subTest(method=method,origin=origin):
                    handler=self.handler('api/rules' if method=='GET' else 'api/remember',data=self.payload)
                    if origin is None: del handler.headers['Origin']
                    else: handler.headers['Origin']=origin
                    handler.headers['X-Fast-Backlink']='1'
                    getattr(handler,'do_'+method)()
                    extension=origin=='chrome-extension://'+'a'*32
                    allowed=extension or (origin is None and method!='OPTIONS')
                    self.assertEqual(handler.status,(204 if method=='OPTIONS' else 200) if allowed else 403)
                    self.assertEqual('Access-Control-Allow-Origin' in handler.response_headers,extension)
                    if extension and method=='OPTIONS':
                        self.assertIn('X-Fast-Backlink',handler.response_headers['Access-Control-Allow-Headers'])
        for header in (None,'0',''):
            handler=self.handler('api/rules'); del handler.headers['Origin']
            if header is not None: handler.headers['X-Fast-Backlink']=header
            handler.do_GET(); self.assertEqual(handler.status,403)
        for host,path in (('evil.example',None),('127.0.0.1:18780','/bad/api/rules')):
            handler=self.handler('api/rules',host=host); del handler.headers['Origin']
            handler.headers['X-Fast-Backlink']='1'
            if path: handler.path=path
            handler.do_GET(); self.assertEqual(handler.status,403)

    def test_http_auth_cors_json_and_files_without_listener(self):
        for origin in ('https://evil.example','http://127.0.0.1:18780','null','','chrome-extension://bad'):
            handler=self.handler('api/rules',origin=origin); handler.do_GET()
            self.assertEqual(handler.status,403)
            self.assertNotIn('Access-Control-Allow-Origin',handler.response_headers)
        handler=self.handler('api/rules',host='evil.example'); handler.do_GET(); self.assertEqual(handler.status,403)
        handler=self.handler('api/rules'); handler.path='/bad/api/rules'; handler.do_GET(); self.assertEqual(handler.status,403)
        handler=self.handler('api/rules'); handler.do_GET()
        self.assertEqual(json.loads(handler.wfile.getvalue())['labels'],c.rules('labels'))
        self.assertEqual(handler.response_headers['Access-Control-Allow-Origin'],'chrome-extension://'+'a'*32)
        handler=self.handler('api/remember'); handler.do_OPTIONS(); self.assertEqual(handler.status,204)
        handler=self.handler('api/remember',data=self.payload); handler.do_POST(); self.assertEqual(handler.status,200)
        handler=self.handler('api/item?id='+self.record['id']); handler.do_GET(); self.assertEqual(handler.status,200)
        handler=self.handler('api/file?site=probekits&id=0'); handler.do_GET(); self.assertEqual(handler.wfile.getvalue(),self.image.read_bytes())
        handler=self.handler('api/file?site=probekits&id=../../secret'); handler.do_GET(); self.assertEqual(handler.status,409)
        handler=self.handler('api/remember',data=self.payload); handler.headers['Content-Length']='999999'; handler.do_POST(); self.assertEqual(handler.status,409)

    def test_skip_and_terminal_protection(self):
        self.assertEqual(self.api.post('skip',dict(id=self.record['id'],reason='人工跳过'))['status'],'已跳过')
        self.assertEqual(self.api.library.load('source.example')['history'][0]['status'],'已跳过')
        with self.assertRaises(ValueError): self.api.post('results',dict(id=self.record['id'],results=[]))

    def test_agent_bridge_http_auth_and_shape(self):
        # 扩展心跳：status 带 extension Origin 时 connected，CLI 无 Origin 时只看队列。
        handler=self.handler('api/agent/status'); handler.do_GET()
        self.assertEqual(handler.status,200)
        self.assertTrue(json.loads(handler.wfile.getvalue())['connected'])
        handler=self.handler('api/agent/status',origin=None); del handler.headers['Origin']
        handler.headers['X-Fast-Backlink']='1'; handler.do_GET()
        self.assertEqual(handler.status,200)
        self.assertFalse(json.loads(handler.wfile.getvalue())['connected'])
        # CLI 提交命令；扩展取命令必须带扩展 Origin，CLI 不能偷走。
        handler=self.handler('api/agent/command',origin=None,data={'action':'fill','args':{'site':'probekits'},'wait':0})
        del handler.headers['Origin']; handler.headers['X-Fast-Backlink']='1'; handler.do_POST()
        self.assertEqual(handler.status,200)
        self.assertEqual(json.loads(handler.wfile.getvalue())['state'],'pending')
        # 浏览网页（非扩展 Origin）不能取命令；本机令牌 + 专用头可以。
        handler=self.handler('api/agent/next?wait=0',origin='https://evil.example'); handler.do_GET()
        self.assertEqual(handler.status,403)
        handler=self.handler('api/agent/next?wait=0',origin=None); del handler.headers['Origin']
        handler.headers['X-Fast-Backlink']='1'; handler.do_GET()
        self.assertEqual(handler.status,200)
        self.assertEqual(json.loads(handler.wfile.getvalue()),{})
        handler=self.handler('api/agent/next?wait=0'); handler.do_GET()
        self.assertEqual(handler.status,200)
        self.assertEqual(json.loads(handler.wfile.getvalue()),{})
        # 回执同样只认本机令牌/扩展；未知动作由服务端白名单拒绝。
        handler=self.handler('api/agent/result',origin='https://evil.example',data={'id':'x'}); handler.do_POST()
        self.assertEqual(handler.status,403)
        handler=self.handler('api/agent/result',origin=None,data={'id':'x'}); del handler.headers['Origin']
        handler.headers['X-Fast-Backlink']='1'; handler.do_POST()
        self.assertEqual(handler.status,409)
        handler=self.handler('api/agent/command',data={'action':'shell','args':{},'wait':0})
        handler.do_POST(); self.assertEqual(handler.status,409)

    def test_list_links_and_legacy_controls(self):
        page=h.render([self.record],'/token/')
        self.assertIn('https://source.example/submit#bk='+self.record['id'],page)
        self.assertIn('后台填',page)
        self.assertIn('noopener noreferrer',page)

    def test_fragment_and_query_preserved(self):
        url=h.extension_url('https://source.example/form?q=1#/route',self.record['id'])
        self.assertEqual(url,'https://source.example/form?q=1#/route&bk='+self.record['id'])
