"""Bounded verification of registered, owned outputs. No copies or caller paths."""

import copy
import hashlib
import re
import time
import urllib.parse
import urllib.request
import uuid

from .backend import Backend
from .hub_execution_contract import fail

MAX_TOTAL = 1024 * 1024 * 1024
MIME = re.compile(r"^(image|video|audio)/[A-Za-z0-9!#$&^_.+-]+$")


def result_manifest(execution_id, job_id, outputs, open_output, *, limit=MAX_TOTAL, seconds=120):
    """open_output accepts an owned output record, not a URL. Stream at most 1 GiB total."""
    if not isinstance(outputs, list) or not 1 <= len(outputs) <= 64:
        fail("results_not_verifiable")
    result, seen, total = [], set(), 0
    deadline = time.monotonic() + seconds
    for output in outputs:
        output_id = output.get("output_id", "")
        kind = output.get("type")
        if not re.fullmatch(r"o-[0-9a-f]{64}", output_id) or output_id in seen or kind not in {"image", "video", "audio"}:
            fail("output_identity")
        seen.add(output_id)
        digest, size = hashlib.sha256(), 0
        with open_output(output) as stream:
            mime = stream.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if not MIME.fullmatch(mime) or mime.split("/")[0] != kind:
                fail("output_media_type")
            length = stream.headers.get("Content-Length")
            if length is not None and (not length.isascii() or not length.isdigit() or int(length) > limit - total):
                fail("output_size_limit")
            if getattr(stream, "status", 200) != 200 or stream.headers.get("Content-Encoding", "identity") != "identity":
                fail("output_transport")
            while True:
                if time.monotonic() > deadline:
                    fail("output_time_limit")
                chunk = getattr(stream, "read1", stream.read)(min(128 * 1024, limit - total + 1))
                if not chunk:
                    break
                size += len(chunk)
                total += len(chunk)
                if total > limit:
                    fail("output_size_limit")
                digest.update(chunk)
            if size == 0 or (length is not None and int(length) != size):
                fail("output_incomplete")
        result.append({"result_id": output_id, "kind": kind, "media_type": mime,
                       "bytes": size, "sha256": digest.hexdigest(),
                       "locator": "pc-result-" + str(uuid.uuid5(uuid.UUID(execution_id), job_id + ":" + output_id))})
    return sorted(result, key=lambda item: item["result_id"])


def owned_manifest(app, execution_id, job_id, backend):
    from .server import output_identity
    with app.lock:
        job = app.jobs.get(job_id)
        if not job or job.get("backend") != backend or job.get("status") != "completed":
            fail("output_job_scope")
        outputs = copy.deepcopy(app.public_job(job)["outputs"])
        registered = {}
        for output in outputs:
            if output_identity(job_id, output) != output.get("output_id"):
                fail("output_identity")
            url = output.get("url", "")
            if not re.fullmatch(r"/api/media/[0-9a-f]{32}", url):
                fail("output_unregistered")
            record = app.media.get(url.rsplit("/", 1)[-1])
            if (not record or record[0] != backend or record[1].get("type") not in {"output", "temp"}
                    or record[1].get("filename") != output.get("filename")
                    or record[1].get("subfolder", "") != output.get("subfolder", "")):
                fail("output_unregistered")
            registered[output["output_id"]] = copy.deepcopy(record[1])
    adapter = Backend(backend)

    def open_output(output):
        query = registered[output["output_id"]]
        request = urllib.request.Request(backend + "/view?" + urllib.parse.urlencode(query),
                                         headers={"Accept-Encoding": "identity"})
        return adapter.opener.open(request, timeout=10)

    return result_manifest(execution_id, job_id, outputs, open_output)


def read_result(store, app, execution_id, locator, *, max_bytes=32 * 1024 * 1024):
    """Read one frozen small result by opaque identity, never by a supplied path.

    This is a private Python adapter API, not a public HTTP route. The receiving
    app decides its own explicit import; no file is copied or saved here.
    """
    from .server import output_identity
    if type(max_bytes) is not int or not 1 <= max_bytes <= 64 * 1024 * 1024:
        fail("result_read_limit")
    record = store.get(execution_id)
    receipt = record.get("receipt") if record else None
    if not receipt or receipt.get("provider_state") != "succeeded":
        fail("result_not_committed")
    matches = [item for item in receipt.get("results", []) if item.get("locator") == locator]
    if len(matches) != 1:
        fail("result_locator_unknown")
    manifest = matches[0]
    if type(manifest.get("bytes")) is not int or not 0 < manifest["bytes"] <= max_bytes:
        fail("result_read_limit")
    with app.lock:
        job = app.jobs.get(record["job_id"])
        if not job or job.get("status") != "completed" or job.get("backend") != record["backend"]:
            fail("output_job_scope")
        outputs = [output for output in job.get("outputs", [])
                   if output_identity(job["id"], output) == manifest["result_id"]]
        if len(outputs) != 1:
            fail("output_identity")
        output = outputs[0]
        url = output.get("url", "")
        if not re.fullmatch(r"/api/media/[0-9a-f]{32}", url):
            fail("output_unregistered")
        registered = app.media.get(url.rsplit("/", 1)[-1])
        if (not registered or registered[0] != record["backend"]
                or registered[1].get("type") not in {"output", "temp"}
                or registered[1].get("filename") != output.get("filename")
                or registered[1].get("subfolder", "") != output.get("subfolder", "")):
            fail("output_unregistered")
        query = copy.deepcopy(registered[1])
    adapter = Backend(record["backend"])
    request = urllib.request.Request(record["backend"] + "/view?" + urllib.parse.urlencode(query),
                                     headers={"Accept-Encoding": "identity"})
    chunks, size = [], 0
    deadline = time.monotonic() + 120
    with adapter.opener.open(request, timeout=10) as stream:
        if stream.status != 200 or stream.headers.get("Content-Encoding", "identity") != "identity":
            fail("output_transport")
        mime = stream.headers.get("Content-Type", "")
        while True:
            if time.monotonic() > deadline:
                fail("output_time_limit")
            chunk = getattr(stream, "read1", stream.read)(min(128 * 1024, manifest["bytes"] - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > manifest["bytes"]:
                fail("result_content_changed")
            chunks.append(chunk)
    body = b"".join(chunks)
    if (len(body) != manifest["bytes"] or hashlib.sha256(body).hexdigest() != manifest.get("sha256")
            or mime.split(";", 1)[0].strip().lower() != manifest["media_type"]):
        fail("result_content_changed")
    return {"data": body, "media_type": manifest["media_type"], "bytes": len(body),
            "sha256": manifest["sha256"], "result_id": manifest["result_id"]}
