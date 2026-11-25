"""Current documentation, event coverage and accepted-schema regression checks, offline."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas/site'))
import api_v1
import build
import events
import overviews
from current_catalogue import new_overviews

CAT = ROOT / 'atlas/catalogue'


def resolved_records():
    doc = new_overviews(json.loads((CAT / 'overviews.json').read_text()), CAT)
    closed = set(json.loads((CAT / 'closures.json').read_text())['ids'])
    return [{'id': slug, 'overview': overviews.public(row)} for slug, row in doc['cards'].items() if slug not in closed]


class CurrentDocsContract(unittest.TestCase):
    def test_event_history_prefix_and_revision_coverage(self):
        data = (ROOT / 'atlas/data/events.jsonl').read_bytes()
        prefix = b''.join(data.splitlines(keepends=True)[:148])
        self.assertEqual(hashlib.sha256(prefix).hexdigest(), '41c1fd6c02b148327c8333bdfbe1df0ce13134ec2f22157314b8aea4f686d6e3')
        self.assertEqual(events.current_layer_gaps(CAT, events.load(), resolved_records()), [])

    def test_missing_or_stale_events_fail(self):
        records = resolved_records()
        log = events.load()
        self.assertTrue(events.current_layer_gaps(CAT, [e for e in log if e['slug'] != 'aptets'], records))
        changed = copy.deepcopy(records)
        changed[0]['overview']['revision'] = '0' * 64
        self.assertTrue(events.current_layer_gaps(CAT, log, changed))
        with tempfile.TemporaryDirectory() as td:
            cat = Path(td)
            for name in ('event-coverage.json', 'closures.json', 'additions.json', 'current-revisions.json'):
                (cat / name).write_bytes((CAT / name).read_bytes())
            for name, change in (
                ('closures.json', lambda d: d.update(recorded_on='2026-11-26')),
                ('additions.json', lambda d: d['platforms'][0].update(description_en='Changed source description')),
                ('current-revisions.json', lambda d: d['cards']['meta-muse'].update(text='Changed overview')),
            ):
                original = (cat / name).read_bytes()
                doc = json.loads(original)
                change(doc)
                (cat / name).write_text(json.dumps(doc))
                self.assertTrue(events.current_layer_gaps(cat, log, records), name)
                (cat / name).write_bytes(original)

    def test_release_schema_rejects_bad_packages(self):
        schemas = api_v1.schemas('https://commonworld.one', ['social'])
        schema = schemas['platform.schema.json']
        record = {'id': 'example', 'name': 'Example', 'url': 'https://commonworld.one/atlas/platforms/example/',
                  'json_url': 'https://commonworld.one/atlas/platforms/example.json', 'category': 'social',
                  'category_label': 'Social', 'status': 'live', 'schema_version': api_v1.SCHEMA_VERSION,
                  'licence': 'CC BY 4.0', 'generated_at': '2026-11-25T00:00:00Z',
                  'overview': {'state': 'reviewed', 'text': 'Dated description.', 'visited_at': '2026-11-24T22:00:49Z',
                               'sources': ['https://example.org/'], 'revision': 'a' * 64},
                  'preview': {'path': '/atlas/screens/example.webp', 'url': 'https://commonworld.one/atlas/screens/example.webp',
                              'width': 1200, 'height': 750, 'captured_at': '2026-11-24T22:00:48Z', 'source_url': 'https://example.org/'}}
        from jsonschema import Draft202012Validator, FormatChecker
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        self.assertEqual(list(validator.iter_errors(record)), [])
        for key, value in [('state', 'draft'), ('state', 'held'), ('visited_at', None), ('text', ''), ('text', '   '), ('sources', []), ('sources', ['not-a-url'])]:
            bad = copy.deepcopy(record)
            bad['overview'][key] = value
            self.assertTrue(list(validator.iter_errors(bad)), (key, value))
        for mutate in (lambda d: d.pop('preview'), lambda d: d.update(preview=None), lambda d: d.update(claims=[]),
                       lambda d: d.update(current_limitation={}), lambda d: d.update(first_task={}), lambda d: d.update(summary='old')):
            bad = copy.deepcopy(record)
            mutate(bad)
            self.assertTrue(list(validator.iter_errors(bad)), bad)
            self.assertTrue(api_v1.validate(bad, schema, schemas, 'platform.schema.json'), bad)
        closed = {k: record[k] for k in ('id', 'name', 'url', 'json_url', 'category', 'category_label', 'schema_version', 'licence', 'generated_at')}
        closed.update(status='closed', closed_recorded_at=None, archive={'kind': 'closed_history', 'external_links': 'disabled', 'history': {'claims': [{'historical': True}]}})
        self.assertEqual(list(validator.iter_errors(closed)), [])
        for field in ('archive', 'closed_recorded_at'):
            bad = copy.deepcopy(record)
            bad[field] = copy.deepcopy(closed[field])
            self.assertTrue(list(validator.iter_errors(bad)), field)
            self.assertTrue(api_v1.validate(bad, schema, schemas, 'platform.schema.json'), field)
        for field in ('overview', 'preview', 'earning_opportunity', 'disclosure'):
            bad = copy.deepcopy(closed)
            bad[field] = copy.deepcopy(record.get(field, {}))
            self.assertTrue(list(validator.iter_errors(bad)), field)
            self.assertTrue(api_v1.validate(bad, schema, schemas, 'platform.schema.json'), field)
        closed['website'] = 'https://example.org/'
        self.assertTrue(list(validator.iter_errors(closed)))

    def test_seconds_and_public_prose(self):
        self.assertEqual(build.iso(build.parse_time('2026-11-24T22:00:49Z', preserve_seconds=True)), '2026-11-24T22:00:49Z')
        self.assertEqual(build.iso(build.parse_time('2026-11-24T23:00:49+01:00', preserve_seconds=True)), '2026-11-24T22:00:49Z')
        source = (ROOT / 'platform/src/pages/agent-docs.ts').read_text()
        self.assertIn('retired first-task surface is empty', source)
        self.assertNotIn('categories, first tasks, earn', source)
        self.assertNotIn('Read current_limitation first', (ROOT / 'platform/src/pages/api-page.ts').read_text())


if __name__ == '__main__':
    unittest.main()
