"""Private, loopback-only transport. No owner controls, proxies, redirects or ambient logs."""

import http.client
import re
import time
from urllib.parse import urlencode
from pathlib import Path

from .hub_execution_contract import (PROTOCOL, canonical, fail, identity, require_hash,
                                     require_uuid, sha, strict_json)


class HubUnavailable(RuntimeError):
    pass


class HubRejected(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"hub_http_{status}")


class HubTransport:
    def __init__(self, grant):
        if (not isinstance(grant, dict) or grant.get("schema") != "ai-hub-execution-grant/1"
                or grant.get("protocol") != PROTOCOL or grant.get("role") != "worker"):
            fail("worker_grant_required")
        connection = grant.get("connection", {})
        if (connection.get("scheme") != "http" or connection.get("host") != "127.0.0.1"
                or type(connection.get("port")) is not int or not 1 <= connection["port"] <= 65535
                or connection.get("app") != "ai-hub"
                or connection.get("control_protocol") != "ai-hub-local-control-v1"
                or not isinstance(connection.get("install_root"), str)
                or not Path(connection["install_root"]).is_absolute()):
            fail("grant_connection")
        token = grant.get("token")
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
            fail("grant_token")
        if not isinstance(grant.get("subject"), str) or not grant["subject"]:
            fail("grant_subject")
        for key in ("workspace_root",):
            if not isinstance(grant.get(key), str) or not Path(grant[key]).is_absolute():
                fail("grant_workspace")
        require_uuid(grant.get("grant_id"))
        self._instance_id(connection.get("service_instance_id"))
        require_hash(connection.get("connection_revision"))
        self.binding = {"execution_authority_id": require_uuid(grant.get("execution_authority_id")),
                        "ledger_epoch": require_uuid(grant.get("ledger_epoch")),
                        "workspace_binding_revision": require_hash(grant.get("workspace_binding_revision")),
                        "client_id": grant["subject"]}
        self._token = token
        self._workspace = grant["workspace_root"]
        self._connection = dict(connection)

    @staticmethod
    def _instance_id(value):
        # Service-control uses uuid4().hex; execution IDs use canonical UUID strings.
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
            fail("hub_service_identity")

    @classmethod
    def from_file(cls, path):
        try:
            with Path(path).open("rb") as stream:
                raw = stream.read(32769)
            return cls(strict_json(raw.decode("utf-8"), 32768))
        except (OSError, UnicodeError):
            fail("grant_file_unreadable")

    def _request(self, path, body=None, bearer=False):
        connection = http.client.HTTPConnection("127.0.0.1", self._connection["port"], timeout=10)
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if bearer:
            headers["Authorization"] = "Bearer " + self._token
        try:
            encoded = None if body is None else canonical(dict(body, _workspace_root=self._workspace))
            connection.request("GET" if encoded is None else "POST", path, encoded, headers)
            response = connection.getresponse()
            if response.status != 200:
                raise HubRejected(response.status)
            chunks, size, deadline = [], 0, time.monotonic() + 20
            while True:
                if time.monotonic() > deadline:
                    raise HubUnavailable("hub_connection_uncertain")
                chunk = response.read1(min(65536, 2 * 1024 * 1024 + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > 2 * 1024 * 1024:
                    fail("hub_response_limit")
            raw = b"".join(chunks)
            value = strict_json(raw.decode("utf-8"), 2 * 1024 * 1024)
            if not isinstance(value, dict):
                fail("hub_response_shape")
            return value
        except (OSError, http.client.HTTPException, UnicodeError):
            raise HubUnavailable("hub_connection_uncertain") from None
        finally:
            connection.close()

    def describe(self):
        value = self._request("/api/execution/describe")
        self.validate_descriptor(value)
        return value

    def validate_descriptor(self, value):
        remote = value.get("identity", {})
        workspace = value.get("workspace", {})
        if (value.get("protocol") != PROTOCOL or value.get("schema_version") != 1
                or remote.get("status") != "available" or workspace.get("status") != "available"
                or remote.get("app") != "ai-hub"
                or remote.get("port") != self._connection["port"]
                or remote.get("install_root") != self._connection.get("install_root")
                or remote.get("control_protocol") != self._connection.get("control_protocol")
                or value.get("workspace_root") != self._workspace
                or workspace.get("binding_revision") != self.binding["workspace_binding_revision"]
                or any(value.get(k) != self.binding[k] for k in ("execution_authority_id", "ledger_epoch"))):
            fail("hub_connection_scope_changed")
        self._instance_id(remote.get("service_instance_id"))
        require_hash(value.get("connection_revision"))
        # Restart changes instance/connection revision, not the durable execution authority.

    def status(self, execution_id):
        return self._request("/api/execution/status", {"execution_id": execution_id}, True)

    def inbox(self, limit=10, after_execution_id=None):
        if type(limit) is not int or not 1 <= limit <= 25:
            fail("inbox_limit")
        body = {"limit": limit}
        if after_execution_id is not None:
            body["after_execution_id"] = require_uuid(after_execution_id)
        value = self._request("/api/execution/inbox", body, True)
        items = value.get("items")
        if (value.get("protocol") != PROTOCOL or type(items) is not list or len(items) > limit
                or type(value.get("has_more")) is not bool or value.get("claim_performed") is not False
                or value.get("native_work_started") is not False):
            fail("inbox_response")
        seen = set()
        for item in items:
            if not isinstance(item, dict):
                fail("inbox_response")
            execution_id = require_uuid(item.get("execution_id"))
            identity(item, self.binding, execution_id)
            if (execution_id in seen or execution_id == after_execution_id
                    or item.get("dispatch_state") not in {"queued_ready", "claimed"}
                    or item.get("provider_state") not in {"not_started", "submitting", "running", "uncertain", "succeeded", "failed", "cancelled"}
                    or any(key in item for key in ("lease_token", "input_json", "declaration_text", "token"))):
                fail("inbox_response")
            seen.add(execution_id)
        expected = items[-1]["execution_id"] if value["has_more"] and items else None
        if (value["has_more"] and not items or value.get("next_after_execution_id") != expected):
            fail("inbox_cursor")
        return value

    def read_capability(self, capability_id):
        if not isinstance(capability_id, str) or not re.fullmatch("[0-9a-f]{32}", capability_id):
            fail("capability_identity")
        descriptor = self.describe()
        params = {"_workspace_root": self._workspace, "capability_id": capability_id,
                  "connection_revision": descriptor["connection_revision"]}
        # Public observational endpoint: never send a worker/owner token to interop.
        value = self._request("/api/interop/capability-snapshot?" + urlencode(params))
        if value.get("protocol") != "aihub-interop/1" or value.get("connection_revision") != descriptor["connection_revision"]:
            fail("capability_scope")
        self.validate_descriptor(dict(value, protocol=PROTOCOL,
            execution_authority_id=self.binding["execution_authority_id"], ledger_epoch=self.binding["ledger_epoch"]))
        selected, declaration = value.get("selected", {}), value.get("declaration", {})
        if (not isinstance(selected, dict) or selected.get("id") != capability_id
                or selected.get("client_id") != self.binding["client_id"] or not isinstance(declaration, dict)):
            fail("capability_scope")
        text = declaration.get("text")
        parsed = strict_json(text, 32768)
        if (not isinstance(parsed, dict) or declaration.get("encoding") != "utf-8"
                or declaration.get("origin") != "stored_normalized_declaration"
                or type(declaration.get("bytes")) is not int or declaration["bytes"] != len(text.encode("utf-8"))
                or declaration.get("sha256") != sha(text.encode("utf-8")) or declaration.get("parsed") != parsed):
            fail("capability_declaration")
        return {"capability_id": capability_id, "declaration_text": text,
                "declaration_sha256": declaration["sha256"], "client_id": selected["client_id"]}

    def claim(self, execution_id, claim_request_id):
        return self._request("/api/execution/claim", {
            "execution_id": execution_id, "claim_request_id": claim_request_id}, True)

    def observe(self, execution_id, lease_token, observation):
        return self._request("/api/execution/observe", dict(observation, execution_id=execution_id,
                             lease_token=lease_token), True)

    def report(self, payload, lease_token):
        return self._request("/api/collaboration/mcp/report_submit", dict(payload, lease_token=lease_token))

    def finish(self, task_id, client_id, lease_token):
        return self._request("/api/collaboration/mcp/task_finish", {
            "task_id": task_id, "client_id": client_id, "lease_token": lease_token,
            "summary": "PrismCanvas execution terminal receipt and report submitted."})
