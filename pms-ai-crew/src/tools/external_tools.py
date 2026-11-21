from crewai.tools import BaseTool
from src.tools.registry import ToolRegistry
from src.config import DASHSCOPE_SEARCH_MODEL, DASHSCOPE_SEARCH_URL, get_search_api_key
from typing import ClassVar
import httpx
import json
import time
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


class GetWeatherForecast(BaseTool):
    """查询指定城市近7天天气预报（基于 Open-Meteo 免费 API）"""
    name: str = "get_weather_forecast"
    description: str = "查询指定城市近7天天气预报，返回温度、天气状况、降水概率、风力等"

    # 城市坐标映射（纬度、经度）
    CITY_COORDS: ClassVar[dict] = {
        "杭州": (30.2741, 120.1551), "北京": (39.9042, 116.4074),
        "上海": (31.2304, 121.4737), "广州": (23.1291, 113.2644),
        "深圳": (22.5431, 114.0579), "成都": (30.5728, 104.0668),
        "重庆": (29.4316, 106.9123), "西安": (34.3416, 108.9398),
        "武汉": (30.5928, 114.3055), "南京": (32.0603, 118.7969),
        "苏州": (31.2990, 120.5853), "厦门": (24.4798, 118.0894),
        "昆明": (25.0389, 102.7183), "大理": (25.5895, 100.2255),
        "丽江": (26.8721, 100.2299), "三亚": (18.2528, 109.5120),
        "青岛": (36.0671, 120.3826), "大连": (38.9140, 121.6147),
        "天津": (39.3434, 117.3616), "长沙": (28.2282, 112.9388),
    }

    WEATHER_CODES: ClassVar[dict] = {
        0: "晴天", 1: "大部晴", 2: "多云", 3: "阴天",
        45: "雾", 48: "霜雾", 51: "小雨", 53: "中雨", 55: "大雨",
        61: "阵雨", 63: "中阵雨", 65: "大阵雨", 71: "小雪",
        73: "中雪", 75: "大雪", 80: "雷阵雨", 95: "雷暴", 96: "冰雹雷暴",
    }

    def _run(self, city: str = "杭州", days: int = 7) -> dict:
        coords = self.CITY_COORDS.get(city, (30.2741, 120.1551))
        lat, lon = coords
        try:
            url = (
                f"https://api.open-meteo.com/v1/forecast"
                f"?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min"
                f",weathercode,precipitation_probability_max,windspeed_10m_max"
                f"&timezone=Asia/Shanghai&forecast_days={min(days, 7)}"
            )
            resp = httpx.get(url, timeout=10.0)
            if resp.status_code == 200:
                data = resp.json()
                daily = data.get("daily", {})
                forecast = []
                times = daily.get("time", [])
                for i, date in enumerate(times):
                    code = daily.get("weathercode", [0])[i] if i < len(daily.get("weathercode", [])) else 0
                    forecast.append({
                        "date": date,
                        "weather": self.WEATHER_CODES.get(code, "未知"),
                        "temp_max": daily.get("temperature_2m_max", [0])[i] if i < len(daily.get("temperature_2m_max", [])) else 0,
                        "temp_min": daily.get("temperature_2m_min", [0])[i] if i < len(daily.get("temperature_2m_min", [])) else 0,
                        "precipitation_pct": daily.get("precipitation_probability_max", [0])[i] if i < len(daily.get("precipitation_probability_max", [])) else 0,
                        "wind_kmh": daily.get("windspeed_10m_max", [0])[i] if i < len(daily.get("windspeed_10m_max", [])) else 0,
                    })
                return {"city": city, "forecast": forecast, "source": "Open-Meteo"}
            logger.warning(f"Weather API returned {resp.status_code}")
        except Exception as e:
            logger.error(f"Weather API failed: {e}")
        return {"city": city, "forecast": [], "error": "天气数据获取失败，请稍后重试"}


