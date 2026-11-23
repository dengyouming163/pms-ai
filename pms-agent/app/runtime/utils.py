"""运行时公共小工具，避免各模块重复定义。"""
from datetime import datetime, timedelta, timezone

# 业务时区：定价与房态按「上海本地日」计算，避免容器 UTC 造成日期偏移
SHANGHAI_TZ = timezone(timedelta(hours=8))


def now_utc() -> datetime:
    """返回当前 UTC 时间（带时区），供运行/事件落库统一使用。"""
    return datetime.now(timezone.utc)


def tomorrow_local() -> str:
    """返回上海时区「明天」的日期（YYYY-MM-DD）。

    revenue 子图默认针对明天做收益决策（价格需提前设置），
    只传日期不传时间，且在 prompt 中被剔除，不影响回放指纹稳定性。
    """
    return (datetime.now(SHANGHAI_TZ).date() + timedelta(days=1)).isoformat()

