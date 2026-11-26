"""Real-file summary reads preserve immutable canvas and external-file semantics."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frameweave import canvas_store
from frameweave.canvas_store import CanvasStore, _CanvasChanged


def document(name="版本", text="kept"):
    return {"schema": "prismcanvas.project.v1", "version": 1, "name": name,
            "canvas": {"nodes": [{"id": "n", "data": {"text": text}}], "edges": []}, "packages": []}


class CanvasSummaryCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "canvases"
        self.store = CanvasStore(self.root)
        self.cache_supported = canvas_store.SUMMARY_CACHE_SUPPORTED
        if os.name == "nt":
            probe = Path(self.temp.name) / "revision-probe"
            probe.write_bytes(b"test")
            with probe.open("rb") as reader:
                self.cache_supported = canvas_store.file_revision(reader.fileno()) is not None

    def save(self, name="版本", text="kept"):
        return self.store.save(document(name, text))

    def path(self, saved):
        return self.root / (saved["id"] + ".json")

    def rewrite(self, saved, mutate):
        path = self.path(saved)
        record = json.loads(path.read_text(encoding="utf-8"))
        mutate(record)
        path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

    def test_warm_pagination_and_search_respect_platform_read_policy(self):
        saved = [self.save(f"版本 {i}", "x" * (1024 * 1024)) for i in range(3)]
        originals = {self.path(row): self.path(row).read_bytes() for row in saved}
        self.assertFalse(self.store._summary_cache, "save publishes no unchecked caller summary")
        with (patch.object(self.store, "get", wraps=self.store.get) as full,
              patch("frameweave.canvas_store.os.fdopen", wraps=os.fdopen) as reader):
            cold = self.store.list(limit=1)
            self.assertEqual(full.call_count, 3)
            self.assertEqual(reader.call_count, 3, "three actual streams read the cold files")
            full.reset_mock(); reader.reset_mock()
            second = self.store.list(offset=1, limit=1)
            query = self.store.list(query="版本 0")
            expected_reads = 0 if self.cache_supported else 6
            self.assertEqual((full.call_count, reader.call_count), (expected_reads, expected_reads))
            if not self.cache_supported:
                self.assertFalse(self.store._summary_cache)
            self.assertEqual((cold["total"], second["total"], query["matched"]), (3, 3, 1))
        self.assertEqual(originals, {path: path.read_bytes() for path in originals})
        # Explicit retrieval is always a fresh full validation, even after a hit.
        with patch.object(self.store, "_validate", wraps=self.store._validate) as validate:
            self.assertEqual(self.store.get(saved[0]["id"])["document"], document("版本 0", "x" * (1024 * 1024)))
            self.assertEqual(validate.call_count, 1)

    def test_metadata_cache_keeps_search_order_counts_and_returned_rows_independent(self):
        rows = [self.save(f"版本 {i:03d}") for i in range(205)]
        self.store.list()
        with patch.object(self.store, "get", wraps=self.store.get) as full:
            first = self.store.list(); second = self.store.list(offset=200)
            searched = self.store.list(query="版本 000")
            self.assertEqual(full.call_count, 0 if self.cache_supported else 615)
        self.assertEqual([row["id"] for row in first["canvases"] + second["canvases"]], [row["id"] for row in reversed(rows)])
        self.assertEqual((first["total"], first["matched"], len(second["canvases"]), searched["matched"]), (205, 205, 5, 1))
        first["canvases"][0]["name"] = "caller mutation"
        self.assertEqual(self.store.list(limit=1)["canvases"][0]["name"], "版本 204")

    def test_500_version_warm_library_respects_platform_read_policy(self):
        for i in range(500): self.save(f"版本 {i:03d}")
        with patch.object(self.store, "get", wraps=self.store.get) as full:
            cold = self.store.list()
            self.assertEqual(full.call_count, 500)
            full.reset_mock()
            self.assertEqual(self.store.list(offset=400)["total"], cold["total"])
            self.assertEqual(self.store.list(query="版本 499")["matched"], 1)
            self.assertEqual(full.call_count, 0 if self.cache_supported else 1000)

    def test_same_inode_size_and_restored_mtime_rewrite_remains_visible(self):
        saved = self.save("Alpha"); path = self.path(saved)
        self.store.list(); previous = path.stat()
        self.rewrite(saved, lambda row: (row.update(name="Bravo"), row["document"].update(name="Bravo"),
                                        row["document"]["canvas"]["nodes"][0]["data"].update(text="edit")))
        os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns))
        changed = path.stat()
        self.assertEqual((changed.st_ino, changed.st_size, changed.st_mtime_ns),
                         (previous.st_ino, previous.st_size, previous.st_mtime_ns))
        if (os.name != "nt" and self.cache_supported
                and changed.st_ctime_ns == previous.st_ctime_ns):
            self.skipTest("filesystem cannot distinguish this rewrite by ctime")
        with patch.object(self.store, "get", wraps=self.store.get) as full:
            self.assertEqual(self.store.list(query="Bravo")["matched"], 1)
            self.assertEqual(full.call_count, 1)
        self.assertEqual(self.store.list(query="Alpha")["matched"], 0)
        self.assertEqual(self.store.get(saved["id"])["document"], document("Bravo", "edit"))
        if not self.cache_supported:
            self.assertFalse(self.store._summary_cache, "unproven ctime semantics must use fresh reads")
            self.assertEqual(self.store._summary_cache_bytes, 0)

    def test_atomic_external_replacement_invalidates_even_with_same_size_and_mtime(self):
        saved = self.save("Alpha"); path = self.path(saved)
        self.store.list(); previous = path.stat()
        record = json.loads(path.read_text(encoding="utf-8")); record["name"] = record["document"]["name"] = "Bravo"
        replacement = self.root / "replacement.tmp"
        replacement.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        os.utime(replacement, ns=(previous.st_atime_ns, previous.st_mtime_ns)); os.replace(replacement, path)
        self.assertEqual(self.store.list(query="Bravo")["matched"], 1)

    def test_deleted_file_is_removed_from_cache_and_repaired_bad_file_is_reread(self):
        saved = self.save(); original = self.path(saved).read_bytes(); self.store.list()
        self.path(saved).write_bytes(b"{")
        self.assertEqual(self.store.list()["unreadable"], 1)
        with patch.object(self.store, "get", wraps=self.store.get) as full:
            self.assertEqual(self.store.list()["unreadable"], 1)
            self.assertEqual(full.call_count, 0 if self.cache_supported else 1,
                             "negative caching requires proven stat semantics; otherwise reread")
        self.path(saved).write_bytes(original)
        self.assertEqual(self.store.list()["total"], 1)
        self.path(saved).unlink()
        self.assertEqual(self.store.list()["unreadable"], 0)
        self.assertNotIn(saved["id"], self.store._summary_cache)
        self.assertEqual(self.store._summary_cache_bytes, 0)

    def test_get_does_not_trust_a_warm_summary_when_full_content_is_corrupted(self):
        saved = self.save(); self.store.list()
        self.rewrite(saved, lambda row: row["document"]["canvas"].update(nodes=["bad"]))
        with self.assertRaisesRegex(ValueError, "损坏"):
            self.store.get(saved["id"])
        self.assertEqual(self.store.list()["unreadable"], 1)

    def test_symlink_replacement_never_reuses_summary_and_target_is_not_opened(self):
        saved = self.save(); path = self.path(saved); original = path.read_bytes(); self.store.list()
        target = Path(self.temp.name) / "private.json"; target.write_bytes(original)
        path.unlink()
        try:
            path.symlink_to(target)
        except OSError as error:
            self.skipTest(str(error))
        with patch("frameweave.canvas_store.os.open", wraps=os.open) as opened:
            self.assertEqual(self.store.list()["unreadable"], 1)
            self.assertEqual(opened.call_count, 0)
        with self.assertRaisesRegex(ValueError, "链接"):
            self.store.get(saved["id"])
        path.unlink(); path.write_bytes(original)
        self.assertEqual(self.store.list()["total"], 1)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "named pipes unavailable")
    def test_nonregular_file_and_fifo_swap_cannot_block_or_reuse_summary(self):
        saved = self.save(); path = self.path(saved); self.store.list()
        path.unlink(); os.mkfifo(path)
        with patch("frameweave.canvas_store.os.open", wraps=os.open) as opened:
            self.assertEqual(self.store.list()["unreadable"], 1)
            self.assertEqual(opened.call_count, 0)

    def test_warm_open_failure_is_not_cached_and_recovers_without_a_stat_change(self):
        saved = self.save(); self.store.list(); identity = self.path(saved).stat()
        with patch("frameweave.canvas_store.os.open", side_effect=PermissionError("temporarily locked")):
            self.assertEqual(self.store.list()["unreadable"], 1)
        self.assertEqual(self.path(saved).stat(), identity)
        self.assertNotIn(saved["id"], self.store._summary_cache)
        self.assertEqual(self.store.list()["total"], 1)

    def test_cold_open_failure_is_not_negative_cached(self):
        saved = self.save()
        with patch("frameweave.canvas_store.os.open", side_effect=PermissionError("temporarily locked")):
            self.assertEqual(self.store.list()["unreadable"], 1)
        self.assertNotIn(saved["id"], self.store._summary_cache)
        self.assertEqual(self.store.list()["total"], 1)

    def test_file_change_after_full_read_never_publishes_stale_summary(self):
        saved = self.save("Alpha"); original = self.store.get

        def changed(ident):
            result = original(ident)
            self.rewrite(saved, lambda row: (row.update(name="Bravo"), row["document"].update(name="Bravo")))
            return result

        with patch.object(self.store, "get", side_effect=changed):
            self.assertEqual(self.store.list()["unreadable"], 1)
        self.assertNotIn(saved["id"], self.store._summary_cache)
        self.assertEqual(self.store.list(query="Bravo")["matched"], 1)

    def test_swap_between_stat_and_open_is_rejected_before_content_read(self):
        saved = self.save(); path = self.path(saved); opened = os.open
        fdopen = os.fdopen; reads = []

        class ReadCounter:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): self.stream.__enter__(); return self
            def __exit__(self, *args): return self.stream.__exit__(*args)
            def fileno(self): return self.stream.fileno()
            def read(self, count): reads.append(count); return self.stream.read(count)

        def replace_before_open(candidate, flags, *args, **kwargs):
            replacement = self.root / "replacement.tmp"
            replacement.write_bytes(path.read_bytes()); os.replace(replacement, path)
            return opened(candidate, flags, *args, **kwargs)

        with (patch("frameweave.canvas_store.os.open", side_effect=replace_before_open),
              patch("frameweave.canvas_store.os.fdopen", side_effect=lambda *args: ReadCounter(fdopen(*args)))):
            self.assertEqual(self.store.list()["unreadable"], 1)
        self.assertEqual(reads, [], "fstat rejects the changed file before any content read")
        self.assertNotIn(saved["id"], self.store._summary_cache)
        self.assertEqual(self.store.list()["total"], 1)

    def test_file_mutation_inside_actual_read_rejects_and_does_not_cache(self):
        saved = self.save("Alpha"); fdopen = os.fdopen; reads = []
        store = self

        class ChangedReader:
            def __init__(self, stream): self.stream = stream
            def __enter__(self): self.stream.__enter__(); return self
            def __exit__(self, *args): return self.stream.__exit__(*args)
            def fileno(self): return self.stream.fileno()
            def read(self, count):
                data = self.stream.read(count); reads.append(len(data))
                store.rewrite(saved, lambda row: (row.update(name="Bravo"), row["document"].update(name="Bravo")))
                return data

        with patch("frameweave.canvas_store.os.fdopen", side_effect=lambda *args: ChangedReader(fdopen(*args))):
            self.assertEqual(self.store.list()["unreadable"], 1)
        self.assertEqual(len(reads), 1)
        self.assertNotIn(saved["id"], self.store._summary_cache)
        self.assertEqual(self.store.list(query="Bravo")["matched"], 1)

    def test_transient_identity_race_never_becomes_stable_negative_cache(self):
        saved = self.save()
        with patch.object(self.store, "get", side_effect=_CanvasChanged("temporary identity mismatch")):
            self.assertEqual(self.store.list()["unreadable"], 1)
        self.assertNotIn(saved["id"], self.store._summary_cache)
        self.assertEqual(self.store.list()["total"], 1)

    def test_unproven_platform_stat_semantics_fall_back_to_full_reads(self):
        self.save(); self.store.list()
        with (patch.object(canvas_store, "SUMMARY_CACHE_SUPPORTED", False),
              patch.object(self.store, "get", wraps=self.store.get) as full):
            self.assertEqual(self.store.list()["total"], 1)
            self.assertEqual(self.store.list()["total"], 1)
            self.assertEqual(full.call_count, 2)
            self.assertFalse(self.store._summary_cache)

    def test_full_read_fallback_observes_same_size_restored_mtime_repairs(self):
        saved = self.save("Alpha"); path = self.path(saved)
        original = path.read_bytes(); previous = path.stat()
        with (patch.object(canvas_store, "SUMMARY_CACHE_SUPPORTED", False),
              patch.object(self.store, "get", wraps=self.store.get) as full):
            self.assertEqual(self.store.list()["total"], 1)
            # Same-size malformed content and its repair cannot become cached
            # failures, even when a writer restores the original mtime.
            path.write_bytes(b"!" + original[1:])
            os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns))
            self.assertEqual((path.stat().st_ino, path.stat().st_size, path.stat().st_mtime_ns),
                             (previous.st_ino, previous.st_size, previous.st_mtime_ns))
            self.assertEqual(self.store.list()["unreadable"], 1)
            path.write_bytes(original)
            os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns))
            self.assertEqual(self.store.list(query="Alpha")["matched"], 1)
            self.assertEqual(full.call_count, 3)
            self.assertFalse(self.store._summary_cache)
            self.assertEqual(self.store._summary_cache_bytes, 0)

    def test_cache_has_independent_entry_and_byte_limits_including_bad_files(self):
        for i in range(4): self.save(f"版本 {i}")
        with patch("frameweave.canvas_store.MAX_SUMMARY_CACHE_ENTRIES", 2):
            cold = self.store.list(); warm = self.store.list()
            self.assertEqual(cold, warm, "over-budget scanning may reread but never changes the result")
            self.assertEqual(len(self.store._summary_cache), 2 if self.cache_supported else 0)
        self.store._summary_cache.clear(); self.store._summary_cache_bytes = 0
        with patch("frameweave.canvas_store.MAX_SUMMARY_CACHE_BYTES", 1):
            self.assertEqual(self.store.list()["total"], 4)
            self.assertFalse(self.store._summary_cache)
            self.assertEqual(self.store._summary_cache_bytes, 0)
        self.root.joinpath("bad.json").write_text("{", encoding="utf-8")
        with patch("frameweave.canvas_store.MAX_SUMMARY_CACHE_ENTRIES", 2):
            self.assertEqual(self.store.list()["unreadable"], 1)
            self.assertLessEqual(len(self.store._summary_cache), 2)
        self.assertFalse(any(isinstance(item[1], BaseException) for item in self.store._summary_cache.values()))

    @unittest.skipUnless(os.name == "nt", "requires the per-file Windows revision provider")
    def test_unavailable_file_revision_rechecks_content_and_discards_warm_entry(self):
        saved = self.save("Alpha")
        self.store.list()
        with (patch("frameweave.canvas_store.file_revision", return_value=None),
              patch.object(self.store, "get", wraps=self.store.get) as full):
            self.assertEqual(self.store.list()["total"], 1)
            path = self.path(saved)
            stamp = path.stat()
            path.write_bytes(path.read_bytes().replace(b"Alpha", b"Bravo"))
            os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            self.assertEqual(self.store.list(query="Bravo")["matched"], 1)
            self.assertEqual(full.call_count, 2)
            self.assertFalse(self.store._summary_cache)

    @unittest.skipUnless(os.name == "nt", "Windows change journals coalesce writes by one writer")
    def test_open_writer_restoring_mtime_never_reuses_a_coalesced_usn(self):
        path = self.path(self.save("Alpha"))
        original = path.read_bytes()
        stamp = path.stat()
        self.store.list()
        with path.open("r+b", buffering=0) as writer:
            for name in ("Bravo", "Gamma", "Delta"):
                writer.seek(0)
                writer.write(original.replace(b"Alpha", name.encode()))
                os.fsync(writer.fileno())
                os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                self.assertEqual(self.store.list(query=name)["matched"], 1)
                self.assertFalse(self.store._summary_cache)
        self.assertEqual(self.store.list(query="Delta")["matched"], 1)

    def test_over_budget_scans_keep_resident_hits_and_deleted_entries_make_room(self):
        saved = [self.save(f"版本 {i}") for i in range(3)]
        with (patch("frameweave.canvas_store.MAX_SUMMARY_CACHE_ENTRIES", 2),
              patch.object(self.store, "get", wraps=self.store.get) as full):
            cold = self.store.list(); self.assertEqual(full.call_count, 3)
            residents = set(self.store._summary_cache)
            self.assertEqual(len(residents), 2 if self.cache_supported else 0)
            full.reset_mock(); self.assertEqual(self.store.list(), cold)
            self.assertEqual(full.call_count, 1 if self.cache_supported else 3,
                             "resident hits require caching; otherwise all files are reread")
            self.assertEqual(set(self.store._summary_cache), residents)
            removed = next(row for row in saved if row['id'] in residents) if residents else saved[0]
            self.path(removed).unlink(); full.reset_mock()
            self.assertEqual(self.store.list()['total'], 2)
            self.assertEqual(full.call_count, 1 if self.cache_supported else 2,
                             "freed cache space admits the missed entry; fallback rereads both files")
            full.reset_mock(); self.assertEqual(self.store.list()['total'], 2)
            self.assertEqual(full.call_count, 0 if self.cache_supported else 2)

    def test_save_failure_does_not_publish_cache_or_disturb_existing_records(self):
        saved = self.save(); self.store.list(); old = dict(self.store._summary_cache)
        with patch("frameweave.canvas_store.os.replace", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.save("not committed")
        self.assertEqual(dict(self.store._summary_cache), old)
        self.assertEqual([path.name for path in self.root.iterdir()], [self.path(saved).name])
        self.assertEqual(self.store.list()["total"], 1)


if __name__ == "__main__":
    unittest.main()
