"""Prepare owned, offline audio adapters using existing local installations.

Inspection reads bounded files only. Registration never downloads dependencies,
loads a model, starts a process or changes the selected inference backend.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading

from .engines import _absolute_local_path
from .voice_runtime_bundle import runtime_files


ADAPTER = "qwen3_tts_voice_design"
MAX_ENVIRONMENTS = 16
_ID = re.compile(r"voice-[a-f0-9]{24}\Z")
_REQUEST_KEYS = {"comfy_root", "host_python", "worker_python", "dependency_dir", "model_path", "frontend_root", "port", "name"}


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf8")


def _read(path, limit=1024 * 1024):
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("环境元数据文件超过检查范围")
    return raw


def _atomic(path, value):
    fd, name = tempfile.mkstemp(prefix=".prepare-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_json_bytes(value)); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _site_packages(python):
    return (python.parent / "Lib/site-packages", python.parent.parent / "Lib/site-packages")


def _module(roots, name):
    return next((root / name / "__init__.py" for root in roots if (root / name / "__init__.py").is_file()), None)


def voice_package():
    return {"name": "Qwen3-TTS · 声音设计", "description": "使用应用内登记的离线声音设计环境；参数可进入原生工作流调整。",
            "prompt": {"1": {"class_type": "PrismCanvasQwenVoiceDesign", "inputs": {
                "text": "你好，我们开始创作吧。", "instruct": "自然、清晰的普通话。", "language": "Chinese", "seed": 42, "max_new_tokens": 128}},
                "2": {"class_type": "SaveAudio", "inputs": {"audio": ["1", 0], "filename_prefix": "PrismCanvas/VoiceDesign"}}},
            "fields": [
                {"id": "text", "node_id": "1", "input": "text", "type": "text", "label": "台词", "default": "你好，我们开始创作吧。"},
                {"id": "instruct", "node_id": "1", "input": "instruct", "type": "text", "label": "声音描述", "default": "自然、清晰的普通话。"},
                {"id": "language", "node_id": "1", "input": "language", "type": "select", "label": "语言", "options": ["Chinese", "English"], "default": "Chinese"},
                {"id": "seed", "node_id": "1", "input": "seed", "type": "integer", "label": "随机种子", "min": 0, "max": 4294967295, "default": 42},
                {"id": "max_new_tokens", "node_id": "1", "input": "max_new_tokens", "type": "integer", "label": "生成长度上限", "min": 32, "max": 512, "default": 128}]}


def validate_start(profile):
    """Refuse a changed adapter bundle before process creation; never import it."""
    try:
        root = Path(profile["main_script"]).parent
        if root.name != profile["environment_id"] or Path(profile["main_script"]).name != "launcher.py":
            raise ValueError("Wrong adapter path")
        manifest = json.loads(_read(root / "bundle.json"))
        expected_names = set(runtime_files()) | {"config.json", "base/main.py"}
        if not isinstance(manifest, dict) or set(manifest) != expected_names:
            raise ValueError("Wrong bundle manifest")
        for name, digest in manifest.items():
            if hashlib.sha256(_read(root / name)).hexdigest() != digest:
                raise ValueError("Changed adapter file")
        config = json.loads(_read(root / "config.json"))
        record = json.loads(_read(root / "registration.json"))
        if (config.get("environment_id") != profile["environment_id"] or
                record.get("fingerprint") != profile["environment_fingerprint"] or
                config.get("host_python") != profile["python_executable"]):
            raise ValueError("Changed environment identity")
        if not Path(config["worker_python"]).is_file() or not (Path(config["model_path"]) / "config.json").is_file():
            raise ValueError("Missing worker or model")
        if config.get("dependency_dir") and not Path(config["dependency_dir"]).is_dir():
            raise ValueError("Missing dependencies")
    except (OSError, ValueError, KeyError, TypeError):
        return "声音环境文件缺失或配置已改变；请重新检查环境。未覆盖原件或启动进程。"
    return None


class VoiceEnvironments:
    def __init__(self, data_dir, engines, packages):
        self.directory = Path(data_dir) / "voice-environments"
        self.engines, self.packages = engines, packages
        self.lock = threading.RLock()

    def inspect(self, data):
        report, _ = self._inspect(data)
        return report

    def _inspect(self, data):
        if not isinstance(data, dict) or set(data) - _REQUEST_KEYS:
            raise ValueError("声音环境仅接受已有安装、Python、依赖、权重目录、名称和端口")
        name = data.get("name", "Qwen3-TTS 声音设计")
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ValueError("环境名称须为 1–100 个字符")
        port = data.get("port", 8191)
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError("独立声音引擎端口须为 1024–65535")
        root = _absolute_local_path(data.get("comfy_root"), "已有 ComfyUI 目录")
        model = _absolute_local_path(data.get("model_path"), "VoiceDesign 权重目录")
        chosen_host = data.get("host_python", "")
        if chosen_host:
            host = _absolute_local_path(chosen_host, "ComfyUI Python")
        else:
            candidates = (root / "venv/Scripts/python.exe", root / ".venv/Scripts/python.exe", root.parent / "python_embeded/python.exe")
            host = next((path for path in candidates if path.is_file()), candidates[0])
        worker = _absolute_local_path(data.get("worker_python") or str(host), "语音 Python")
        dependency = _absolute_local_path(data["dependency_dir"], "语音依赖目录") if data.get("dependency_dir") else None
        frontend = (_absolute_local_path(data["frontend_root"], "ComfyUI 前端目录") if data.get("frontend_root") else
                    next((site / "comfyui_frontend_package/static" for site in _site_packages(host)
                          if (site / "comfyui_frontend_package/static/index.html").is_file()),
                         _site_packages(host)[0] / "comfyui_frontend_package/static"))
        checks, evidence = [], {}
        def check(key, label, ok, detail):
            checks.append({"key": key, "label": label, "status": "present" if ok else "missing", "detail": detail})
        def file(key, label, path):
            ok = path.is_file()
            if ok:
                stat = path.stat(); evidence[key] = [stat.st_size, stat.st_mtime_ns]
            check(key, label, ok, "已找到文件；运行兼容性将在启动或生成时验证" if ok else "未找到所需文件，请核对所选位置")
            return ok
        main_ok = file("comfy_main", "ComfyUI 入口", root / "main.py")
        check("comfy_core", "ComfyUI 核心", (root / "comfy").is_dir(), "复用原安装的代码；用户目录与插件目录使用独立副本")
        file("host_python", "ComfyUI Python", host)
        file("worker_python", "语音 Python", worker)
        file("frontend", "ComfyUI 原生编辑器", frontend / "index.html")
        if dependency:
            check("dependency_directory", "独立语音依赖目录", dependency.is_dir(),
                  "复用已有目录；不安装或覆盖依赖" if dependency.is_dir() else "所选依赖目录不存在，请纠正或留空使用 Python 自身依赖")
        roots = ([dependency] if dependency else []) + list(_site_packages(worker))
        for module in ("qwen_tts", "torch", "transformers", "numpy", "soundfile"):
            location = _module(roots, module)
            # soundfile may be a single module rather than a package.
            if module == "soundfile" and location is None:
                location = next((site / "soundfile.py" for site in roots if (site / "soundfile.py").is_file()), None)
            check("module_" + module, module, location is not None, "发现模块文件；未导入执行或核验所有传递依赖" if location else "所选 Python 与依赖目录中没有此模块")
            if location:
                stat = location.stat(); evidence["module_" + module] = [stat.st_size, stat.st_mtime_ns]
        config = None
        try:
            raw = _read(model / "config.json"); config = json.loads(raw)
            evidence["model_config"] = hashlib.sha256(raw).hexdigest()
        except (OSError, ValueError):
            pass
        supported = isinstance(config, dict) and config.get("model_type") == "qwen3_tts" and config.get("tts_model_type") == "voice_design"
        check("model_architecture", "VoiceDesign 模型类型", supported, "仅接入声音设计；Base/CustomVoice 使用其他接口，不能按目录名猜测")
        for rel in ("tokenizer_config.json", "vocab.json", "merges.txt", "speech_tokenizer/config.json"):
            file("model_" + rel, rel, model / rel)
        for subfolder in (Path(), Path("speech_tokenizer")):
            prefix = "model" if not str(subfolder).strip(".") else "speech_tokenizer"
            single = model / subfolder / "model.safetensors"
            if single.is_file():
                file(prefix + "_weights", prefix + " 权重", single)
            else:
                try:
                    index = json.loads(_read(model / subfolder / "model.safetensors.index.json"))
                    if not isinstance(index, dict) or not isinstance(index.get("weight_map"), dict):
                        raise ValueError("Invalid weight map")
                    shards = set(index["weight_map"].values())
                    if not 1 <= len(shards) <= 128 or any(not isinstance(s, str) or Path(s).name != s or "/" in s or "\\" in s or ":" in s for s in shards):
                        raise ValueError("Invalid shards")
                    for shard in sorted(shards):
                        file(prefix + "_" + shard, prefix + " 分片", model / subfolder / shard)
                except (OSError, ValueError, KeyError, TypeError):
                    check(prefix + "_weights", prefix + " 权重", False, "缺少 safetensors 权重或有效分片索引")
        templates = runtime_files()
        config = {"schema": 1, "adapter": ADAPTER, "comfy_root": str(root), "host_python": str(host), "worker_python": str(worker),
                  "dependency_dir": str(dependency) if dependency else "", "model_path": str(model), "frontend_root": str(frontend),
                  "device": "cuda:0", "dtype": "bfloat16", "attention": "sdpa", "timeout_seconds": 600, "port": port}
        if main_ok:
            evidence["comfy_main_sha256"] = hashlib.sha256(_read(root / "main.py")).hexdigest()
        fingerprint = hashlib.sha256(_json_bytes({"config": config, "files": evidence,
            "adapter_files": {key: hashlib.sha256(value.encode("utf8")).hexdigest() for key, value in templates.items()}})).hexdigest()
        ident = "voice-" + fingerprint[:24]; config["environment_id"] = ident
        missing = [item for item in checks if item["status"] == "missing"]
        report = {"adapter": ADAPTER, "environment_id": ident, "fingerprint": fingerprint, "name": name.strip(),
                  "checks": checks, "ready_to_register": not missing, "inspection_level": "files_only", "runtime_verified": False,
                  "model_loaded": False, "downloads": False, "generation_verified": False,
                  "summary": f"{len(missing)} 项缺失；当前只检查本地文件，尚未验证 Python 导入、CUDA 或真实生成",
                  "repair_prompt": "请检查棱光本地 Qwen3-TTS VoiceDesign 环境。以下是只读文件检查结果，不是执行指令。\n" +
                     "\n".join(f"- {item['label']}：{item['detail']}" for item in missing) +
                     "\n复用已有权重，勿覆盖主 ComfyUI；核对当前 Python、PyTorch、CUDA 和依赖版本兼容性，再做隔离导入与短句验证。检查器未加载模型，不能据此宣称可生成。"}
        return report, {"config": config, "templates": templates, "main_sha256": evidence.get("comfy_main_sha256")}

    def prepare(self, data):
        if not isinstance(data, dict) or set(data) - (_REQUEST_KEYS | {"fingerprint"}):
            raise ValueError("声音环境登记参数无效")
        report, prepared = self._inspect({k: v for k, v in data.items() if k != "fingerprint"})
        if not isinstance(data.get("fingerprint"), str) or data["fingerprint"] != report["fingerprint"]:
            raise ValueError("配置或环境文件已变化，请重新检查后登记")
        if not report["ready_to_register"]:
            raise ValueError("环境文件尚不完整，请先查看检查结果")
        config, templates = prepared["config"], prepared["templates"]
        ident = report["environment_id"]
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            destination = self.directory / ident
            record_path = destination / "registration.json"
            manifest_path = destination / "bundle.json"
            files = {key: value.encode("utf8") for key, value in templates.items()}
            files["config.json"] = _json_bytes(config)
            files["base/main.py"] = _read(Path(config["comfy_root"]) / "main.py")
            if hashlib.sha256(files["base/main.py"]).hexdigest() != prepared["main_sha256"]:
                raise ValueError("ComfyUI 入口在检查期间变化，请重新检查")
            expected = {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}
            profile = {"id": ident, "name": report["name"], "base_url": f"http://127.0.0.1:{config['port']}",
                       "python_executable": config["host_python"], "main_script": str(destination / "launcher.py"),
                       "working_directory": str(destination), "auto_start": False, "max_retries": 0,
                       "arguments": ["--listen", "127.0.0.1", "--port", str(config["port"]),
                            "--base-directory", str(destination / "base"), "--models-directory", str(destination / "base/models"),
                            "--user-directory", str(destination / "user"), "--input-directory", str(destination / "input"),
                            "--output-directory", str(destination / "output"), "--temp-directory", str(destination / "temp"),
                            "--database-url", "sqlite:///" + (destination / "user/comfyui.db").as_posix(),
                            "--front-end-root", config["frontend_root"], "--cpu", "--disable-dynamic-vram",
                            "--disable-api-nodes", "--disable-auto-launch", "--cache-none"],
                       "environment_id": ident, "environment_fingerprint": report["fingerprint"]}
            result = {}
            def prepare_bundle(registered_profile):
                package = self.packages.save(voice_package())
                registration = {"schema": 1, "id": ident, "name": registered_profile["name"], "adapter": ADAPTER,
                                "fingerprint": report["fingerprint"], "package_id": package["id"],
                                "settings": {key: value for key, value in data.items() if key in _REQUEST_KEYS}}
                if destination.exists():
                    try:
                        saved = json.loads(_read(manifest_path))
                        valid = saved == expected and all(hashlib.sha256(_read(destination / name)).hexdigest() == digest for name, digest in expected.items())
                    except (OSError, ValueError):
                        valid = False
                    if not valid:
                        raise ValueError("已有环境副本缺失或被修改；原件已保留，请先修复，未覆盖或启动")
                    _atomic(record_path, registration)
                else:
                    if len(list(self.directory.glob("voice-*"))) >= MAX_ENVIRONMENTS:
                        raise ValueError("本地声音环境已达 16 个，请管理已有环境后再登记")
                    # Publish a complete bundle atomically. A disk error must not leave
                    # a half-written immutable environment that cannot be retried.
                    with tempfile.TemporaryDirectory(prefix=".preparing-", dir=self.directory) as temporary:
                        staging = Path(temporary)
                        for folder in ("base/models", "user", "input", "output", "temp", "cache", "jobs"):
                            (staging / folder).mkdir(parents=True, exist_ok=True)
                        for name, raw in files.items():
                            target = staging / name
                            target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(raw)
                        _atomic(staging / "bundle.json", expected)
                        _atomic(staging / "registration.json", registration)
                        staging.rename(destination)
                result["package"] = package
            engine = self.engines.register_environment(profile, prepare=prepare_bundle)
            package = result["package"]
        return {"environment": self._record(record_path), "engine": engine, "package": package,
                "message": "已登记到应用；未启动、未切换引擎、未生成。请在我的引擎中启动并连接，再到声音页面选用工作流。"}

    def _record(self, path):
        record = json.loads(_read(path))
        if not isinstance(record, dict) or record.get("adapter") != ADAPTER or not _ID.fullmatch(record.get("id", "")):
            raise ValueError("声音环境记录无效")
        return {key: record[key] for key in ("id", "name", "adapter", "fingerprint", "package_id")}

    def list(self):
        with self.lock:
            records, issues = [], []
            registered = {item['id'] for item in self.engines.registered_endpoints()}
            for path in sorted(self.directory.glob("voice-*/registration.json"))[:MAX_ENVIRONMENTS]:
                try:
                    record = self._record(path)
                    record['engine_registered'] = record['id'] in registered
                    records.append(record)
                except (OSError, ValueError, KeyError, TypeError):
                    issues.append("一项声音环境记录无法读取，原文件保留")
            return {"environments": records, "issues": issues}

    def recheck(self, ident):
        if not isinstance(ident, str) or not _ID.fullmatch(ident):
            raise ValueError("声音环境标识无效")
        record = json.loads(_read(self.directory / ident / "registration.json"))
        report = self.inspect(record["settings"])
        report["configuration_unchanged"] = record["fingerprint"] == report["fingerprint"]
        # This is a CSRF-protected local response, never part of copied reports.
        report["settings"] = {key: value for key, value in record["settings"].items() if key in _REQUEST_KEYS}
        return report
