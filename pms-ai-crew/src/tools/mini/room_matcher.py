"""排房引擎——确定性算法，Agent 和后台管理均可直接调用"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta


@dataclass
class Segment:
    room_type_id: str
    room_type_name: str
    check_in: str
    check_out: str
    nights: int
    price_per_night: int
    total_price: int


@dataclass
class RoomPlan:
    segments: list = field(default_factory=list)
    total_price: int = 0
    swap_count: int = 0
    score: float = 0.0


def match_rooms(
    availabilities: dict,
    room_info: dict,
    check_in: str,
    nights: int,
    max_swaps: int = 1,
) -> list:
    """
    排房算法：贪心找连续可用段 -> 同房型全程 -> 换1次 -> 换2次
    availabilities: {"rt1": [True, True, False, ...], "rt2": [...]}
    room_info: {"rt1": {"name": "海景大床房", "price_per_night": 688}}
    """
    segments_by_room = {}
    for rt_id, avail in availabilities.items():
        segs = _find_continuous_segments(avail, nights)
        if segs:
            segments_by_room[rt_id] = segs

    plans = []

    # 2. 同房型全程可用
    for rt_id, segs in segments_by_room.items():
        for seg in segs:
            if seg["start"] == 0 and seg["end"] == nights:
                info = room_info[rt_id]
                plan = RoomPlan(
                    segments=[Segment(
                        room_type_id=rt_id, room_type_name=info["name"],
                        check_in=check_in, check_out=_add_days(check_in, nights),
                        nights=nights, price_per_night=info["price_per_night"],
                        total_price=info["price_per_night"] * nights,
                    )],
                    total_price=info["price_per_night"] * nights,
                    swap_count=0, score=0,
                )
                plans.append(plan)

    # 3. 换 1 次
    if max_swaps >= 1:
        for rt1_id, segs1 in segments_by_room.items():
            for rt2_id, segs2 in segments_by_room.items():
                if rt1_id == rt2_id:
                    continue
                info1, info2 = room_info[rt1_id], room_info[rt2_id]
                for s1 in segs1:
                    if s1["end"] >= nights:
                        continue
                    for s2 in segs2:
                        if s2["start"] <= s1["end"] and s2["end"] == nights:
                            n1 = s1["end"] - s1["start"]
                            n2 = nights - s1["end"]
                            p1 = info1["price_per_night"] * n1
                            p2 = info2["price_per_night"] * n2
                            plan = RoomPlan(
                                segments=[
                                    Segment(rt1_id, info1["name"], check_in,
                                            _add_days(check_in, s1["end"]), n1,
                                            info1["price_per_night"], p1),
                                    Segment(rt2_id, info2["name"],
                                            _add_days(check_in, s1["end"]),
                                            _add_days(check_in, nights), n2,
                                            info2["price_per_night"], p2),
                                ],
                                total_price=p1 + p2, swap_count=1,
                                score=10 + abs(p1 + p2),
                            )
                            plans.append(plan)

    plans.sort(key=lambda p: p.score)
    return plans[:3]


def _find_continuous_segments(avail: list, total_nights: int) -> list:
    segs = []
    i = 0
    while i < total_nights:
        if avail[i]:
            j = i
            while j < total_nights and avail[j]:
                j += 1
            segs.append({"start": i, "end": j})
            i = j
        else:
            i += 1
    return segs


def _add_days(date: str, days: int) -> str:
    dt = datetime.strptime(date, "%Y-%m-%d")
    return (dt + timedelta(days=days)).strftime("%Y-%m-%d")
