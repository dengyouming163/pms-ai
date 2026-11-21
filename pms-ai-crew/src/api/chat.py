import json
import time
import asyncio
import re
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from src.memory.store import PmsMemoryStore
from openai import AsyncOpenAI
from src.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, get_active_config

router = APIRouter()

# 请求队列 — 允许排队等待而非直接拒绝
_executor_queue: asyncio.Queue = asyncio.Queue(maxsize=10)
_processing = False


async def _process_queue():
    """后台消费者：逐个处理队列中的请求"""
    global _processing
    while True:
        fn, event = await _executor_queue.get()
        try:
            await fn()
        except Exception:
            pass
        finally:
            event.set()
            _executor_queue.task_done()


async def generate_sse_events(message: str, history: list, merchant_id: str, store_id: str, user_id: str, request_context: str):
    # 使用 asyncio.Queue 实现实时流式推送
    event_queue: asyncio.Queue = asyncio.Queue()
    done_event = asyncio.Event()

    async def worker():
        try:
            await _process_message(message, history, merchant_id, store_id, user_id, request_context, event_queue)
        except Exception as e:
            await event_queue.put(f"event: error\ndata: {json.dumps({'error': str(e), 'retry': True})}\n\n")
        finally:
            done_event.set()

    # 加入请求队列
    try:
        await asyncio.wait_for(
            _executor_queue.put((worker, done_event)),
            timeout=5.0
        )
    except asyncio.TimeoutError:
        yield f"event: agent_start\ndata: {json.dumps({'agent': '系统', 'action': '排队超时，请稍后重试'})}\n\n"
        yield f"event: done\ndata: {json.dumps({'summary': '当前请求过多，请稍后再试'})}\n\n"
        return

    # 实时读取队列中的事件并流式输出
    while not done_event.is_set() or not event_queue.empty():
        try:
            chunk = await asyncio.wait_for(event_queue.get(), timeout=0.1)
            yield chunk
        except asyncio.TimeoutError:
            continue


