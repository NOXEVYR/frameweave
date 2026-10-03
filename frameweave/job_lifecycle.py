"""Job terminal evidence and cancellation intent shared by every client surface."""
import math
import time
import uuid

TERMINAL = frozenset({"completed", "failed", "cancelled"})
CANCEL_PENDING = frozenset({"requesting", "requested", "uncertain"})
CANCEL_STATES = CANCEL_PENDING | {"unavailable", "confirmed", "completed", "failed"}


def cancellation_record(value):
    if not isinstance(value, dict) or set(value) != {"id", "state", "method", "requested_at", "updated_at", "message"}:
        raise ValueError("取消记录格式无效")
    try:
        if str(uuid.UUID(value["id"])) != value["id"]:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ValueError("取消记录身份无效") from None
    if (value["state"] not in CANCEL_STATES or value["method"] not in {None, "job_scoped", "queue_delete"}
            or not isinstance(value["message"], str) or len(value["message"]) > 1000):
        raise ValueError("取消记录状态无效")
    for field in ("requested_at", "updated_at"):
        if type(value[field]) not in (int, float) or not math.isfinite(value[field]) or value[field] < 0:
            raise ValueError("取消记录时间无效")
    return dict(value)


def new_cancellation():
    now = time.time()
    return {"id": str(uuid.uuid4()), "state": "requesting", "method": None,
            "requested_at": now, "updated_at": now,
            "message": "正在请求取消；任务仍需等待原引擎确认。"}


def cancel_state(job, state, message, method=None):
    if not isinstance(job.get("cancellation"), dict):
        return
    job["cancellation"].update(state=state, message=message, updated_at=time.time())
    if method:
        job["cancellation"]["method"] = method


def history_outcome(job_id, item):
    """A queue absence, websocket event or cancel acknowledgement is not terminal."""
    status = item.get("status", {}) if isinstance(item, dict) else {}
    if not isinstance(status, dict):
        return None
    messages = status.get("messages", [])
    if not isinstance(messages, list):
        messages = []
    interrupted = any(isinstance(message, (list, tuple)) and len(message) == 2
                      and message[0] == "execution_interrupted" and isinstance(message[1], dict)
                      and message[1].get("prompt_id") == job_id for message in messages)
    if status.get("status_str") == "error":
        return "cancelled" if interrupted else "failed"
    if status.get("completed") is True:
        return "completed"
    return None


def has_terminal_evidence(job):
    evidence = job.get("terminal_evidence", {})
    return isinstance(evidence, dict) and evidence == {
        "source": "history", "backend": job.get("backend"),
        "job_id": job.get("id"), "status": job.get("status")}


def terminal_observed(job, outcome):
    job.update(status=outcome, progress=100 if outcome == "completed" else None,
               finished_at=time.time(), terminal_evidence={"source": "history", "backend": job["backend"],
                                                         "job_id": job["id"], "status": outcome})
    job.pop("status_warning", None)
    job.pop("queue_position", None)
    if outcome != "failed":
        job.pop("error", None)
    cancel_state(job, {"cancelled": "confirmed", "completed": "completed", "failed": "failed"}[outcome],
                 {"cancelled": "原引擎已确认此任务中断，原参数和已保存产物保留。",
                  "completed": "原引擎确认任务已完成，取消未阻止本次生成；产物已保留。",
                  "failed": "原引擎确认任务失败，请查看执行错误；不能归因为取消成功。"}[outcome])
