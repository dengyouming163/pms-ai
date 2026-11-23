"""评测运行器：逐条跑回放用例，计算八项指标，与基线对比并输出报告。

设计要点（离线、确定、可回归）：
- 不连库、不连网、不需要 LLM key：tools 用用例内声明的假数据，
  provider 用用例内声明的 model_output，图本身只依赖 MemorySaver。
- 每条用例独立 thread_id + 独立 MemorySaver，互不污染。
- 回放确定性：同一用例集跑两次，指标必须完全一致。
- 门禁：退出码 0 通过 / 1 指标退化 / 2 条件漂移（用例集或夹具变化，无法与原基线比较）。

运行（仓库根目录）：
    pms-agent\\.venv\\Scripts\\python.exe -m eval.run_eval --suite revenue
    pms-agent\\.venv\\Scripts\\python.exe -m eval.run_eval --suite ops --write-baseline
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = REPO_ROOT / "pms-agent"
# 评测脚本在仓库根运行，但图/节点在 pms-agent 下，需要把该目录加入 sys.path
if str(AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENT_ROOT))

from langgraph.types import Command  # noqa: E402

from app.graph.build import build_graph  # noqa: E402
from eval.metrics import mean, percentile, routing_accuracy, tool_f1  # noqa: E402

# ---- 常量 ----
MODEL = "deepseek-chat"
DEFAULT_TENANT = {"merchant_id": "demo-yunqi", "store_id": "store-yunqi-qingyan"}
# 基线与门槛（规格 §11.2 / §11.3）；基线按套件独立，避免新增套件让旧套件假漂移
BASELINE_DATE = "2026-11-21"
THRESHOLDS = {
    "routing_accuracy": 0.95,
    "tool_f1": 0.90,
    "task_success_rate": 0.90,
    "avg_steps": 8.0,
    "cost_cny": 0.05,
    "block_rate": 1.0,
    "approval_accuracy": 1.0,
    "p95_latency_ms": 45000.0,
}
# 回放无真实计费，用统一 token 单价折算人民币：¥0.002 / 1K tokens
TOKEN_PRICE_CNY_PER_1K = 0.002
SCRIPTED_USAGE = {"prompt_tokens": 320, "completion_tokens": 96, "total_tokens": 416}
RATE_TOLERANCE = 0.02       # 比率类指标允许相对基线退化的绝对幅度
COST_LATENCY_TOLERANCE = 0.2  # 步数/成本/延迟允许相对基线退化的比例

DEFAULT_TOOL_DATA = {
    "pricing-calendar": {
        "ok": True,
        "data": {
            "date": "2026-11-24",
            "items": [{
                "roomTypeId": "rt-yq-qy-01",
                "roomTypeName": "栖云大床房",
                "price": 428,
                "basePrice": 400,
                "available": 3,
            }],
        },
    },
    "occupancy": {"ok": True, "data": {"occupancyRate": 78, "total": 40, "occupied": 31, "booked": 2}},
    "competitor-prices": {
        "ok": True,
        "data": {"avgPrice": 470, "count": 4, "items": [{"hotelName": "云栖竞品A", "price": 468}]},
    },
    "channel-performance": {"ok": True, "data": {"orderCount": 12, "revenue": 5136, "items": []}},
    "finance-summary": {
        "ok": True,
        "data": {
            "month": "2026-11",
            "revenue": 128760,
            "adr": 428,
            "revpar": 312,
            "occupancyRate": 72,
            "orderCount": 301,
            "nights": 301,
            "roomCount": 40,
            "daysInMonth": 30,
        },
    },
    # 默认评价数据为「干净」：无低分、无待回复，避免污染非评价类用例的晨报
    "reviews-summary": {
        "ok": True,
        "data": {
            "days": 30,
            "from": "2026-10-23",
            "total": 0,
            "avgRating": 0,
            "lowRatingCount": 0,
            "pendingReplyCount": 0,
            "items": [],
        },
    },
    # 默认知识库命中一条 WiFi 条目；转人工用例会覆盖为空列表或声明工具失败
    "kb-search": {
        "ok": True,
        "data": {
            "q": "wifi",
            "tokens": ["wifi"],
            "count": 1,
            "items": [{
                "id": "kb-default-wifi",
                "title": "WiFi 与网络",
                "content": "WiFi 名称：Yunqi-Qingyan，密码：yunqi2026；网络故障可拨打前台 0851-86880101。",
                "guideType": "faq",
            }],
        },
    },
}


# ---- 假工具 / 假模型 ----
class CaseTools:
    """按用例声明的数据返回工具结果，并记录调用序列（供工具 F1 / 越权检查）。

    - tool_errors 中的工具：记录调用后抛 RuntimeError（模拟工具报错，验证单路失败不拖垮主流程）
    - price_adjust：本地模拟 pms-server 护栏（超 30% / 非正数 / 与当前价相同 → guard_rejected）
    """

    def __init__(self, case: dict):
        self.calls: list[str] = []
        data = copy.deepcopy(DEFAULT_TOOL_DATA)
        for name, override in (case.get("tool_data") or {}).items():
            data[name] = override
        self.data = data
        self.errors = set(case.get("tool_errors") or ())
        constraints = case.get("constraints") or {}
        self.max_delta_pct = float(constraints.get("max_price_delta_pct", 30))
        self.executed: list[dict] = []

    def _hit(self, name: str) -> dict:
        self.calls.append(name)
        if name in self.errors:
            raise RuntimeError(f"{name} 模拟工具失败")
        return copy.deepcopy(self.data[name])

    async def pricing_calendar(self, tenant, date=None, room_type_id=None):
        return self._hit("pricing-calendar")

    async def occupancy(self, tenant, date=None):
        return self._hit("occupancy")

    async def competitor_prices(self, tenant, room_type_id=None, date=None):
        return self._hit("competitor-prices")

    async def channel_performance(self, tenant, date_from=None, date_to=None):
        return self._hit("channel-performance")

    async def finance_summary(self, tenant, month=None):
        return self._hit("finance-summary")

    async def reviews_summary(self, tenant, days=30):
        return self._hit("reviews-summary")

    async def kb_search(self, tenant, query):
        return self._hit("kb-search")

    async def price_adjust(self, tenant, proposal, approval_id=None):
        self.calls.append("price-adjust")
        params = proposal.get("params") or {}
        current = params.get("expectedCurrentPrice")
        next_price = params.get("nextPrice")
        guard_rejected = {"ok": False, "error": "guard_rejected", "guard_rejected": True}
        if not isinstance(current, (int, float)) or not isinstance(next_price, (int, float)):
            return guard_rejected
        if next_price <= 0 or next_price == current:
            return guard_rejected
        if abs(next_price - current) / current * 100 > self.max_delta_pct:
            return guard_rejected
        self.executed.append({"proposal_id": proposal.get("proposal_id"), "price": next_price})
        return {"ok": True, "data": {"price": next_price}}


class ScriptedProvider:
    """固定返回用例声明的 model_output，并统计 token（回放确定性）。"""

    def __init__(self, model_output: list[dict]):
        self.content = json.dumps(model_output, ensure_ascii=False)
        self.calls = 0
        self.total_tokens = 0

    async def complete(self, model: str, prompt: str) -> dict:
        self.calls += 1
        self.total_tokens += SCRIPTED_USAGE["total_tokens"]
        return {"content": self.content, "usage": dict(SCRIPTED_USAGE)}


# ---- 图执行 ----
async def _consume(stream, counter: dict) -> bool:
    """消费 astream(updates)，统计节点步数，返回本次是否发生中断。"""
    interrupted = False
    async for chunk in stream:
        if not isinstance(chunk, dict):
            continue
        for node in chunk:
            if node == "__interrupt__":
                interrupted = True
            else:
                counter["steps"] += 1
    return interrupted


async def run_case(case: dict) -> dict:
    """跑一条用例：首次执行 →（必要时）审批恢复 → 汇总期望对比。"""
    tools = CaseTools(case)
    provider = ScriptedProvider(case.get("model_output") or [])
    graph = build_graph(provider=provider, tools=tools, model=MODEL)
    run_id = f"eval-{case['id']}"
    config = {"configurable": {"thread_id": run_id}}
    state = {
        "run_id": run_id,
        "tenant": case.get("tenant") or DEFAULT_TENANT,
        "goal": case["goal"],
        "messages": [],
    }
    counter = {"steps": 0}
    started = time.perf_counter()
    error = None
    interrupted = False
    resumed = False
    values: dict = {}
    try:
        interrupted = await _consume(
            graph.astream(state, config=config, stream_mode="updates"), counter,
        )
        decision = case.get("approval")
        if interrupted and decision in ("approve", "reject"):
            resume_payload = {
                "decision": decision,
                "reason": f"eval-{decision}",
                "approval_id": f"appr-{case['id']}",
            }
            await _consume(
                graph.astream(Command(resume=resume_payload), config=config, stream_mode="updates"),
                counter,
            )
            resumed = True
        snapshot = await graph.aget_state(config)
        values = dict(snapshot.values or {})
    except Exception as exc:  # 单条用例异常不终止整轮评测，但计入失败
        error = f"{type(exc).__name__}: {exc}"
    latency_ms = (time.perf_counter() - started) * 1000

    actual_route = values.get("route") or "unknown"
    if interrupted and not resumed:
        actual_execution = "awaiting_approval"
    else:
        actual_execution = values.get("execution_status") or "none"
    forbid_hit = [name for name in (case.get("forbid_tools") or []) if name in tools.calls]
    expect_approval = bool(case.get("expect_approval", False))
    approval_correct = interrupted == expect_approval
    route_ok = actual_route == case["expect_route"]
    execution_ok = actual_execution == case.get("expect_execution", "none")
    final_text = values.get("final") or ""
    expect_final_contains = case.get("expect_final_contains") or []
    final_contains_ok = all(token in final_text for token in expect_final_contains)
    f1 = tool_f1(case.get("expect_tools") or [], tools.calls)
    cost_cny = provider.total_tokens / 1000 * TOKEN_PRICE_CNY_PER_1K

    success = bool(
        route_ok and not forbid_hit and approval_correct and execution_ok
        and final_contains_ok and not error
    )
    return {
        "id": case["id"],
        "tags": case.get("tags") or [],
        "goal": case["goal"],
        "expect_route": case["expect_route"],
        "actual_route": actual_route,
        "expect_tools": case.get("expect_tools") or [],
        "actual_tools": sorted(set(tools.calls)),
        "tool_f1": f1,
        "expect_approval": expect_approval,
        "interrupted": interrupted,
        "approval_correct": approval_correct,
        "expect_execution": case.get("expect_execution", "none"),
        "actual_execution": actual_execution,
        "expect_final_contains": expect_final_contains,
        "final_contains_ok": final_contains_ok,
        "forbid_hit": forbid_hit,
        "steps": counter["steps"],
        "tokens": provider.total_tokens,
        "cost_cny": cost_cny,
        "latency_ms": latency_ms,
        "success": success,
        "error": error,
    }


# ---- 指纹 / 基线 / 报告 ----
def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def cases_sha256(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def fixtures_sha256(fixtures_dir: Path) -> str:
    """对夹具目录下所有 *.jsonl（按文件名排序，含文件名）求哈希。"""
    digest = hashlib.sha256()
    if fixtures_dir.exists():
        for path in sorted(fixtures_dir.glob("*.jsonl")):
            digest.update(path.name.encode("utf-8"))
            digest.update(path.read_bytes())
    return digest.hexdigest()


def load_cases(path: Path) -> list[dict]:
    cases = []
    with path.open("r", encoding="utf-8") as f:
        for lineno, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"用例文件第 {lineno} 行不是合法 JSON：{exc}") from exc
            for key in ("id", "goal", "expect_route"):
                if key not in case:
                    raise SystemExit(f"用例文件第 {lineno} 行缺少必需字段 {key}")
            cases.append(case)
    return cases


def aggregate(results: list[dict]) -> dict:
    """汇总八项指标；block_rate 只统计声明了 forbid_tools 的用例（无此类用例视为满分）。"""
    forbid_results = [r for r in results if r["has_forbid"]]
    block_rate = (
        mean([0.0 if r["forbid_hit"] else 1.0 for r in forbid_results])
        if forbid_results else 1.0
    )
    return {
        "routing_accuracy": routing_accuracy(
            [(r["actual_route"], r["expect_route"]) for r in results]
        ),
        "tool_f1": mean([r["tool_f1"] for r in results]),
        "task_success_rate": mean([1.0 if r["success"] else 0.0 for r in results]),
        "avg_steps": mean([r["steps"] for r in results]),
        "cost_cny": mean([r["cost_cny"] for r in results]),
        "block_rate": block_rate,
        "approval_accuracy": mean([1.0 if r["approval_correct"] else 0.0 for r in results]),
        "p95_latency_ms": percentile([r["latency_ms"] for r in results], 95),
    }


def compare_with_baseline(baseline: dict, metrics: dict) -> list[str]:
    """返回退化项描述列表；空列表表示达标。"""
    problems: list[str] = []
    base_metrics = baseline.get("metrics") or {}
    for key in ("routing_accuracy", "tool_f1", "task_success_rate", "block_rate", "approval_accuracy"):
        floor = float(THRESHOLDS[key])
        if metrics[key] + 1e-9 < floor:
            problems.append(f"{key}={metrics[key]:.4f} 低于门槛 {floor:.2f}")
        if key in base_metrics and metrics[key] + 1e-9 < float(base_metrics[key]) - RATE_TOLERANCE:
            problems.append(
                f"{key}={metrics[key]:.4f} 较基线 {float(base_metrics[key]):.4f} "
                f"退化超过 {RATE_TOLERANCE:.0%}"
            )
    for key in ("avg_steps", "cost_cny", "p95_latency_ms"):
        ceiling = float(THRESHOLDS[key])
        if metrics[key] > ceiling + 1e-9:
            problems.append(f"{key}={metrics[key]:.4f} 超过门槛 {ceiling}")
        if key in base_metrics:
            # 延迟基数极小（回放毫秒级），相对波动无意义：取 1s 作为退化判断的绝对下限
            limit = float(base_metrics[key]) * (1 + COST_LATENCY_TOLERANCE)
            if key == "p95_latency_ms":
                limit = max(limit, 1000.0)
            if metrics[key] > limit:
                problems.append(
                    f"{key}={metrics[key]:.4f} 较基线 {float(base_metrics[key]):.4f} "
                    f"恶化超过 {COST_LATENCY_TOLERANCE:.0%}"
                )
    return problems


def baseline_filename(suite: str) -> str:
    """基线文件按套件命名：新增套件不会让既有套件的基线因 cases 指纹变化而漂移。"""
    return f"{suite}-{BASELINE_DATE}.json"


def render_markdown(suite: str, payload: dict, baseline: dict | None, problems: list[str]) -> str:
    metrics = payload["metrics"]
    base_metrics = (baseline or {}).get("metrics") or {}
    verdict = "PASS" if not problems else "FAIL"
    lines = [
        f"# 评测报告：{suite}",
        "",
        f"- 生成时间：{payload['generated_at']}",
        f"- 用例数：{len(payload['results'])}",
        f"- 基线：{baseline_filename(suite)}（cases {payload['cases_sha256'][:12]}…，fixtures {payload['fixtures_sha256'][:12]}…）",
        f"- 结论：**{verdict}**",
        "",
        "| 指标 | 当前 | 门槛 | 基线 |",
        "|---|---|---|---|",
    ]
    for key, threshold in THRESHOLDS.items():
        base = base_metrics.get(key)
        base_text = f"{base:.4f}" if isinstance(base, (int, float)) else "—"
        lines.append(f"| {key} | {metrics[key]:.4f} | {threshold} | {base_text} |")
    if problems:
        lines += ["", "## 退化项", ""]
        lines += [f"- {p}" for p in problems]
    lines += [
        "",
        "## 用例明细",
        "",
        "| 用例 | 标签 | 路由 | 工具 F1 | 中断 | 终态 | 步数 | 耗时(ms) | 结果 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in payload["results"]:
        tags = ",".join(r["tags"])
        mark = "PASS" if r["success"] else "FAIL"
        if r["error"]:
            mark += f"（{r['error']}）"
        lines.append(
            f"| {r['id']} | {tags} | {r['actual_route']}/{r['expect_route']} | "
            f"{r['tool_f1']:.2f} | {r['interrupted']} | {r['actual_execution']} | "
            f"{r['steps']} | {r['latency_ms']:.0f} | {mark} |"
        )
    return "\n".join(lines) + "\n"


# ---- 主流程 ----
async def _run_suite(args) -> int:
    cases_path = Path(args.cases_dir) / f"{args.suite}.jsonl"
    fixtures_dir = Path(args.fixtures_dir)
    baselines_dir = Path(args.baselines_dir)
    reports_dir = Path(args.reports_dir)
    if not cases_path.exists():
        print(f"用例文件不存在：{cases_path}", file=sys.stderr)
        return 2

    cases = load_cases(cases_path)
    results = [await run_case(case) for case in cases]
    # has_forbid 只用于 block_rate 分母：用例声明了 forbid_tools 才计入拦截率
    for case, result in zip(cases, results):
        result["has_forbid"] = bool(case.get("forbid_tools"))
    metrics = aggregate(results)
    payload = {
        "suite": args.suite,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "cases_sha256": cases_sha256(cases_path),
        "fixtures_sha256": fixtures_sha256(fixtures_dir),
        "metrics": metrics,
        "results": results,
    }

    baseline_path = baselines_dir / baseline_filename(args.suite)
    baseline = None
    problems: list[str] = []
    drift: list[str] = []
    if baseline_path.exists():
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        if baseline.get("cases_sha256") != payload["cases_sha256"]:
            drift.append("用例集与基线不一致（cases_sha256 不同）")
        if baseline.get("fixtures_sha256") != payload["fixtures_sha256"]:
            drift.append("回放夹具与基线不一致（fixtures_sha256 不同）")

    exit_code = 0
    if drift:
        problems = drift
        exit_code = 2
    elif baseline is not None:
        problems = compare_with_baseline(baseline, metrics)
        exit_code = 0 if not problems else 1

    # 写报告（无论通过与否）
    reports_dir.mkdir(parents=True, exist_ok=True)
    (reports_dir / "latest.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    (reports_dir / "latest.md").write_text(
        render_markdown(args.suite, payload, baseline, problems), encoding="utf-8",
    )

    if args.write_baseline:
        baselines_dir.mkdir(parents=True, exist_ok=True)
        baseline_payload = {**payload, "thresholds": THRESHOLDS}
        baseline_path.write_text(
            json.dumps(baseline_payload, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        print(f"已写入基线：{baseline_path}")
        exit_code = 0
    elif drift:
        print("条件漂移，无法与原基线比较：", file=sys.stderr)
        for item in drift:
            print(f"  - {item}", file=sys.stderr)
    elif problems:
        print("评测未达标：", file=sys.stderr)
        for item in problems:
            print(f"  - {item}", file=sys.stderr)

    print(f"suite={args.suite} cases={len(results)} exit={exit_code}")
    for key, value in metrics.items():
        print(f"  {key}={value:.4f}")
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description="pms-ai 离线评测运行器")
    parser.add_argument("--suite", default="revenue", help="用例集名（对应 eval/cases/<suite>.jsonl）")
    parser.add_argument("--write-baseline", action="store_true", help="写入基线文件（覆盖）")
    parser.add_argument("--cases-dir", default=str(REPO_ROOT / "eval" / "cases"))
    parser.add_argument("--fixtures-dir", default=str(REPO_ROOT / "eval" / "fixtures"))
    parser.add_argument("--baselines-dir", default=str(REPO_ROOT / "eval" / "baselines"))
    parser.add_argument("--reports-dir", default=str(REPO_ROOT / "eval" / "reports"))
    args = parser.parse_args()
    return asyncio.run(_run_suite(args))


if __name__ == "__main__":
    sys.exit(main())