async def _process_message(message: str, history: list, merchant_id: str, store_id: str, user_id: str, request_context: str, out: asyncio.Queue):
    """实际的消息处理逻辑，通过 out 队列实时推送 SSE 事件"""
    start_time = time.time()
    memory = PmsMemoryStore(merchant_id, user_id)

    user_prefs = memory.load_user_prefs()
    prefs_context = (
        f"老板的定价风格偏好: {user_prefs.get('pricing_style', 'balanced')}。"
        f"沟通风格偏好: {user_prefs.get('communication_style', 'detailed')}。"
    )

    INTENT_KEYWORDS = {
        "tts": ["TTS", "语音合成", "配音优化", "口播优化", "SSML", "声音优化", "语音优化"],
        "sales": ["定价", "调价", "RevPAR", "ADR", "卖房", "空房", "收益", "竞品价格", "价格", "房价"],
        "ota": ["渠道", "携程", "美团", "飞猪", "途家", "OTA", "评价回复", "库存同步", "佣金", "订单来源"],
        "xhs": ["小红书", "种草笔记", "笔记文案", "爆款笔记", "涨粉攻略", "博主合作", "XHS", "种草"],
        "video": ["拍短视频", "视频脚本", "拍摄方案", "口播文案", "口播脚本", "短视频"],
        "customer": ["客户", "会员", "VIP", "优惠券", "复购率", "回头客", "关怀", "沉睡"],
        "ops": ["房态", "清洁", "打扫", "维修", "脏房", "入住", "退房", "巡检", "异常"],
        "content_plan": ["内容日历", "内容策划", "周历", "一周话题", "话题日历"],
        "mini": ["排房", "订房", "选房", "推荐房间", "入住", "多少钱", "有房吗", "可以住", "民宿", "酒店介绍", "周边", "附近", "怎么去", "你好", "在吗"],
    }

    # 前端可通过 context 字段显式指定路由，优先级高于关键词匹配
    if request_context == "mini":
        intent = "mini"
    else:
        intent = "general"
        for key, keywords in INTENT_KEYWORDS.items():
            if any(kw in message for kw in keywords):
                intent = key
                break

    # 路由到对应的 Agent/Crew
    if intent == "sales":
        from src.crews.pricing_crew import create_pricing_crew
        crew = create_pricing_crew(merchant_id, store_id)
        agent_name = "销售经理"
        action_text = "正在分析定价数据和渠道佣金..."
    elif intent == "customer":
        from src.agents.customer_steward import customer_steward_agent
        from crewai import Crew, Process, Task
        from src.tools.registry import ToolRegistry
        # 注入商户/门店上下文到工具实例
        for name in customer_steward_agent.tools:
            tool = ToolRegistry.get(name) if isinstance(name, str) else name
            if tool and hasattr(tool, 'merchant_id'):
                tool.merchant_id = merchant_id
                tool.store_id = store_id
        crew = Crew(
            agents=[customer_steward_agent],
            tasks=[Task(description=(
                f"老板的问题: {message}\n\n"
                "你可以使用以下工具来获取真实数据并执行操作:\n"
                "- search_customers / list_customers: 搜索和列出客户\n"
                "- get_customer_profile: 获取客户详细画像和订单历史\n"
                "- get_customer_stats: 获取客户统计数据\n"
                "- add_customer_tag: 给客户打标签\n"
                "- upgrade_vip: 升级会员等级\n"
                "- send_coupon: 发优惠券\n"
                "- create_care_reminder: 创建关怀提醒\n"
                "- send_notification: 发送通知\n\n"
                "务必先调用读工具查询数据，再基于真实数据给出分析和操作建议。"
            ), expected_output="基于真实数据的客户分析报告", agent=customer_steward_agent)],
            process=Process.sequential,
        )
        agent_name = "客户管家"
        action_text = "正在查询客户画像和消费记录..."
    elif intent == "ops":
        from src.agents.ops_manager import ops_manager_agent
        from crewai import Crew, Process, Task
        from src.tools.registry import ToolRegistry
        for name in ops_manager_agent.tools:
            tool = ToolRegistry.get(name) if isinstance(name, str) else name
            if tool and hasattr(tool, 'merchant_id'):
                tool.merchant_id = merchant_id
                tool.store_id = store_id
        crew = Crew(
            agents=[ops_manager_agent],
            tasks=[Task(description=(
                f"老板的问题: {message}\n\n"
                "你可以使用以下工具来获取真实数据并执行操作:\n"
                "- scan_daily_briefing: 获取今日运营全貌（入住/退房/脏房/超时订单）\n"
                "- get_room_status: 获取房态数据\n"
                "- get_housekeeping_queue: 获取待清洁队列\n"
                "- get_order_list: 获取订单列表\n"
                "- check_in_guest/check_out_guest: 办理入住/退房\n"
                "- create_cleaning_task/assign_cleaning_task/complete_cleaning_task: 清洁管理\n"
                "- confirm_order/cancel_order: 订单确认/取消\n"
                "- create_maintenance_task: 创建维修工单\n"
                "- book_room: 预订房间\n\n"
                "务必先调用读工具查询数据，再基于真实数据给出分析和操作建议。"
            ), expected_output="基于真实数据的运营处理结果", agent=ops_manager_agent)],
            process=Process.sequential,
        )
        agent_name = "运营管家"
        action_text = "正在检查房态和运营数据..."
    elif intent == "ota":
        from src.agents.ota_expert import ota_expert_agent
        from crewai import Crew, Process, Task
        from src.tools.registry import ToolRegistry
        for name in ota_expert_agent.tools:
            tool = ToolRegistry.get(name) if isinstance(name, str) else name
            if tool and hasattr(tool, 'merchant_id'):
                tool.merchant_id = merchant_id
                tool.store_id = store_id
        crew = Crew(
            agents=[ota_expert_agent],
            tasks=[Task(description=(
                f"老板关于OTA运营的问题: {message}\n\n"
                "你可以使用以下工具获取数据:\n"
                "- get_channel_performance: 各渠道订单量和收益对比\n"
                "- get_order_list: 订单列表查询\n"
                "- get_dashboard_kpi: 经营核心KPI\n"
                "- get_pricing_calendar: 价格日历\n"
                "- get_competitor_prices: 竞品价格\n\n"
                "请先调用工具查询真实数据，再给出具体可执行的运营建议。"
            ), expected_output="OTA运营分析和行动建议", agent=ota_expert_agent)],
            process=Process.sequential,
        )
        agent_name = "OTA运营专家"
        action_text = "正在拉取多渠道数据做对比分析..."
    elif intent == "xhs":
        from src.agents.xhs_expert import xhs_expert_agent
        from crewai import Crew, Process, Task
        crew = Crew(
            agents=[xhs_expert_agent],
            tasks=[Task(description=f"老板需要小红书内容: {message}\n请以小红书博主口吻，生成一篇吸引人的种草笔记，包括标题、正文、话题标签。", expected_output="小红书种草笔记（标题+正文+标签）", agent=xhs_expert_agent)],
            process=Process.sequential,
        )
        agent_name = "小红书运营"
        action_text = "正在构思种草笔记..."
    elif intent == "video":
        from src.agents.video_expert import video_expert_agent
        from crewai import Crew, Process, Task
        crew = Crew(
            agents=[video_expert_agent],
            tasks=[Task(description=f"老板需要短视频内容: {message}\n请生成: 1)口播脚本 2)拍摄场景建议 3)话题标签 4)最佳发布时间。口语化，易执行。", expected_output="短视频拍摄方案（脚本+场景+标签+时间）", agent=video_expert_agent)],
            process=Process.sequential,
        )
        agent_name = "短视频运营"
        action_text = "正在策划拍摄方案和脚本..."
    elif intent == "content_plan":
        from datetime import datetime
        from src.crews.content_planning_crew import create_content_planning_crew
        crew = create_content_planning_crew(merchant_id, store_id, datetime.now().strftime("%Y-%m-%d"))
        agent_name = "内容策划师"
        action_text = "正在分析天气/节假日/房态，策划一周内容日历..."
    elif intent == "mini":
        from src.crews.mini_concierge_crew import create_mini_concierge_crew
        crew = create_mini_concierge_crew(message)
        agent_name = "AI 管家"
        action_text = "正在为你查找最优排房方案..."
    elif intent == "tts":
        # TTS 语音优化：直接调用 LLM，不经过 CrewAI Agent
        from src.config import create_llm
        llm = create_llm(temperature=0.3, max_tokens=2000)
        agent_name = "语音优化师"
        action_text = "正在优化口播文案为语音合成格式..."
        # 同步调用 LLM 并在 executor 中运行
        crew = None  # 标记为直接 LLM 调用
    else:
        # 通用对话：直接调用 LLM，不使用 CrewAI Agent（避免 JSON mode 兼容问题）
        from src.config import create_llm
        llm = create_llm(temperature=0.7, max_tokens=2000)
        agent_name = "智能助手"
        action_text = "正在理解你的需求..."
        crew = None  # 标记为直接 LLM 调用

    await out.put(f"event: agent_start\ndata: {json.dumps({'agent': agent_name, 'action': action_text})}\n\n")

    try:
        loop = asyncio.get_event_loop()

        is_streaming = False  # 标记是否已在上面做了真流式输出
        output_text = ""       # 提前声明，两个分支共用

        if crew is None and intent in ("tts", "general"):
            # 真流式：使用 AsyncOpenAI 直连 DeepSeek，token 级别实时输出
            raw_message = f"{prefs_context}\n\n用户消息：{message}"
            history_context = "\n".join(
                [f"{h['role']}: {h['content'][:200]}" for h in history[-3:]]
            ) if history else ""
            full_prompt = f"{history_context}\n{raw_message}" if history_context else raw_message

            model_cfg = get_active_config()
            client = AsyncOpenAI(api_key=model_cfg["api_key"], base_url=model_cfg["base_url"])
            stream = await client.chat.completions.create(
                model=model_cfg["model"],
                messages=[{"role": "user", "content": full_prompt}],
                temperature=0.7 if intent == "general" else 0.3,
                max_tokens=2000,
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices and chunk.choices[0].delta else ""
                if delta:
                    output_text += delta
                    await out.put(f"event: token\ndata: {json.dumps({'text': delta})}\n\n")
            if not output_text:
                output_text = "抱歉，处理过程中出现了问题，请重试。"
            is_streaming = True
        else:
            # CrewAI Agent 路径：同步执行，用进度提示避免"卡住"感
            async def run_with_progress():
                nonlocal output_text
                loop = asyncio.get_event_loop()
                # 启动一个后台任务定期发送进度
                progress_task = None
                progress_msgs = [
                    "正在分析数据...", "正在查找相关信息...", "正在生成回复...",
                    "马上就好...", "正在整理结果..."
                ]
                msg_idx = 0

                async def send_progress():
                    nonlocal msg_idx
                    while not crew_done[0]:
                        await out.put(f"event: agent_start\ndata: {json.dumps({'agent': agent_name, 'action': progress_msgs[msg_idx % len(progress_msgs)]})}\n\n")
                        msg_idx += 1
                        await asyncio.sleep(1.5)

                crew_done = [False]
                progress_task = asyncio.create_task(send_progress())
                try:
                    result = await loop.run_in_executor(None, crew.kickoff)
                    output_text = str(result)
                finally:
                    crew_done[0] = True
                    if progress_task:
                        progress_task.cancel()
                        try: await progress_task
                        except asyncio.CancelledError: pass

            await run_with_progress()

        elapsed_ms = int((time.time() - start_time) * 1000)

        # Agent 路径：按句子切分模拟流式；通用/tts 路径已是真流式，跳过
        if not is_streaming:
            sentences = re.split(r'(?<=[。！？\n])', output_text)
            sentences = [s for s in sentences if s.strip()]
            for sentence in sentences:
                delay = 0.1 if len(sentence) > 80 else 0.05
                await out.put(f"event: token\ndata: {json.dumps({'text': sentence})}\n\n")
                await asyncio.sleep(delay)

        # 保存完整对话记忆
        memory.save("long_term", f"chat_{int(time.time())}", {
            "message": message,
            "response_summary": output_text[:800],
            "agent": agent_name,
            "intent": intent,
            "elapsed_ms": elapsed_ms,
            "timestamp": time.time(),
        })

        # 结构化摘要（用于前端渲染）
        summary_data = {"summary": output_text, "elapsed_total_ms": elapsed_ms, "agent": agent_name, "intent": intent}
        # 尝试提取结构化数据
        price_match = re.findall(r'(\d+)[元块]\D*?(\d+)[元块]', output_text)
        if price_match and intent in ("sales", "pricing"):
            try:
                summary_data["structured"] = {
                    "type": "pricing",
                    "price_changes": [{"current": int(p[0]), "suggested": int(p[1])} for p in price_match[:5]]
                }
            except:
                pass
        tag_match = re.findall(r'#(\w+)', output_text)
        if tag_match and intent in ("xhs", "video"):
            summary_data["structured"] = {"type": "social", "tags": tag_match[:10]}

        await out.put(f"event: done\ndata: {json.dumps(summary_data)}\n\n")

    except Exception as e:
        await out.put(f"event: error\ndata: {json.dumps({'error': str(e), 'retry': True})}\n\n")

    return


@router.post("/chat")
async def chat(request: Request):
    body = await request.json()
    message = body.get("message", "")
    history = body.get("history", [])
    request_context = body.get("context", "")
    merchant_id = request.headers.get("X-Merchant-Id", "default")
    store_id = request.headers.get("X-Store-Id", "default_store")
    user_id = request.headers.get("X-User-Id", "")

    if not message:
        return StreamingResponse(
            iter([f"event: error\ndata: {json.dumps({'error': '请输入消息'})}\n\n"]),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )

    # 队列满时返回友好提示
    if _executor_queue.full():
        async def busy_stream():
            yield f"event: agent_start\ndata: {json.dumps({'agent': '系统', 'action': '当前请求较多'})}\n\n"
            yield f"event: token\ndata: {json.dumps({'text': '⏳ 当前有较多分析任务排队中（最多10个），请稍等10-20秒再试。AI 正在全力为你工作中...'})}\n\n"
            yield f"event: done\ndata: {json.dumps({'summary': '请稍后重试'})}\n\n"
        return StreamingResponse(busy_stream(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    return StreamingResponse(
        generate_sse_events(message, history, merchant_id, store_id, user_id, request_context),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
