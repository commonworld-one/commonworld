"""Compact files of the MCP server (scale review 2026-10-25): atlas_search_platforms and atlas_first_tasks read
/api/v1/atlas/mcp-index.json and /api/v1/atlas/first-tasks.json instead of the full platforms.json. Rows, sharding with a
tiny budget, the check.py loader, and the constants shared with platform/src/mcp/atlas.ts."""
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'atlas', 'site'))
import build  # noqa: E402
import check  # noqa: E402

ATLAS_TS = open(os.path.join(ROOT, 'platform', 'src', 'mcp', 'atlas.ts'), encoding='utf-8').read()


def rec(i, name, task=False):
    return {'id': f'p{i}', 'name': name, 'url': f'https://commonworld.one/atlas/platforms/p{i}/', 'json_url': 'j', 'website': 'https://x.example',
            'category': 'social', 'category_label': 'Social', 'type': 'platform', 'status': 'live', 'summary': 'x' * 300 + str(i), 'tags': ['mcp'],
            'has_money_flow': bool(i % 2), 'money_flow': [], 'key_number': None, 'verified_at': '2026-10-25T00:00:00Z', 'claims_count': 1,
            'disclosure': None, 'md_url': 'm', 'evidence_level': {'level': 1}, 'keys_and_books': {}, 'preview': None,
            'first_task': {'title': f'T{i}', 'steps': []} if task else None}


class Constants(unittest.TestCase):
    def test_limits_match_the_server(self):
        m = re.search(r'export const MAX_ATLAS_BYTES = ([0-9_]+);', ATLAS_TS)
        self.assertIsNotNone(m)
        self.assertEqual(int(m.group(1).replace('_', '')), build.MCP_MAX_BYTES)
        self.assertEqual(check.MCP_MAX_BYTES, build.MCP_MAX_BYTES)
        self.assertEqual((check.MCP_GZ_BUDGET, check.MCP_RAW_BUDGET), (build.MCP_GZ_BUDGET, build.MCP_RAW_BUDGET))
        self.assertLess(build.MCP_RAW_BUDGET, build.MCP_MAX_BYTES)

    def test_row_fields_are_slimrow_fields(self):
        m = re.search(r'const ROW_FIELDS = \[([^\]]*)\] as const;', ATLAS_TS)
        self.assertEqual(re.findall(r"'([a-z_]+)'", m.group(1)), build.MCP_ROW_FIELDS)

    def test_formats_match_the_server(self):
        self.assertIn(f"'{build.MCP_INDEX_FORMAT}'", ATLAS_TS)
        self.assertIn(f"'{build.MCP_FIRST_TASKS_FORMAT}'", ATLAS_TS)
        self.assertEqual(set(check.MCP_COMPACT.values()), {build.MCP_INDEX_FORMAT, build.MCP_FIRST_TASKS_FORMAT})


class Rows(unittest.TestCase):
    def test_row_is_slimrow_with_has_first_task(self):
        r = rec(1, 'Alpha', task=True)
        row = build.mcp_row(r)
        self.assertEqual(list(row), build.MCP_ROW_FIELDS + ['has_first_task'])
        self.assertTrue(row['has_first_task'])
        self.assertNotIn('first_task', row)
        del r['website']  # a key the record does not have is left out, as slimRow does
        self.assertNotIn('website', build.mcp_row(r))
        self.assertFalse(build.mcp_row(rec(2, 'Beta'))['has_first_task'])


