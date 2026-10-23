"""导入必须保留新证据和来源归属，不能把计划升级为人工填写。"""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import unittest
from tests import test_sources as fixtures
from backlink_kit import core as c, sources as s, handoff


class ImportPreservationTests(unittest.TestCase):
    conf: dict
    store: s.SourceStore
    setUp = fixtures.LibraryTests.setUp
    source = fixtures.LibraryTests.source

    def test_empty_import_claim_preserves_existing_tool_decision(self):
        self.store.update('x.example', 'screen', {'status': '可投'}, s.evidence('tool'))
        self.store.import_records({'x.example': s.new_source('x.example')})
        self.assertEqual(self.store.load('x.example')['admission']['value'], '可投')

    def test_old_same_recipe_does_not_regress_confirmation_or_discard_evidence(self):
        current = self.source()
        old = deepcopy(current)
        old['recipe']['checked_at'] = '2020-01-01'
        old['recipe']['evidence'] = [s.evidence('old', checked_at='2020-01-01')]
        self.store.import_records({'x.example': old})
        saved = self.store.load('x.example')['recipe']
        self.assertEqual(saved['checked_at'], current['recipe']['checked_at'])
        self.assertEqual({x['path'] for x in saved['evidence']}, {'old', 'capture'})

    def test_old_different_recipe_is_history_not_current(self):
        current = self.source()
        old = deepcopy(current)
        old['recipe'].update(fingerprint='old', checked_at='2020-01-01')
        self.store.import_records({'x.example': old})
        saved = self.store.load('x.example')
        self.assertEqual(saved['recipe']['fingerprint'], current['recipe']['fingerprint'])
        self.assertIn('old', {x['fingerprint'] for x in saved['recipe_versions']})

    def test_unexecuted_handoff_values_keep_plan_provenance(self):
        handoff.save_progress(self.conf['handoff_dir'], 'x.example', 'probekits', 'https://x.example/submit',
                              {'items': [{'label': 'Product name', 'key': 'name', 'value': 'Planned name'}]})
        records, _ = s.import_library(self.conf)
        self.assertEqual(records['x.example']['memories']['probekits']['fields'][0]['by'], 'plan')

    def test_same_basename_in_two_directories_never_crosses_sources(self):
        for prefix, domain, label in [('a', 'x.example', 'Product name'), ('b', 'y.example', 'Website URL')]:
            root = Path(self.conf['runs_dir']) / prefix
            c.atomic_json(root / 'log.json', {'url': 'https://' + domain, 'snapshot': 'snapshot.json'})
            c.atomic_json(root / 'snapshot.json', {'fields': [{'label': label, 'inputType': 'text'}]})
        records, _ = s.import_library(self.conf)
        for domain, label in [('x.example', 'Product name'), ('y.example', 'Website URL')]:
            self.assertEqual(records[domain]['recipe']['steps'][0]['fields'][0]['label'], label)


if __name__ == '__main__':
    unittest.main()