class GetLocalEvents(BaseTool):
    """查询指定城市近期活动/节假日/旅游旺季信息"""
    name: str = "get_local_events"
    description: str = "查询指定城市的近期活动、节假日、旅游旺季/淡季、大型会展等信息"

    # 中国法定节假日
    HOLIDAYS: ClassVar[list] = [
        {"name": "元旦", "month": 1, "day_range": (1, 3), "type": "public_holiday"},
        {"name": "春节", "month": 1, "day_range": (25, 31), "type": "major_holiday"},
        {"name": "春节假期", "month": 2, "day_range": (1, 15), "type": "major_holiday"},
        {"name": "清明节", "month": 4, "day_range": (3, 7), "type": "public_holiday"},
        {"name": "劳动节", "month": 5, "day_range": (1, 5), "type": "major_holiday"},
        {"name": "端午节", "month": 6, "day_range": (1, 10), "type": "public_holiday"},
        {"name": "中秋节", "month": 9, "day_range": (10, 20), "type": "public_holiday"},
        {"name": "国庆节", "month": 10, "day_range": (1, 7), "type": "major_holiday"},
    ]

    # 季节性旅游节点
    SEASONAL_EVENTS: ClassVar[dict] = {
        "杭州": ["西湖荷花节(6-8月)", "钱塘江观潮(9-10月)", "西湖音乐节(5月)", "云栖大会(10月)"],
        "北京": ["樱花季(3-4月)", "香山红叶(10-11月)", "北京设计周(9月)", "国际电影节(4月)"],
        "上海": ["上海旅游节(9月)", "上海时装周(3月/10月)", "ChinaJoy(7月)", "进博会(11月)"],
        "广州": ["广交会(4月/10月)", "迎春花市(1-2月)", "广州美食节(11月)"],
        "成都": ["糖酒会(3月)", "成都车展(8月)", "成都马拉松(10月)", "大熊猫繁育季(7-9月)"],
        "三亚": ["春节旺季(1-2月)", "五一旺季(5月)", "暑期旺季(7-8月)", "国庆旺季(10月)"],
        "厦门": ["鼓浪屿音乐季(7月)", "中秋博饼节(9月)", "国际马拉松(1月)"],
        "昆明": ["樱花季(3月)", "泼水节(4月)", "石林火把节(7月)", "COP15(不定期)"],
        "大理": ["三月街(4月)", "火把节(7月)", "洱海开海节(9月)"],
        "丽江": ["纳西族三多节(3月)", "火把节(7月)", "古城音乐节(8月)"],
        "青岛": ["啤酒节(7-8月)", "樱花季(4月)", "海洋节(6-7月)"],
    }

    # 旅行旺季规律
    PEAK_SEASONS: ClassVar[str] = "旺季: 春节(1-2月)、五一(5月)、暑假(7-8月)、国庆(10月)；淡季: 春节后(3月)、五一后(6月)、国庆后(11-12月)"

    def _run(self, city: str = "杭州", days: int = 7) -> dict:
        now = datetime.now()
        current_month = now.month
        future_date = now + timedelta(days=days)

        # 匹配近期节假日
        upcoming_holidays = []
        for h in self.HOLIDAYS:
            if h["month"] == current_month or h["month"] == future_date.month:
                upcoming_holidays.append({"name": h["name"], "month": h["month"], "type": h["type"]})

        # 城市专属活动
        city_events = self.SEASONAL_EVENTS.get(city, [])
        # 过滤出当前季节的活动
        seasonal_now = []
        for evt in city_events:
            month_part = evt.split("(")[-1].replace(")", "") if "(" in evt else ""
            months_in_range = []
            for part in month_part.split("/"):
                if "-" in part:
                    try:
                        start, end = part.split("-")
                        months_in_range.extend(range(int(start.replace("月", "")), int(end.replace("月", "")) + 1))
                    except:
                        pass
                elif "月" in part:
                    try:
                        months_in_range.append(int(part.replace("月", "")))
                    except:
                        pass
            if current_month in months_in_range or (future_date.month in months_in_range and future_date.month != current_month):
                seasonal_now.append(evt)

        return {
            "city": city,
            "upcoming_holidays": upcoming_holidays,
            "seasonal_events": seasonal_now if seasonal_now else city_events[:3],
            "peak_season_info": self.PEAK_SEASONS,
            "pricing_tip": "节假日/旺季前2周开始逐步提价，淡季可通过打包套餐吸引客源",
            "source": "内置节假日数据库 + 季节性旅游数据",
        }


# 检索用的系统提示：把「不许编」写死在这里，而不是只写在 agent 的 backstory 里 ——
# 检索这一步的产出会直接进组装步的上下文，它自己先跑偏的话后面救不回来。
_SEARCH_SYSTEM = (
    "你是严谨的地方文化资料检索助手。只依据联网检索到的公开资料作答；"
    "不确定就说不确定，绝不编造。不要用检索结果之外的记忆补充具体事实。"
    "回答用简体中文，控制在 300 字以内。"
)


