import unittest
from frameweave.editor_backends import inspect_backend_fit


class EditorBackendTests(unittest.TestCase):
    def test_live_schema_and_extensions_include_bypassed_nodes_without_claiming_unknown_installed(self):
        document = {'nodes': [{'type': t, 'mode': 4} for t in ('Note', 'GetNode', 'SetNode', 'Fast Groups Bypasser (rgthree)', 'Sampler', 'Unknown') ]}
        full = inspect_backend_fit(document, {'Sampler': {}}, ['/extensions/kj/setgetnodes.js', '/extensions/rgthree/fast_groups_bypasser.js'])
        limited = inspect_backend_fit(document, {'Sampler': {}}, [])
        self.assertEqual(full['unknown_types'], ['Unknown'])
        self.assertEqual(full['counts']['matched'], 4)
        self.assertEqual(limited['counts']['unresolved'], 4)
        self.assertGreater(full['score'], limited['score'])
        self.assertNotIn('Note', full['matched'])

    def test_invalid_catalog_is_not_considered_ready(self):
        with self.assertRaises(ValueError):
            inspect_backend_fit({'nodes': []}, {}, {'error': 'offline'})


if __name__ == '__main__': unittest.main()
