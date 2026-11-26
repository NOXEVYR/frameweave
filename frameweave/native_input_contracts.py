"""Recheck same-compilation native link observations against portable graph data.

This is a structural proof, not a native-session or backend authorization. The
HTTP boundary must establish those separately. No plugin code is imported here.
Only direct links within one exact root/subgraph instance can be proved; IO
promotion, reroutes and ambiguous execution mappings remain unsupported.
"""

from __future__ import annotations

from .input_contracts import (MAX_CONTRACT_BYTES, MAX_CONTRACT_FIELDS,
                              MAX_CONTRACT_NODES, _encoded, _name,
                              normalize_additional_inputs, resolved_inputs)

_SAFE_INTEGER = 9_007_199_254_740_991
_DYNAMIC_TYPES = {"COMFY_AUTOGROW_V3", "COMFY_DYNAMICCOMBO_V3", "COMFY_MATCHTYPE_V3"}
_OBSERVATION_KEYS = {"name", "type", "slot_index", "native_slot_index",
                     "workflow_slot_index", "link_id", "source",
                     "native_source_id", "native_source_slot"}


def _integer(value, label):
    if type(value) is not int or not 0 <= value <= _SAFE_INTEGER:
        raise ValueError(f"原生输入观察的{label}须为非负精确整数")
    return value


def _identity(value, label):
    if type(value) is int:
        _integer(value, label)
        return str(value)
    return _name(value, 100, label)


def _native_id(value, label):
    value = _identity(value, label)
    if ":" in value:
        raise ValueError("原生输入观察的实例 ID 不能含执行路径分隔符")
    return value


def _port_type(value):
    _name(value, 256, "端口类型")
    parts = [part.strip() for part in value.split(",")]
    if (any(not part or part in _DYNAMIC_TYPES for part in parts)
            or len(set(parts)) != len(parts)):
        raise ValueError("原生输入观察的端口类型无效")
    return ",".join(parts)


def _execution_path(node_id):
    _name(node_id, 100, "执行节点 ID")
    parts = node_id.split(":")
    if len(parts) > 33:
        raise ValueError("原生输入观察的实例路径过深")
    for part in parts:
        _native_id(part, "实例路径 ID")
    return parts


class _GraphIndex:
    """Index graph containers only; never interpret widgets/properties as graphs."""

    def __init__(self, document):
        if not isinstance(document, dict) or not isinstance(document.get("nodes"), list):
            raise ValueError("原生输入观察需要同次编译的原生工作流对象")
        self.document = document
        self.definitions = {}
        self.scopes = {}
        self.node_count = 0
        self.link_count = 0
        self._collect(document, set(), 0)

    def _collect(self, graph, active, depth):
        if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) or depth > 32:
            raise ValueError("原生工作流的子图结构无效或过深")
        identity = id(graph)
        if identity in active:
            raise ValueError("原生工作流不能包含递归子图")
        if identity in self.scopes:
            return
        active = active | {identity}
        nodes = {}
        for node in graph["nodes"]:
            if not isinstance(node, dict):
                raise ValueError("原生工作流节点须为对象")
            node_id = _native_id(node.get("id"), "原生节点 ID")
            if node_id in nodes:
                raise ValueError("原生工作流包含歧义节点 ID")
            nodes[node_id] = node
            self.node_count += 1
            if self.node_count > MAX_CONTRACT_NODES:
                raise ValueError("原生输入观察最多核验 1000 个原生节点")
        links = {}
        collection = graph.get("links", [])
        if isinstance(collection, list):
            items = [(None, link) for link in collection]
        elif isinstance(collection, dict):
            items = list(collection.items())
        else:
            raise ValueError("原生工作流 links 须为数组或对象")
        for key, link in items:
            if isinstance(link, list) and len(link) == 6:
                link = dict(zip(("id", "origin_id", "origin_slot", "target_id", "target_slot", "type"), link))
            elif isinstance(link, dict):
                link = dict(link)
                if "id" not in link and key is not None:
                    link["id"] = key
            else:
                raise ValueError("原生工作流连接须为六元组或连接对象")
            link_id = _identity(link.get("id"), "连接 ID")
            if key is not None and _identity(key, "连接索引") != link_id:
                raise ValueError("原生工作流连接索引与 ID 不一致")
            if link_id in links:
                raise ValueError("原生工作流包含歧义连接 ID")
            links[link_id] = link
            self.link_count += 1
            if self.link_count > 50_000:
                raise ValueError("原生工作流连接数量超过限制")
        self.scopes[identity] = (nodes, links)
        for node in nodes.values():
            if node.get("subgraph") is not None:
                self._collect(node["subgraph"], active, depth + 1)
        definitions = graph.get("definitions", {})
        if not isinstance(definitions, dict):
            raise ValueError("原生工作流 definitions 须为对象")
        subgraphs = definitions.get("subgraphs", [])
        if not isinstance(subgraphs, list):
            raise ValueError("原生工作流 subgraphs 须为数组")
        for definition in subgraphs:
            if not isinstance(definition, dict):
                raise ValueError("原生子图定义须为对象")
            definition_id = _name(definition.get("id"), 256, "子图定义 ID")
            if definition_id in self.definitions:
                raise ValueError("原生工作流包含歧义子图定义 ID")
            self.definitions[definition_id] = definition
            self._collect(definition, active, depth + 1)

    def resolve(self, path):
        graph = self.document
        active = set()
        for index, node_id in enumerate(path):
            if id(graph) in active:
                raise ValueError("原生执行实例路径包含递归子图")
            active.add(id(graph))
            node = self.scopes[id(graph)][0].get(node_id)
            if node is None or node.get("mode", 0) != 0:
                raise ValueError("原生执行实例路径不存在或不是活动节点")
            if index == len(path) - 1:
                return node, graph
            graph = node.get("subgraph") or self.definitions.get(node.get("type"))
            if graph is None:
                raise ValueError("原生执行实例路径未指向明确子图")
        raise ValueError("原生执行实例路径为空")


