"""Durable ownership of jobs outside the active/recent history window."""
from contextlib import closing, contextmanager
import hashlib
import json
import sqlite3
import stat

from .recovery import job_record


def media_key(backend, kind, subfolder, filename):
    return hashlib.sha256(f"{backend}|{kind}|{subfolder}|{filename}".encode()).hexdigest()[:32]


class JobArchive:
    def __init__(self, root):
        self.path = root / 'job-archive.sqlite3'
        self.may_have_snapshots = self.path.exists()

    @contextmanager
    def _open(self, writing=False):
        try:
            for path in (self.path, *(self.path.with_name(self.path.name + s) for s in ('-journal', '-wal', '-shm'))):
                try:
                    info = path.lstat()
                except FileNotFoundError:
                    if path == self.path and not writing:
                        yield None
                        return
                    continue
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                        or getattr(info, 'st_file_attributes', 0) & 0x400):
                    raise OSError('任务归档路径不是独立普通文件')
            uri = self.path.absolute().as_uri() + ('?mode=rwc' if writing else '?mode=ro')
            with closing(sqlite3.connect(uri, uri=True, timeout=3)) as db:
                with db:
                    if writing:
                        db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL)')
                        db.execute('CREATE TABLE IF NOT EXISTS outputs (media_key TEXT PRIMARY KEY, job_id TEXT NOT NULL)')
                    yield db
        except sqlite3.Error as exc:
            raise OSError('任务归档不可用，请保留原文件并检查磁盘。') from exc

    def store(self, jobs):
        if not jobs:
            return
        with self._open(writing=True) as db:
            for job in jobs:
                ident = job['id']
                db.execute('INSERT OR REPLACE INTO jobs VALUES (?, ?)',
                           (ident, json.dumps(job, allow_nan=False, ensure_ascii=False)))
                for output in job.get('outputs', []):
                    key = media_key(job['backend'], output.get('storage_type', 'output'),
                                    output.get('subfolder', ''), output['filename'])
                    db.execute('INSERT OR REPLACE INTO outputs VALUES (?, ?)', (key, ident))

    def snapshot(self, jobs):
        # Immutable rows keep the preceding JSON index valid until its atomic replacement.
        pointers = []
        with self._open(writing=True) as db:
            db.execute("CREATE TABLE IF NOT EXISTS snapshots (digest TEXT PRIMARY KEY, record TEXT NOT NULL)")
            for job in jobs:
                raw = json.dumps(job, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
                db.execute("INSERT OR IGNORE INTO snapshots VALUES (?, ?)", (digest, raw))
                pointers.append({"id": job["id"], "archived_record": digest})
        self.may_have_snapshots = True
        return pointers

    def release_unreferenced_snapshots(self, rows):
        if not self.may_have_snapshots:
            return
        live = {row["archived_record"] for row in rows if set(row) == {"id", "archived_record"}}
        # The JSON replacement is already durable. A failed cleanup can be
        # retried; it cannot invalidate either current records or owned media.
        try:
            with self._open(writing=True) as db:
                table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshots'").fetchone()
                if table:
                    stale = [(key,) for key, in db.execute("SELECT digest FROM snapshots") if key not in live]
                    db.executemany("DELETE FROM snapshots WHERE digest=?", stale)
            self.may_have_snapshots = bool(live)
        except OSError:
            return

    def restore_record(self, row):
        if not isinstance(row, dict) or set(row) != {"id", "archived_record"}:
            return job_record(row)
        digest = row["archived_record"]
        with self._open() as db:
            if db is None or not isinstance(digest, str) or len(digest) != 64:
                raise OSError("任务快照缺失")
            result = db.execute("SELECT record FROM snapshots WHERE digest=?", (digest,)).fetchone()
        if not result or hashlib.sha256(result[0].encode("utf-8")).hexdigest() != digest:
            raise OSError("任务快照缺失或损坏")
        job = job_record(json.loads(result[0]))
        if job["id"] != row["id"]:
            raise OSError("任务快照 ID 不一致")
        return job

    def lookup(self, *, ident=None, media=None):
        with self._open() as db:
            if db is None:
                return None
            if media is not None:
                row = db.execute('SELECT jobs.id, record FROM outputs JOIN jobs ON jobs.id=outputs.job_id '
                                 'WHERE media_key=?', (media,)).fetchone()
            else:
                row = db.execute('SELECT id, record FROM jobs WHERE id=?', (ident,)).fetchone()
            if row is None:
                return None
            record = job_record(json.loads(row[1]))
            if record['id'] != row[0]:
                raise ValueError('任务归档的 ID 不一致')
            return record
