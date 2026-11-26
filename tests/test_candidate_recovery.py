from contextlib import closing
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from frameweave.server import App

WEB = Path(__file__).resolve().parents[1] / "web"


class CandidateRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        t = patch("threading.Thread.start")
        t.start()
        self.addCleanup(t.stop)
        self.app = self.open()

    def open(self):
        app = App(self.root, WEB, backend_url="http://127.0.0.1:1")
        self.addCleanup(app.closed.set)
        return app

    def job(self, ident, status, at, **extra):
        return {"id": ident, "backend": self.app.backend.url, "kind": "sdxl", "status": status,
                "created_at": at, "outputs": [], **extra}

    def test_legacy_rollover_restores_active_unknown_and_cold_registered_output(self):
        output = {"type": "image", "filename": "test.png", "subfolder": "", "storage_type": "output"}
        url = self.app.register_media("test.png")
        old = self.job("old-result", "completed", 1, outputs=[output])
        unknown = self.job("old-unknown", "unknown", 2)
        pending = self.job("old-retry", "completed", 3, retry_attempt={"state":"unknown","key":"retry-key"})
        records = [old, unknown, pending] + [self.job(f"recent-{i}", "completed", i+4) for i in range(200)]
        (self.root/"jobs.json").write_text(json.dumps(records),encoding="utf-8")
        doc = {"schema":"prismcanvas.project.v1","version":1,"name":"画布","packages":[],
               "canvas":{"edges":[],"nodes":[{"id":"n","type":"result","data":{"jobId":"old-result","outputs":[{**output,"url":url}]}}]}}
        can = self.app.canvases.save(doc)["id"]
        foreign = copy.deepcopy(doc)
        foreign["canvas"]["nodes"][0]["data"]["outputs"][0]["url"] = "/api/media/" + "d"*32
        bad = self.app.canvases.save(foreign)["id"]
        for i in range(2):
            app = self.open()
            self.assertEqual({"old-unknown","old-retry"}, {j["id"] for j in app.job_list()["jobs"] if j["id"].startswith("old")})
            app.persist_jobs()
            self.assertNotIn("old-result", app.jobs)
            self.assertNotIn("recovery_warning", app.open_canvas(can))
            self.assertIn("1 个结果", app.open_canvas(bad)["recovery_warning"])
            with app.lock:
                recovered, _ = app._check_media_source_locked("old-result","image",0,None,app.backend,None,None)
            self.assertEqual(recovered["url"],url)
            self.assertIsNone(app.owned_job(None,media="d"*32))

    def test_oversize_jobs_keep_immutable_prior_snapshot_on_failed_replace(self):
        # Force an actual out-of-line snapshot while keeping the test fixture small.
        job = self.job("heavy", "unknown", 1, status_warning="甲"*1800)
        self.app.jobs[job["id"]] = job
        with patch("frameweave.server.MAX_RECORD_BYTES", 700):
            self.app.persist_jobs()
            raw = (self.root/"jobs.json").read_bytes()
            self.assertLess(len(raw),700)
            self.assertIn(b"archived_record", raw)
            self.assertEqual(self.open().jobs["heavy"]["status_warning"], "甲"*1800)
            job["status_warning"] = "乙"*1800
            with patch("frameweave.server.atomic_json",side_effect=OSError("mocked full disk")):
                with self.assertRaises(OSError): self.app.persist_jobs()
            self.assertEqual(self.open().jobs["heavy"]["status_warning"], "甲"*1800)
            self.app.persist_jobs()
            self.assertEqual(self.open().jobs["heavy"]["status_warning"], "乙"*1800)
            with closing(sqlite3.connect(self.app.job_archive.path)) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0],1)
                job["status_warning"] = ""
                self.app.persist_jobs()
                self.assertEqual(db.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0],0)

    def test_damaged_external_snapshot_recovers_healthy_inline_record_and_protects_files(self):
        job = self.job("snapshot", "unknown", 1, status_warning="甲"*600)
        pointer, = self.app.job_archive.snapshot([job])
        healthy = self.job("healthy", "queued", 2)
        path = self.root/"jobs.json"
        path.write_text(json.dumps([pointer, healthy]), encoding="utf-8")
        raw = path.read_bytes()
        db = self.root/"job-archive.sqlite3"
        db.write_bytes(b"truncated snapshot database")
        restored = self.open()
        self.assertIn("healthy", restored.jobs)
        self.assertIn("jobs.json", restored.recovery_protected_files)
        self.assertTrue(restored.recovery_warnings)
        with self.assertRaises(OSError):
            restored.persist_jobs()
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(db.read_bytes(), b"truncated snapshot database")

    def test_refresh_returns_archived_completion_when_poller_wins_either_race(self):
        job = self.job("early-running", "running", 1)
        self.app.jobs[job["id"]] = job
        for i in range(200):
            recent = self.job(f"later-{i}", "completed", i + 2)
            self.app.jobs[recent["id"]] = recent
        history = {job["id"]: {"status": {"completed": True}, "outputs": {
            "12": {"images": [{"filename": "race.png", "type": "output", "subfolder": ""}]}}}}
        queue = {"queue_running": [], "queue_pending": []}
        poller = Mock(url=self.app.backend.url)
        poller.request.return_value = history
        def earlier_poll_finishes(path, **kwargs):
            self.assertEqual(path, "/history/early-running")
            self.assertEqual(self.app.refresh_job(job["id"], adapter=poller, queue=queue)["status"], "completed")
            self.assertNotIn(job["id"], self.app.jobs)
            return {}  # This in-flight reader saw an older history response.
        with patch.object(self.app.backend, "request", side_effect=earlier_poll_finishes):
            result = self.app.refresh_job(job["id"], queue=queue)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["outputs"][0]["filename"], "race.png")
        with patch.object(self.app.backend, "request", side_effect=AssertionError("archived refresh contacted engine")):
            self.assertEqual(self.app.refresh_job(job["id"]), result)
        self.assertNotIn(job["id"], self.app.jobs)