def _normalize_observations(observations):
    if (not isinstance(observations, dict)
            or set(observations) - {"version", "nodes", "opaque_inputs"}
            or type(observations.get("version")) is not int or observations["version"] != 1):
        raise ValueError("原生输入观察结构或版本无效")
    nodes = observations.get("nodes")
    if not isinstance(nodes, dict) or len(nodes) > MAX_CONTRACT_NODES:
        raise ValueError("原生输入观察最多包含 1000 个节点")
    count = 0
    for node_id, entry in nodes.items():
        path = _execution_path(node_id)
        if not isinstance(entry, dict) or set(entry) != {"class_type", "instance_path", "inputs"}:
            raise ValueError("原生输入观察节点结构无效")
        _name(entry.get("class_type"), 256, "节点类型")
        observed_path = entry.get("instance_path")
        if (not isinstance(observed_path, list) or not observed_path
                or [_native_id(value, "实例路径 ID") for value in observed_path] != path):
            raise ValueError("原生输入观察实例路径与执行 ID 不一致")
        fields = entry.get("inputs")
        if not isinstance(fields, dict) or not fields:
            raise ValueError("原生输入观察需要准确输入集合")
        count += len(fields)
        if count > MAX_CONTRACT_FIELDS:
            raise ValueError("原生输入观察最多包含 4096 个输入")
        for name, field in fields.items():
            _name(name, 256, "输入名称")
            if (not isinstance(field, dict) or set(field) - _OBSERVATION_KEYS
                    or not {"name", "type", "link_id", "source", "native_source_id", "native_source_slot"} <= set(field)
                    or field["name"] != name):
                raise ValueError("原生输入观察字段结构或准确名称无效")
            _port_type(field["type"])
            for key in ("slot_index", "native_slot_index", "workflow_slot_index"):
                if key in field:
                    _integer(field[key], "输入插槽")
            if ("workflow_slot_index" not in field and "slot_index" not in field
                    or "native_slot_index" not in field and "slot_index" not in field):
                raise ValueError("原生输入观察缺少输入插槽")
            if "slot_index" in field and any(field[key] != field["slot_index"]
                                             for key in ("native_slot_index", "workflow_slot_index") if key in field):
                raise ValueError("原生输入观察的插槽别名不一致")
            _identity(field["link_id"], "连接 ID")
            source = field["source"]
            if not isinstance(source, list) or len(source) != 2:
                raise ValueError("原生输入观察需要准确来源连接")
            _execution_path(source[0])
            _integer(source[1], "执行来源插槽")
            _native_id(field["native_source_id"], "原生来源 ID")
            _integer(field["native_source_slot"], "原生来源插槽")
    diagnostics = observations.get("opaque_inputs", [])
    if not isinstance(diagnostics, list) or len(diagnostics) > MAX_CONTRACT_FIELDS:
        raise ValueError("原生输入观察诊断数量无效")
    for diagnostic in diagnostics:
        if not isinstance(diagnostic, dict) or set(diagnostic) != {"node_id", "input", "reason"}:
            raise ValueError("原生输入观察诊断只能包含节点、输入名称和原因")
        _name(diagnostic["node_id"], 100, "诊断节点 ID")
        _name(diagnostic["input"], 256, "诊断输入名称")
        _name(diagnostic["reason"], 256, "诊断原因")
    return nodes


