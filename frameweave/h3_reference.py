"""Pure, live-schema-checked H3 multimodal reference package assembly.

No backend, filesystem, upload or execution operations belong in this module.
Prepared packages are editing drafts; empty resources remain pending inputs.
"""
from __future__ import annotations

import copy
import math
import re

from .media_contract import media_input_contract
from .packages import FORMAT, encoded, inspect_document, normalize_document
from .workflows import (_expanded_inputs, _spec, build_preset_editor_recipe,
                        validate_editor_prompt)

H3_NODE = "MiniMaxH3ReferenceToVideo"
REQUEST_FIELDS = frozenset({"kind", "positive", "negative", "models", "seed", "width", "height",
    "steps", "cfg", "denoise", "sampler", "scheduler", "seconds", "fps", "references",
    "reference_roles", "lora", "lora_strength", "loras", "shift_video", "shift_audio",
    "ref_image_size", "custom_size", "ref_resolution", "refine"})
GROUPS = {"images": ("ref_images", "IMAGE", 9), "videos": ("ref_videos", "IMAGE", 3),
          "soundtracks": ("ref_video_audios", "AUDIO", 3), "audios": ("ref_audios", "AUDIO", 3)}
VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FRAMES = 736, 416, 362


class _Blocked(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _schema(info, name):
    schema = info.get(name)
    if (not isinstance(schema, dict) or not isinstance(schema.get("input"), dict)
            or not isinstance(schema.get("output"), (list, tuple))):
        raise _Blocked("missing_node", f"后端缺少有效节点定义 {name}")
    if schema.get("api_node") is True:
        raise _Blocked("unsupported_node", f"{name} 不是本地节点")
    return schema


def _group_names(info, modality):
    group, expected, limit = GROUPS[modality]
    schema = _schema(info, H3_NODE)
    if list(schema["output"]) != ["CONDITIONING", "LATENT"]:
        raise _Blocked("incompatible_h3_outputs", f"{H3_NODE} 输出合同改变")
    try:
        expanded, required = _expanded_inputs(schema, {})
        declarations = [schema["input"].get(section, {}).get(group)
                        for section in ("required", "optional") if group in schema["input"].get(section, {})]
        if len(declarations) != 1:
            raise ValueError("缺少唯一动态输入声明")
        kind, meta = _spec(declarations[0])
        if kind != "COMFY_AUTOGROW_V3":
            raise ValueError("不是 COMFY_AUTOGROW_V3")
        template = meta.get("template")
        if not isinstance(template, dict):
            raise ValueError("缺少动态模板")
        names = template.get("names")
        if names is None:
            maximum, prefix = template.get("max"), template.get("prefix")
            if type(maximum) is not int or not 0 <= maximum <= 1000 or not isinstance(prefix, str) or not prefix:
                raise ValueError("缺少明确 names 或 prefix/max")
            names = [prefix + str(index) for index in range(maximum)]
        if (not isinstance(names, list) or len(names) > 1000
                or any(not isinstance(name, str) or not name or len(name) > 1024 for name in names)
                or len(set(names)) != len(names)):
            raise ValueError("动态名称无效或重复")
        for name in names:
            key = group + "." + name
            if key not in expanded or _spec(expanded[key])[0] != expected:
                raise ValueError(f"{key} 需要 {expected} 类型")
        if modality in {"videos", "soundtracks"}:
            prefix = "ref_video_" if modality == "videos" else "ref_video_audio_"
            if any(not re.fullmatch(re.escape(prefix) + r"\d+", name) for name in names):
                raise ValueError(f"同号配对要求实际名称为 {prefix}N")
            if len({name.rsplit("_", 1)[1] for name in names}) != len(names):
                raise ValueError("同号后缀重复")
        if any(key.startswith(group + ".") for key in required):
            raise ValueError("动态输入最小数量必须为 0，才能按用户选择槽数装配")
        return names[:limit]
    except (AttributeError, TypeError, ValueError) as error:
        raise _Blocked("incompatible_reference_group", f"{H3_NODE}.{group}：{error}") from error


def _media_loader(info, name, input_name, media_type, output_slot, output_type):
    schema = _schema(info, name)
    try:
        fields, required = _expanded_inputs(schema, {})
        contract = media_input_contract(name, input_name, fields.get(input_name), required=input_name in required)
        if not contract["supported"] or contract["media_type"] != media_type:
            raise ValueError(f"文件输入不支持标准 {media_type} 上传合同（{contract['reason']}）")
        if len(schema["output"]) <= output_slot or schema["output"][output_slot] != output_type:
            raise ValueError(f"第 {output_slot} 输出必须为 {output_type}")
        return fields, required
    except (AttributeError, TypeError, ValueError) as error:
        raise _Blocked("incompatible_media_loader", f"{name}：{error}") from error


def _number_contract(fields, name, kind, value):
    if name not in fields:
        raise ValueError(f"缺少 {name}，不能证明有界加载或 24 fps 转换")
    actual, meta = _spec(fields[name])
    if actual not in kind:
        raise ValueError(f"{name} 类型不兼容")
    for bound in ("min", "max"):
        if bound in meta and (type(meta[bound]) not in (int, float) or not math.isfinite(meta[bound])):
            raise ValueError(f"{name} 范围无效")
    if not meta.get("min", -math.inf) <= value <= meta.get("max", math.inf):
        raise ValueError(f"{name} 不允许值 {value}")


def _video_loader(info, *, soundtrack=False, width=VIDEO_WIDTH, height=VIDEO_HEIGHT, cap=124):
    fields, required = _media_loader(info, "VHS_LoadVideo", "video", "video", 0, "IMAGE")
    values = {"video": "", "force_rate": 24.0, "custom_width": width, "custom_height": height,
              "frame_load_cap": cap, "skip_first_frames": 0, "select_every_nth": 1, "format": "None"}
    try:
        for name in ("force_rate", "custom_width", "custom_height", "frame_load_cap", "skip_first_frames", "select_every_nth"):
            _number_contract(fields, name, {"FLOAT", "INT"} if name == "force_rate" else {"INT"}, values[name])
        kind, meta = _spec(fields.get("format"))
        choices = kind if isinstance(kind, list) else meta.get("options") if kind == "COMBO" else None
        if not isinstance(choices, list) or "None" not in choices:
            raise ValueError("format 不支持 None，不能保证不改写加载帧率/画幅")
        if required - values.keys():
            raise ValueError("有未实现的必填输入：" + ", ".join(sorted(required - values.keys())))
        if soundtrack:
            outputs = info["VHS_LoadVideo"]["output"]
            if len(outputs) <= 2 or outputs[2] != "AUDIO":
                raise ValueError("第 2 输出不是 AUDIO，无法同源配对声轨")
    except (TypeError, ValueError) as error:
        raise _Blocked("incompatible_video_loader", f"VHS_LoadVideo：{error}") from error
    return values


def _scaffold_info(info):
    # The legacy pure recipe requires one image. Its disposable scaffold is
    # removed before validation against the ORIGINAL live schema. This does
    # not assert LoadImage or an image slot exists for video/audio-only graphs.
    scaffold = dict(info)
    schema = copy.deepcopy(_schema(info, H3_NODE))
    for section in ("required", "optional"):
        schema["input"].get(section, {}).pop("ref_images", None)
    schema["input"].setdefault("optional", {})["ref_images"] = ["COMFY_AUTOGROW_V3", {"template": {
        "input": {"required": {"ref_image": ["IMAGE", {}]}}, "names": ["discarded_image"], "min": 0}}]
    scaffold[H3_NODE] = schema
    scaffold["LoadImage"] = {"input": {"required": {"image": [[], {"image_upload": True}]}}, "output": ["IMAGE", "MASK"]}
    return scaffold


def _diagnosis(call, limit):
    try:
        result = call()
        maximum = min(limit, len(result)) if isinstance(result, list) else limit
        if maximum == 0:
            raise _Blocked("reference_capacity_zero", "当前后端动态参考容量为 0")
        return {"available": True, "max_count": maximum}
    except (AttributeError, TypeError, ValueError) as error:
        return {"available": False, "max_count": 0, "reason": str(error),
                "blocked": [{"code": getattr(error, "code", "incompatible_schema"), "message": str(error)}]}


def h3_reference_capability(info):
    """Value-free modality diagnostics; resource catalog contents are omitted."""
    if not isinstance(info, dict):
        raise ValueError("节点能力必须是对象")
    def base():
        result = build_preset_editor_recipe({"kind": "h3_ref"}, _scaffold_info(info))
        if result["status"] != "materialized":
            reason = result["blocked"][0]
            raise _Blocked(reason["code"], reason["message"])
    result = {"base": _diagnosis(base, 1)}
    def modality(name):
        names = _group_names(info, name)
        if name == "images":
            _media_loader(info, "LoadImage", "image", "image", 0, "IMAGE")
        elif name in {"videos", "soundtracks"}:
            _video_loader(info, soundtrack=name == "soundtracks")
            if name == "soundtracks":
                videos = _group_names(info, "videos")
                names = [name for name in names if "ref_video_" + name.rsplit("_", 1)[1] in videos]
        elif name == "audios":
            _, required = _media_loader(info, "LoadAudio", "audio", "audio", 0, "AUDIO")
            if required - {"audio"}:
                raise _Blocked("incompatible_audio_loader", "LoadAudio 有未实现的必填输入")
        return names
    for name, (_, _, limit) in GROUPS.items():
        result[name] = _diagnosis(lambda name=name: modality(name), limit)
        if not result["base"]["available"]:
            result[name] = {**result["base"], "max_count": 0}
    return result


def _validate_request_layout(request, layout):
    if not isinstance(request, dict) or not isinstance(layout, dict):
        raise ValueError("preset_request 和 layout 必须是对象")
    encoded({"request": request, "layout": layout})
    if request.get("kind") != "h3_ref":
        raise ValueError("多模态参考装配仅支持 kind=h3_ref")
    if set(request) - REQUEST_FIELDS:
        raise ValueError("preset_request 包含不支持的字段：" + ", ".join(sorted(set(request) - REQUEST_FIELDS)))
    for name in ("references", "reference_roles"):
        if name in request and (not isinstance(request[name], list) or request[name]):
            raise ValueError(f"{name} 必须为空列表；素材需在新工作流节点上传或连入")
    if set(layout) != {"image_count", "videos", "audio_count"}:
        raise ValueError("layout 只允许且必须包含 image_count、videos、audio_count")
    for name, limit in (("image_count", 9), ("audio_count", 3)):
        if type(layout[name]) is not int or not 0 <= layout[name] <= limit:
            raise ValueError(f"{name} 必须为 0–{limit} 的整数")
    if not isinstance(layout["videos"], list) or len(layout["videos"]) > 3:
        raise ValueError("videos 必须为最多 3 项的列表")
    for video in layout["videos"]:
        if not isinstance(video, dict) or set(video) != {"soundtrack"} or type(video["soundtrack"]) is not bool:
            raise ValueError("每个视频槽只允许 soundtrack 布尔值，默认应显式传 false")
    if not layout["image_count"] + len(layout["videos"]) + layout["audio_count"]:
        raise ValueError("至少需要一个图片、视频或独立音频参考槽")


def prepare_h3_reference_package(request, layout, object_info):
    """Assemble a standard v1 package, never submit or materialize media."""
    _validate_request_layout(request, layout)
    if not isinstance(object_info, dict):
        raise ValueError("节点能力必须是对象")
    result = {"status": "blocked", "document": None, "blocked": [], "summary": None, "pending": []}
    try:
        counts = {"images": layout["image_count"], "videos": len(layout["videos"]), "audios": layout["audio_count"]}
        names = {modality: _group_names(object_info, modality) if count else []
                 for modality, count in counts.items()}
        names["soundtracks"] = (_group_names(object_info, "soundtracks")
                                if any(video["soundtrack"] for video in layout["videos"]) else [])
        for modality, count in counts.items():
            if count > len(names[modality]):
                raise _Blocked("reference_capacity_exceeded", f"{modality} 槽数 {count} 超过实时容量 {len(names[modality])}")
        pairings = []
        for index, video in enumerate(layout["videos"]):
            video_name = names["videos"][index]
            audio_name = "ref_video_audio_" + video_name.rsplit("_", 1)[1]
            if video["soundtrack"] and audio_name not in names["soundtracks"]:
                raise _Blocked("soundtrack_pair_unavailable", f"{video_name} 缺少同号 {audio_name}，不能猜测声轨插槽")
            pairings.append(audio_name if video["soundtrack"] else None)
        if layout["image_count"]:
            _media_loader(object_info, "LoadImage", "image", "image", 0, "IMAGE")
        if layout["audio_count"]:
            _, required = _media_loader(object_info, "LoadAudio", "audio", "audio", 0, "AUDIO")
            if required - {"audio"}:
                raise _Blocked("incompatible_audio_loader", "LoadAudio 有未实现的必填输入")
        slots = [{"port_id": f"ref_image_{index}", "index": index, "ordinal": index + 1, "role": "reference"}
                 for index in range(max(1, layout["image_count"]))]
        recipe = build_preset_editor_recipe(request, object_info if layout["image_count"] else _scaffold_info(object_info),
                                          reference_slots=slots)
        if recipe["status"] == "blocked":
            result["blocked"] = copy.deepcopy(recipe["blocked"])
            return result
        prompt = copy.deepcopy(recipe["prompt"])
        conditioning_id = next(node_id for node_id, node in prompt.items() if node["class_type"] == H3_NODE)
        inputs = prompt[conditioning_id]["inputs"]
        if not layout["image_count"]:
            removed = {node_id for node_id, node in prompt.items() if node["class_type"] == "LoadImage"}
            for key in list(inputs):
                if key.startswith("ref_images."):
                    del inputs[key]
            for node_id in removed:
                del prompt[node_id]
        labels = {}
        reference_mapping = []
        for index, (node_id, node) in enumerate((item for item in prompt.items() if item[1]["class_type"] == "LoadImage"), 1):
            labels[(node_id, "image")] = f"参考图片{index}"
            reference_mapping.append({"modality": "image", "slot": index, "node_id": node_id,
                                      "token": f"<Picture {index}>"})
        cap = min(recipe["summary"]["frames"], VIDEO_FRAMES)
        width, height = min(recipe["summary"]["width"], VIDEO_WIDTH), min(recipe["summary"]["height"], VIDEO_HEIGHT)
        loader_ids = []
        def add(class_type, values):
            node_id = str(max(map(int, prompt), default=0) + 1)
            prompt[node_id] = {"class_type": class_type, "inputs": copy.deepcopy(values)}
            return node_id
        for index, video in enumerate(layout["videos"]):
            values = _video_loader(object_info, soundtrack=video["soundtrack"], width=width, height=height, cap=cap)
            node_id = add("VHS_LoadVideo", values)
            loader_ids.append(node_id)
            labels[(node_id, "video")] = f"参考视频{index + 1}"
            inputs["ref_videos." + names["videos"][index]] = [node_id, 0]
            reference_mapping.append({"modality": "video", "slot": index + 1, "node_id": node_id,
                                      "input": "ref_videos." + names["videos"][index], "token": f"<Video {index + 1}>"})
            if pairings[index] is not None:
                inputs["ref_video_audios." + pairings[index]] = [node_id, 2]
                audio_ordinal = sum(item["soundtrack"] for item in layout["videos"][:index + 1])
                reference_mapping.append({"modality": "soundtrack", "video_slot": index + 1, "node_id": node_id,
                    "input": "ref_video_audios." + pairings[index], "token": f"<Audio {audio_ordinal}>"})
        soundtrack_count = sum(video["soundtrack"] for video in layout["videos"])
        for index in range(layout["audio_count"]):
            node_id = add("LoadAudio", {"audio": ""})
            labels[(node_id, "audio")] = f"独立音频{index + 1}"
            inputs["ref_audios." + names["audios"][index]] = [node_id, 0]
            reference_mapping.append({"modality": "audio", "slot": index + 1, "node_id": node_id,
                "input": "ref_audios." + names["audios"][index], "token": f"<Audio {soundtrack_count + index + 1}>"})
        try:
            checked = validate_editor_prompt(prompt, object_info)
            inspected = inspect_document({"prompt": prompt}, object_info)
        except (AttributeError, TypeError, ValueError) as error:
            raise _Blocked("incompatible_graph", f"最终参考图与实时节点合同不兼容：{error}") from error
        by_binding = {}
        for field in inspected["fields"]:
            binding = (field["node_id"], field["input"])
            by_binding[binding] = field
            if binding in labels:
                field.update(label=labels[binding], required=True)
            if field["node_id"] in loader_ids:
                name = field["input"]
                video_ordinal = loader_ids.index(field["node_id"]) + 1
                control_labels = {"force_rate": "固定24fps", "custom_width": "参考宽度", "custom_height": "参考高度",
                    "frame_load_cap": "读取帧数上限", "skip_first_frames": "跳过起始帧",
                    "select_every_nth": "固定逐帧读取", "format": "固定原始帧格式"}
                if name in control_labels:
                    field["label"] = f"视频{video_ordinal} · {control_labels[name]}"
                if name in {"force_rate", "select_every_nth"}:
                    field.update(min=field["default"], max=field["default"])
                elif name == "format":
                    field["options"] = ["None"]
                elif name == "frame_load_cap":
                    field.update(min=max(5, field.get("min", 5)), max=min(cap, field.get("max", cap)))
                elif name in {"custom_width", "custom_height"}:
                    bound = VIDEO_WIDTH if name == "custom_width" else VIDEO_HEIGHT
                    field.update(min=max(32, field.get("min", 32)), max=min(bound, field.get("max", bound)))
        document = normalize_document({**inspected, "format": FORMAT, "version": 1,
            "name": "H3 多模态参考工作流", "description": "纯编辑草稿。提示词引用使用 <Picture 1>、<Video 1>、<Audio 1>，各模态从 1 编号；启用的视频声轨依视频顺序先占 Audio 编号，独立音频随后编号（例如第二个视频有声、第一个无声，则声轨为 Audio 1、首个独立音频为 Audio 2）。视频按 24 fps 取帧，加载帧数不超过输出帧数与 362；明确参考宽高会中心裁切后缩放（可能放大小视频），尺寸由 VHS 对齐。视频声轨仅显式启用且源文件确有音轨时可用；素材与模型需填写后再校验生成。"})
        pending = copy.deepcopy(checked["issues"])
        if not request.get("positive", "").strip():
            pending.append({"logical_id": "positive", "code": "missing_input", "message": "正向提示词尚未填写"})
        for item in pending:
            field = by_binding.get((item.get("node_id"), item.get("input")))
            if field:
                item["field_id"] = field["id"]
        for index, video in enumerate(layout["videos"]):
            if video["soundtrack"]:
                pending.append({"code": "unverified_soundtrack", "node_id": loader_ids[index],
                    "field_id": by_binding[(loader_ids[index], "video")]["id"],
                    "message": f"参考视频{index + 1} 已启用声轨；需源文件确有音轨，装配不验证解码或声音"})
        summary = {**copy.deepcopy(recipe["summary"]), "nodes": len(prompt), "references": layout["image_count"],
            "reference_roles": ["reference"] * layout["image_count"], "layout": copy.deepcopy(layout),
            "video_count": len(loader_ids), "audio_count": layout["audio_count"], "soundtrack_count": soundtrack_count,
            "reference_mapping": reference_mapping,
            "reference_video": {"fps": 24, "frame_load_cap": cap, "width": width, "height": height, "resize": "center_crop_lanczos", "format": "None"},
            "reference_tags": {"images": [f"<Picture {i + 1}>" for i in range(layout["image_count"])],
                "videos": [f"<Video {i + 1}>" for i in range(len(loader_ids))],
                "soundtracks": [f"<Audio {i + 1}>" for i in range(soundtrack_count)],
                "audios": [f"<Audio {soundtrack_count + i + 1}>" for i in range(layout["audio_count"])]}}
        result.update(status="prepared", document=document, summary=summary, pending=pending)
        encoded(result)
    except _Blocked as error:
        result["blocked"] = [{"code": error.code, "message": str(error)}]
    except (AttributeError, TypeError) as error:
        result["blocked"] = [{"code": "incompatible_schema", "message": f"后端节点定义不兼容：{error}"}]
    return result