class SearchCultureInfo(BaseTool):
    """联网检索文化素材的公开资料，返回答案与来源列表。

    🔴 **不要 ToolRegistry.register 本类。**
    `src/agents/store_manager.py:14` 用的是 `ToolRegistry.list_all()` ⇒ **一旦注册，
    店长 agent（面向商家的前台对话）就必然拿到一个付费联网检索工具**。这不是概率事件，
    也不取决于导入顺序：`src/tools/__init__.py:2` 无条件 import 本模块，而任何走到
    `src.tools.registry` 的导入都已先执行该包的 `__init__` ⇒ 注册必定早于上面那次 `list_all()`。
    （那次 `list_all()` 又是在**导入期**求值的 —— `store_manager.py:5` 是模块级 `Agent(...)`
    —— 所以连「运行时再收窄」的机会都没有。）
    本类是给服务层**直接调 `_run()`** 用的唯一检索原语（见
    `src/services/wenlv_material_assist.py`），不参与任何 agent 的工具面。
    回归闸：`tests/test_external_tools_registry.py`。

    调用配方（原生端点 + 流式 + turbo）与三组否证实验的实测记录见
    docs/superpowers/specs/2026-09-23-wenlv-material-collect-assist-design.md §3（外层仓库）。
    """

    name: str = "search_culture_info"
    description: str = (
        "联网检索某个文化素材（历史沿革/民间传说/非遗技艺/民俗节庆/方言俚语）"
        "在公开网络上的资料，返回概括答案与来源列表"
    )

    TIMEOUT_SECONDS: ClassVar[float] = 60.0

    # 检索这一步的**处理时长上限**，自「发起请求」起算（含建连）。
    # 🔴 它**不是** `TIMEOUT_SECONDS` 的别名，两者也换不了：那个是 httpx 的 socket 超时
    #    （connect/read/write 各自计时），而**流式响应每来一个分片都会重置 read 计时**
    #    ⇒ 一个「一直吐、但吐得慢」的流能把 `TIMEOUT_SECONDS` 从头用到尾都不触发它。
    #    实测：qwen3-max 的 SSE 响应体下载 4.6~5.7s（本地一次真实请求，8.07s 请求里占掉 5.7s），
    #    生产同一请求 9~31s；而 pms-ops-app 的全局闸 `REQUEST_TIMEOUT` 是 20s
    #    ⇒ 光靠 socket 超时救不了客户端，必须在这里自己设上限。
    # 到点时**保留已收到的正文与来源**（不整次作废），并打一条 warning 说明「是被截断了，
    # 不是查无结果」—— 两种情形的正文/来源形状可能一样（甚至都是 ok:True + 一句话），
    # 所以**同时给两个信号**：日志给人看，返回值的 `truncated` 给**程序**看
    # （同族：下面 bad_chunks 的告警）。
    STREAM_BUDGET_SECONDS: ClassVar[float] = 10.0

    def _run(self, query: str = "") -> dict:
        """一次联网检索。返回 `{ok, answer, sources, error, truncated}`。

        `truncated` = **处理时长上限到了、主动提前收手**，与「公网确实查不到」是两回事。
        四条早退路径也带上它（恒 False）—— 返回值形状**统一**，调用方才能直接取键而
        不必到处写 `.get`；失败路径恰恰是最需要取键的地方，让它在失败时才 KeyError 最糟。

        ⚠️ 2026-09-24 加这个键之前，判「截断了吗」**只能**看那条 warning 日志
        ⇒ pms-ai-crew 的场地调研把 `search_log[].truncated` 恒记成 false，那是个
        「看起来答了、其实没答」的列（列在、类型对、永远 false）。改动此处要连带改
        `tests/test_external_tools_registry.py` 的三条预算用例。
        """
        q = (query or "").strip()
        if not q:
            return {"ok": False, "answer": "", "sources": [], "truncated": False,
                    "error": "检索词为空"}
        key = get_search_api_key()
        if not key:
            return {"ok": False, "answer": "", "sources": [], "truncated": False,
                    "error": "未配置联网检索密钥"}

        body = {
            "model": DASHSCOPE_SEARCH_MODEL,
            "input": {"messages": [
                {"role": "system", "content": _SEARCH_SYSTEM},
                {"role": "user", "content": q},
            ]},
            "parameters": {
                "enable_search": True,
                # turbo 是唯一可用的策略；agent / agent_max 在当前模式下 400（实测）。
                "search_options": {"enable_source": True, "search_strategy": "turbo"},
                "stream": True,
                # 🔴 不要加 incremental_output —— 传了直接 400（实测）。
            },
        }

        parts: list = []
        sources: list = []
        seen: set = set()
        bad_chunks = 0
        first_bad = ""
        # 预算自「发起请求」起算（含建连），不是自收到第一个分片起算 —— 见 STREAM_BUDGET_SECONDS。
        started = time.monotonic()
        deadline = started + self.STREAM_BUDGET_SECONDS
        truncated = False
        try:
            with httpx.stream(
                "POST", DASHSCOPE_SEARCH_URL, json=body, timeout=self.TIMEOUT_SECONDS,
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    # 🔴 缺这一行该端点**不分片**：同一份 body 会回**一个普通 JSON**
                    # （2026-09-23 实测 4087 字符，里面 search_results 有 10 条来源、
                    # message.content 有 1230 字符正文），而下面只认 `data:` 前缀
                    # ⇒ 整包被跳过 ⇒ 恒返回「检索无结果」，**功能全死而 HTTP 仍是 200**。
                    # ⚠️ `parameters.stream: true` **本身不足以**触发分片（同上实测；加本头后
                    # 同一份 body 回 712 行 / 178 个 data: 行）。回归闸：
                    # tests/test_external_tools_registry.py::test_request_carries_sse_header
                    "X-DashScope-SSE": "enable",
                },
            ) as resp:
                if resp.status_code != 200:
                    raw = resp.read().decode("utf-8", "replace")
                    logger.warning("联网检索 HTTP %s: %s", resp.status_code, raw[:300])
                    return {"ok": False, "answer": "", "sources": [], "truncated": False,
                            "error": f"检索服务返回 {resp.status_code}"}
                for line in resp.iter_lines():
                    # 超预算 ⇒ 收手，但**不丢已收到的内容**（parts/sources 照常往下走）。
                    # ⚠️ 判定放在**取到行之后、处理之前**：`iter_lines()` 是惰性的，这一行的
                    # 等待已经花掉了 ⇒ 至多丢掉「这最后一行」这一个分片。放到循环末尾能把它
                    # 省下来，但要绕开下面三个 `continue`（改起来更容易漏），不值当。
                    # ⚠️ 残余窗口（如实记下）：分片不来时判定点也就不来 —— 卡死的 socket 仍由
                    # `TIMEOUT_SECONDS` 兜底（最长 60s），本预算**不**覆盖那种情形。
                    if time.monotonic() >= deadline:
                        truncated = True
                        break
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if not chunk or chunk == "[DONE]":
                        continue
                    try:
                        d = json.loads(chunk)
                    except Exception:
                        # 不静默丢：解析不了的分片计数，循环后统一告警一条。
                        if bad_chunks == 0:
                            first_bad = chunk[:200]
                        bad_chunks += 1
                        continue
                    out = d.get("output") or {}
                    # 正文在 choices[0].message.content。
                    # 🔴 **不是** out["text"] —— 那是非流式那条路的字段，照抄会读到空。
                    for ch in (out.get("choices") or []):
                        piece = (ch.get("message") or {}).get("content") or ""
                        if piece:
                            parts.append(piece)
                    for s in ((out.get("search_info") or {}).get("search_results") or []):
                        url = (s or {}).get("url") or ""
                        if url and url not in seen:
                            seen.add(url)
                            sources.append({
                                "title": s.get("title") or "",
                                "site_name": s.get("site_name") or "",
                                "url": url,
                            })
        except Exception as e:  # 网络/超时/解析都不许穿透到调用方
            logger.error("联网检索失败: %s", e)
            return {"ok": False, "answer": "", "sources": [],
                    "truncated": truncated, "error": "联网检索失败"}

        if bad_chunks:
            logger.warning(
                "联网检索：%d 个分片无法解析（首个 %r）—— 若正文/来源缺失，先查这里",
                bad_chunks, first_bad,
            )

        if truncated:
            # 🔴 给人看的那个信号。给**程序**看的是返回值的 `truncated`（两者都要有）：
            # 两种情形的正文/来源形状可能一样（正文短/少一条来源，甚至 ok:True + 一句话），
            # 只打日志的话，调用方判态就只能去 grep 日志 —— 那不是一个能写进代码的判据。
            logger.warning(
                "联网检索：已达 %.0f 秒预算，主动截断（耗时 %.1fs，已收正文 %d 字 / 来源 %d 条）"
                " —— 结果**不完整**，不是「查无结果」",
                self.STREAM_BUDGET_SECONDS, time.monotonic() - started,
                len("".join(parts)), len(sources),
            )

        answer = "".join(parts).strip()
        if not answer and not sources:
            # 截断后一无所获 ⇒ 如实说超时。仍报「检索无结果」等于把「没查完」伪装成
            # 「公网没有」—— 上游据此走整理步，用户会以为真的查过一遍了。
            return {"ok": False, "answer": "", "sources": [], "truncated": truncated,
                    "error": "检索超时，未取到内容" if truncated else "检索无结果"}
        # ok:True 也可能是截断的（收到了半份资料）⇒ 必须带上 truncated，别让调用方从
        # 「有正文」推断「查完了」。
        return {"ok": True, "answer": answer, "sources": sources,
                "truncated": truncated, "error": ""}


# 注册工具
ToolRegistry.register(GetWeatherForecast())
ToolRegistry.register(GetLocalEvents())
