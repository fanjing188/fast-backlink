"""资产历史的增量回写不能抹掉回执，也不能放行未知/待核实的旧动作。"""
from copy import deepcopy
from pathlib import Path
import json
import tempfile
import unittest
from backlink_kit import core
from backlink_kit import sources as s


class PreservationTests(unittest.TestCase):
    def test_non_snapshot_reports_do_not_abort_importing_submission_history(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            conf = {key: str(root / key) for key in ('sources_dir', 'runs_dir', 'ledger', 'directories', 'handoff_dir')}
            core.write_csv(conf['directories'], ['domain'], [])
            core.write_csv(conf['ledger'], ['record_id', 'source_domain', 'site', 'status'],
                           [dict(record_id='one', source_domain='x.example', site='probekits', status='submitted')])
            Path(conf['runs_dir']).mkdir()
            (Path(conf['runs_dir']) / 'report-x.example.json').write_text(json.dumps({'url': 'https://x.example', 'fields': ['name', 'url']}))
            records, report = s.import_library(conf)
            self.assertEqual(records['x.example']['history'][0]['status'], 'submitted')
            self.assertTrue(report['warnings'])

    def test_sparse_update_preserves_receipt_and_target(self):
        record = s.new_source('x.example')
        s.add_history(record, {'record_id': 'one', 'site': 'probekits', 'status': 'submitted',
            'receipt': 'proof.json', 'target_url': 'https://probekits.com/', 'submitted_at': '2026-10-01',
            'last_checked_at': '2026-10-01'}, s.evidence('old'))
        s.add_history(record, {'record_id': 'one', 'status': 'pending', 'last_checked_at': '2026-10-02'}, s.evidence('new'))
        self.assertEqual(record['history'][0]['receipt'], 'proof.json')
        self.assertEqual(record['history'][0]['site'], 'probekits')
        self.assertEqual(record['history'][0]['target_url'], 'https://probekits.com/')
        self.assertEqual(len(record['history'][0]['evidence']), 2)

    def test_waiting_verification_and_unknown_handoff_are_not_requeued(self):
        for status in ('待核实', '结果未知', '续填中'):
            record = s.new_source('x.example')
            s.add_history(record, {'id': 'a', 'site': 'ProbeKits', 'status': status}, s.evidence('handoff'))
            self.assertTrue(s.submitted(record, 'probekits', []), status)
            self.assertFalse(s.submitted(record, 'newproduct', []), '不能跨产品去重')

    def test_same_receipt_id_cannot_merge_different_products(self):
        record = s.new_source('x.example')
        for site in ('probekits', 'newproduct'):
            s.add_history(record, {'record_id': 'one', 'site': site, 'status': 'submitted'}, s.evidence(site))
        self.assertEqual(len(record['history']), 2)


if __name__ == '__main__':
    unittest.main()
