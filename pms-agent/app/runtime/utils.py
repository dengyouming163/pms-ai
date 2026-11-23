"""运行时公共小工具，避免各模块重复定义。"""
from datetime import datetime, timezone


def now_utc() -> datetime:
    """返回当前 UTC 时间（带时区），供运行/事件落库统一使用。"""
    return datetime.now(timezone.utc)
