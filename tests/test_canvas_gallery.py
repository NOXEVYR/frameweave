import tempfile
import unittest
from pathlib import Path

from frameweave.canvas_store import CanvasStore


class CanvasGalleryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = CanvasStore(Path(directory.name))

    def save(self, project=None):
        nodes = [
            {'id':'p','type':'prompt','x':10,'y':20,'data':{'text':'灯塔亮起的海岸'}},
            {'id':'i','type':'reference','x':450,'y':20,
             'data':{'mediaType':'image','url':'/api/assets/media/' + 'e' * 64}},
        ]
        doc = {'schema':'prismcanvas.project.v1','version':1,'name':'同名画布','packages':[],
               'canvas':{'nodes':nodes,'edges':[{'source':'p','target':'i'}]}}
        if project is not None:
            doc['project_id'] = project
        return self.store.save(doc)['id']

    def test_opt_in_preview_reads_actual_graph_and_local_cover(self):
        first = self.save()
        basic, = self.store.list()['canvases']
        self.assertEqual(set(basic), {'id','name','created_at','nodes'})
        visual, = self.store.list(gallery=True)['canvases']
        self.assertEqual(visual['project_id'], first)
        self.assertEqual(visual['preview']['edges'], [['p','i']])
        self.assertEqual(visual['preview']['image'], '/api/assets/media/' + 'e'*64)
        self.assertEqual(visual['preview']['excerpt'], '灯塔亮起的海岸')

    def test_project_links_do_not_depend_on_title(self):
        first = self.save(); other = self.save(); later = self.save(first)
        rows = {r['id']:r['project_id'] for r in self.store.list(gallery=True)['canvases']}
        self.assertEqual(rows,{first:first, other:other, later:first})

    def test_invalid_optional_project_key_stays_independent(self):
        legacy = self.save('unknown')
        row, = self.store.list(gallery=True)['canvases']
        self.assertEqual(row['project_id'], legacy)
