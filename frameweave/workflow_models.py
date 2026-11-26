"""Model controls for a user-selected output of a registered workflow."""
from copy import deepcopy

from .editor_interfaces import inspect_interface, output_closure
from .input_contracts import resolved_inputs
from .packages import _stored_package_document, normalize_document
from .workflows import _spec


def workflow_models(package, info, output_id=None, choices=None, *, contract=None):
    document = deepcopy(_stored_package_document(package))
    prompt = document["prompt"]
    interface = inspect_interface(prompt, info, previous_fields=document["fields"],
                                  previous_prompt=prompt, additional_inputs=contract)
    outputs = interface["outputs"]
    if output_id is None:
        if choices is not None:
            raise ValueError("请先选择工作流输出")
        return {"outputs": outputs}
    if not isinstance(output_id, str) or not any(item["id"] == output_id for item in outputs):
        raise ValueError("当前引擎不能识别所选工作流输出")
    active = set(output_closure(prompt, [output_id], info)["node_ids"])
    fields = {(f["node_id"], f["input"]): f for f in document["fields"]}
    slots = []
    for field in interface["fields"]:
        node_id, name = field["node_id"], field["input"]
        if node_id not in active or field["type"] not in {"text", "select"}:
            continue
        node = prompt[node_id]
        definitions, _ = resolved_inputs(node_id, node, info[node["class_type"]], contract)
        if name not in definitions:
            continue
        kind, metadata = _spec(definitions[name])
        options = kind if isinstance(kind, list) else metadata.get("options") if kind == "COMBO" else None
        if not isinstance(options, list) or not all(isinstance(value, str) for value in options):
            continue
        model_key = (name in {"model", "weights", "checkpoint", "encoder", "tokenizer", "lora", "vae"} or
                     name.endswith(("_name", "_file", "_path")) or name in {"clip_name1", "clip_name2"})
        resource = name in {"weights", "model_id", "model_name"} or (model_key and field.get("role") in {"model", "encoder", "lora"}) or any(
            s.lower().endswith((".safetensors", ".gguf", ".ckpt", ".onnx", ".pt", ".pth", ".bin"))
            for s in options)
        if not resource:
            continue
        old = fields.get((node_id, name))
        public_id = old["id"] if old else field["id"]
        default = old["default"] if old else node["inputs"][name]
        slots.append({"id": public_id, "node": node_id, "class_type": node["class_type"],
                      "input": name, "label": old["label"] if old else field["label"],
                      "options": options, "current": default})
    result = {"outputs": outputs, "slots": slots}
    if choices is None:
        return result
    if not isinstance(choices, dict) or set(choices) != {slot["id"] for slot in slots}:
        raise ValueError("模型加载器已改变，请刷新后重新选择")
    for slot in slots:
        value = choices[slot["id"]]
        if not isinstance(value, str) or value not in slot["options"]:
            raise ValueError(f"节点 {slot['node']}.{slot['input']} 的选择已不在当前引擎目录中")
        key = (slot["node"], slot["input"])
        field = fields.get(key)
        if field is None:
            field = {"id": slot["id"], "label": slot["label"], "node_id": key[0], "input": key[1],
                     "presentation": "control", "role": "model"}
            document["fields"].append(field)
        if field.get("type") not in (None, "text", "select"):
            raise ValueError("已有字段的类型已改变，请先在检查器中重新绑定")
        field["type"] = "select" if len(slot["options"]) <= 512 else "text"
        if field["type"] == "select":
            field["options"] = slot["options"]
        else:
            field.pop("options", None)
        field["default"] = slot["current"] if slot["current"] in slot["options"] else value
        prompt[key[0]]["inputs"][key[1]] = field["default"]
    return {**result, "document": normalize_document(document), "values": dict(choices)}