class Sharding(unittest.TestCase):
    head = {'snapshot_id': 'feedfacefeedface', 'generated_at': '2026-10-25T00:00:00Z', 'licence': 'CC BY 4.0'}

    def recs(self):
        return [rec(i, n, task=i % 3 == 0) for i, n in enumerate(['Alpha'] * 8 + ['Beta'] * 8 + ['Gamma'] * 8 + ['1st'] * 2)]

    def test_one_file_while_it_fits(self):
        recs = self.recs()
        files = build.mcp_files(recs, [build.az_letter(r['name']) for r in recs], self.head)
        self.assertEqual(sorted(files), [build.MCP_FIRST_TASKS_PATH, build.MCP_INDEX_PATH])
        idx = files[build.MCP_INDEX_PATH]
        self.assertEqual(idx['rows'], [build.mcp_row(r) for r in recs])
        self.assertEqual((idx['total'], idx['snapshot_id'], idx['format']), (len(recs), 'feedfacefeedface', build.MCP_INDEX_FORMAT))
        self.assertEqual([t['id'] for t in files[build.MCP_FIRST_TASKS_PATH]['rows']], [r['id'] for r in recs if r['first_task']])
        self.assertEqual(list(files[build.MCP_FIRST_TASKS_PATH]['rows'][0]), build.MCP_FIRST_TASK_FIELDS)

    def test_tiny_budget_gives_a_manifest_and_letter_shards_in_order(self):
        recs = self.recs()
        letters = [build.az_letter(r['name']) for r in recs]
        files = build.mcp_files(recs, letters, self.head, gz_budget=1, raw_budget=1)
        man = files[build.MCP_INDEX_PATH]
        self.assertNotIn('rows', man)
        self.assertEqual(man['total'], len(recs))
        self.assertEqual([s['first'] for s in man['shards']], ['A', 'B', 'G', '#'])  # one shard per letter, never cut inside one
        joined = []
        for s in man['shards']:
            self.assertRegex(s['path'], r'^/api/v1/atlas/mcp-index/[0-9]+-[a-z0]-[a-z0]\.json$')
            d = files[s['path']]
            self.assertEqual((d['format'], d['snapshot_id'], d['count']), (build.MCP_INDEX_FORMAT + '-shard', 'feedfacefeedface', len(d['rows'])))
            joined += d['rows']
        self.assertEqual(joined, [build.mcp_row(r) for r in recs])
        self.assertTrue(any(p.startswith('/api/v1/atlas/first-tasks/') for p in files))

    def test_raw_budget_alone_also_shards(self):
        recs = self.recs()
        files = build.compact_files(build.MCP_INDEX_PATH, build.MCP_INDEX_FORMAT, self.head, [build.mcp_row(r) for r in recs],
                                    [build.az_letter(r['name']) for r in recs], gz_budget=10 ** 9, raw_budget=4000)
        self.assertIn('shards', files[build.MCP_INDEX_PATH])

    def test_check_loader_joins_shards_and_reports_breakage(self):
        recs = self.recs()
        files = build.mcp_files(recs, [build.az_letter(r['name']) for r in recs], self.head, gz_budget=1, raw_budget=1)
        tmp = tempfile.mkdtemp()
        old = check.DIST
        try:
            for p, d in files.items():
                fp = os.path.join(tmp, p.lstrip('/'))
                os.makedirs(os.path.dirname(fp), exist_ok=True)
                with open(fp, 'w', encoding='utf-8') as fh:
                    fh.write(json.dumps(d, separators=(',', ':')))
            check.DIST = tmp
            doc, used, fails = check.load_compact(build.MCP_INDEX_PATH, build.MCP_INDEX_FORMAT)
            self.assertEqual(fails, [])
            self.assertEqual(doc['rows'], [build.mcp_row(r) for r in recs])
            self.assertEqual(len(used), 1 + len(files[build.MCP_INDEX_PATH]['shards']))
            first = files[build.MCP_INDEX_PATH]['shards'][0]['path']
            bad = dict(files[first], snapshot_id='other')
            with open(os.path.join(tmp, first.lstrip('/')), 'w', encoding='utf-8') as fh:
                fh.write(json.dumps(bad))
            _, _, fails = check.load_compact(build.MCP_INDEX_PATH, build.MCP_INDEX_FORMAT)
            self.assertTrue(any('snapshot_id' in f for f in fails), fails)
            os.remove(os.path.join(tmp, first.lstrip('/')))
            _, _, fails = check.load_compact(build.MCP_INDEX_PATH, build.MCP_INDEX_FORMAT)
            self.assertTrue(any('missing' in f for f in fails), fails)
        finally:
            check.DIST = old
            shutil.rmtree(tmp)


if __name__ == '__main__':
    unittest.main()