def verify_native_additional_inputs(document, prompt, info, additional_inputs, observations):
    """Return proved normalized *extra* links, or None when none remain.

    Invalid, stale or ambiguous evidence raises ValueError without including
    scalar/media values in its diagnostic. Formal fields use the live resolver
    and are removed from the returned sidecar after compatibility checking.
    Native slot indices are bounded audit data; the serialized workflow index
    is rechecked separately because official compilation can compact widgets.
    """
    from .workflows import _expanded_inputs

    contract = normalize_additional_inputs(additional_inputs, prompt)
    if contract is None or not contract["nodes"]:
        if observations is not None:
            if len(_encoded(observations)) > MAX_CONTRACT_BYTES:
                raise ValueError("原生输入观察最大为 2 MiB")
            _normalize_observations(observations)
        return None
    if len(_encoded({"additional_inputs": contract, "observations": observations})) > MAX_CONTRACT_BYTES:
        raise ValueError("原生输入契约与观察合计最大为 2 MiB")
    observed_nodes = _normalize_observations(observations)
    if not isinstance(info, dict) or not isinstance(prompt, dict) or len(prompt) > MAX_CONTRACT_NODES:
        raise ValueError("原生输入契约需要有界 API 图与当前后端定义")
    graph_index = _GraphIndex(document)
    result = {"version": 1, "nodes": {}}
    for node_id, entry in contract["nodes"].items():
        observed = observed_nodes.get(node_id)
        if observed is None or observed["class_type"] != entry["class_type"]:
            raise ValueError(f"节点 {node_id} 缺少同次原生编译的准确输入观察")
        path = _execution_path(node_id)
        native, scope = graph_index.resolve(path)
        if native.get("type") != entry["class_type"]:
            raise ValueError(f"节点 {node_id} 的原生实例类型与 API 类型不一致")
        schema = info.get(entry["class_type"])
        if not isinstance(schema, dict):
            raise ValueError(f"节点 {node_id} 缺少当前后端类型定义")
        # Hidden/inactive fields and incompatible newly-declared types cannot
        # gain authority through an observation. Official metadata stays intact.
        resolved_inputs(node_id, prompt[node_id], schema, contract)
        formal, _ = _expanded_inputs(schema, prompt[node_id]["inputs"])
        ports = native.get("inputs")
        if not isinstance(ports, list):
            raise ValueError(f"节点 {node_id} 缺少原生输入插槽")
        extras = {}
        for name, definition in entry["inputs"].items():
            observation = observed["inputs"].get(name)
            if (observation is None or _port_type(observation["type"]) != definition["type"]
                    or observation["source"] != definition["source"]):
                raise ValueError(f"节点 {node_id}.{name} 的输入观察与契约不一致")
            matches = [(index, port) for index, port in enumerate(ports)
                       if isinstance(port, dict) and port.get("name") == name]
            if len(matches) != 1:
                raise ValueError(f"节点 {node_id}.{name} 的原生输入名称不唯一或不存在")
            slot_index, port = matches[0]
            workflow_index = observation.get("workflow_slot_index", observation.get("slot_index"))
            if slot_index != workflow_index or _port_type(port.get("type")) != definition["type"]:
                raise ValueError(f"节点 {node_id}.{name} 的原生工作流输入插槽已改变")
            link_id = _identity(observation["link_id"], "连接 ID")
            if port.get("link") is None or _identity(port["link"], "输入连接 ID") != link_id:
                raise ValueError(f"节点 {node_id}.{name} 的原生输入连接已改变")
            link = graph_index.scopes[id(scope)][1].get(link_id)
            if link is None or link.get("originIsIoNode"):
                raise ValueError(f"节点 {node_id}.{name} 的原生直连无法证明")
            source_id, source_slot = definition["source"]
            source_path = _execution_path(source_id)
            native_source_id = _native_id(observation["native_source_id"], "原生来源 ID")
            if (path[:-1] != source_path[:-1] or source_path[-1] != native_source_id
                    or observation["native_source_slot"] != source_slot):
                raise ValueError(f"节点 {node_id}.{name} 的来源不是同一子图实例内的准确直连")
            upstream, source_scope = graph_index.resolve(source_path)
            source_prompt = prompt.get(source_id)
            if (source_scope is not scope or not isinstance(source_prompt, dict)
                    or upstream.get("type") != source_prompt.get("class_type")
                    or not isinstance(info.get(source_prompt.get("class_type")), dict)
                    or not isinstance(upstream.get("outputs"), list)
                    or source_slot >= len(upstream["outputs"])
                    or not isinstance(upstream["outputs"][source_slot], dict)):
                raise ValueError(f"节点 {node_id}.{name} 的来源执行映射无法证明")
            if (_native_id(link.get("target_id"), "连接目标 ID") != path[-1]
                    or _integer(link.get("target_slot"), "连接目标插槽") != workflow_index
                    or _native_id(link.get("origin_id"), "连接来源 ID") != native_source_id
                    or _integer(link.get("origin_slot"), "连接来源插槽") != source_slot):
                raise ValueError(f"节点 {node_id}.{name} 的文档连接端点与 API 连接不一致")
            if name not in formal:
                extras[name] = definition
        if extras:
            result["nodes"][node_id] = {"class_type": entry["class_type"], "inputs": extras}
    return result if result["nodes"] else None
