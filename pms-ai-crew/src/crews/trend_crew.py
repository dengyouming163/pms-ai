"""热点话题采集 Crew — 每日定时生成，写入数据库"""
import logging
import httpx
from datetime import datetime
from crewai import Crew, Task
from src.agents.trend_agent import trend_agent
from src.config import PMS_SERVER_URL, INTERNAL_SERVICE_TOKEN

logger = logging.getLogger(__name__)

# 新 8 场景：核心层6个 + 流量层2个（直播方案不采集）
SCENES = {
    'room_show':  {'label': '房间展示', 'icon': '🏠', 'count': 12, 'category': 'core'},
    'talk_tips':  {'label': '口播干货', 'icon': '🎤', 'count': 12, 'category': 'core'},
    'local_play': {'label': '周边游玩', 'icon': '🌿', 'count': 12, 'category': 'core'},
    'guest_show': {'label': '客户见证', 'icon': '💬', 'count': 12, 'category': 'core'},
    'promo_deal': {'label': '活动促销', 'icon': '🎉', 'count': 12, 'category': 'core'},
    'emotion':    {'label': '情感故事', 'icon': '📖', 'count': 12, 'category': 'flow'},
    'hot_trend':  {'label': '热点借势', 'icon': '🔥', 'count': 12, 'category': 'flow'},
    'live_plan':  {'label': '直播方案', 'icon': '📡', 'count': 6,  'category': 'core'},
}

SCENE_PROMPTS = {
    'room_show': """你是民宿营销专家。请生成12个今天适合拍摄的"房间展示"话题。
要求：
- 每个话题包含具体拍摄角度和房间卖点
- 结合当季特点（夏季拍泳池/空调/避暑/星空，冬季拍地暖/温泉/雪景）
- 每行格式：标签|emoji|老板视角提示词|风格
- 标签3-5字，提示词30-80字，用"我""我家"第一人称
- 示例：无敌山景|🏠|我家这间房正对玉龙雪山，早上推窗那一刻客人都会哇一声|immersive
输出12行，覆盖story/tips/immersive/humor/promo各种风格。""",

    'talk_tips': """生成12个民宿老板今天可以讲的口播干货话题。
要求：
- 解决客人常见痛点：卫生/隔音/早餐/周边景点/省钱技巧/入住体验
- 每个话题有明确的知识点或技巧
- 每行格式：标签|emoji|老板视角提示词|风格
- 示例：除湿妙招|🎤|我家在山里潮得要命，但我用这3招让房间比城里酒店还干爽|tips
输出12行，覆盖story/tips/immersive/humor风格。""",

    'local_play': """生成12个探店/周边游玩话题，适合民宿老板带客人"云探店"。
要求：
- 具体到民宿周边的免费/小众景点、美食、体验
- 强调"从民宿出发"的便利性
- 每行格式：标签|emoji|老板视角提示词|风格
- 示例：免费瀑布|🌿|从我家民宿开车10分钟藏着个不要门票的瀑布秘境，水浅安全小孩都能玩|tips
输出12行，覆盖story/tips/immersive风格。""",

    'guest_show': """生成12个让真实客人评价"有说服力"的角度。
要求：
- 模拟真实客户好评场景和评价金句
- 可以是老板转述客人说的原话
- 每行格式：标签|emoji|老板视角提示词|风格
- 示例：客人原话|💬|昨天退房的客人说：住过这么多民宿你家床品最舒服，比五星级还好|story
输出12行，覆盖story/tips风格。""",

    'promo_deal': """生成12个促销话题，包含具体的优惠策略建议。
要求：
- 结合周末/节假日/淡旺季
- 给出具体优惠方案（折扣/赠品/套餐）
- 每行格式：标签|emoji|老板视角提示词|风格
- 示例：暑假早鸟|🎉|暑假订房打8折还送冰镇西瓜和泳池体验，连住7天更划算|promo
输出12行，覆盖promo/story风格。""",

    'emotion': """生成12个能引发共鸣的情感话题，适合民宿老板口播。
要求：
- 角度：创业感悟/人生道理/治愈故事/怀旧/梦想
- 温暖走心，不卖房不推销
- 每行格式：标签|emoji|老板视角提示词|风格
- 示例：初心不改|📖|3年前辞掉月薪2万的工作来山里开民宿，我妈哭了但我笑了。人生有几个3年可以做自己？|emotion
输出12行，风格用emotion。""",

    'live_plan': """生成6个本周适合民宿老板做直播的策划主题。
要求：
- 每个话题是可执行的完整直播策划方向，不只是简单标题
- 角度：周末特价秒杀/民宿周边云探店/节日主题活动/房间沉浸式体验/老板聊天局/美食制作
- 每行格式：标签|emoji|直播策划方向描述|风格
- 标签3-5字，描述40-100字，写出这场直播的核心看点和预期效果
- 示例：周末秒杀|📡|周五晚8点开播，限时抢购周末房，原价8折仅限直播间下单，配合红包雨和抽奖提升互动|promo
输出6行。""",

    'hot_trend': """基于近期抖音热搜、微博热搜和百度指数，生成12个适合民宿主跟拍/借势的热点话题。
要求：
- 每条包含：热点标题、民宿关联角度、跟拍建议
- 简单好模仿，30秒以内能拍完
- 每行格式：标签|emoji|跟拍提示词|风格
- 示例：MBTI人格测试|🔥|让客人猜老板是I人还是E人，猜错了送一杯手冲咖啡|story
输出12行，风格用story/humor。""",
}


def create_trend_crew(scene: str = 'room_show') -> Crew:
    """创建单个场景的热点采集 Crew"""
    now = datetime.now()
    today_str = now.strftime("%Y-%m-%d")
    month = now.month
    season = "春季" if 3 <= month <= 5 else "夏季" if 6 <= month <= 8 else "秋季" if 9 <= month <= 11 else "冬季"

    cfg = SCENES.get(scene, SCENES['room_show'])
    base_prompt = SCENE_PROMPTS.get(scene, SCENE_PROMPTS['room_show'])
    prompt = f"今天是{today_str}，{season}。\n{base_prompt}"

    task = Task(
        description=prompt,
        expected_output=f"{cfg['count']}行热点话题，每行格式：标签|emoji|提示词|风格",
        agent=trend_agent,
    )
    return Crew(agents=[trend_agent], tasks=[task], verbose=False)


async def run_trend_job(scene: str = None):
    """执行热点采集任务（全部场景），结果写入数据库"""
    scenes_to_run = [scene] if scene else list(SCENES.keys())
    logger.info(f"[TrendJob] 开始生成今日热点话题... scenes={scenes_to_run}")
    today = datetime.now().strftime("%Y-%m-%d")
    all_topics = []

    for s in scenes_to_run:
        try:
            cfg = SCENES[s]
            crew = create_trend_crew(s)
            import asyncio, time
            loop = asyncio.get_event_loop()
            start = time.time()
            result = await loop.run_in_executor(None, crew.kickoff)
            elapsed = time.time() - start
            raw = str(result)
            topics = _parse_topics(raw)
            topics = topics[:cfg['count']]
            for i, t in enumerate(topics):
                t['icon'] = t.get('icon', cfg['icon'])
                all_topics.append({'date': today, 'scene': s, 'label': t['label'], 'icon': t['icon'], 'prompt': t['prompt'], 'style': t['style'], 'source': t.get('source', 'AI生成'), 'sort_order': len(all_topics) + 1})
            logger.info(f"[TrendJob] {s}({cfg['label']}): {len(topics)}条, {elapsed:.1f}s")
        except Exception as e:
            logger.error(f"[TrendJob] {s} 采集失败: {e}")

    if all_topics:
        await _save_topics(today, all_topics, scene)
        logger.info(f"[TrendJob] 全部完成: {len(all_topics)}条热点已写入")
    else:
        logger.warning("[TrendJob] 未生成任何话题")


def _parse_topics(raw: str) -> list[dict]:
    topics = []
    for line in raw.strip().split("\n"):
        line = line.strip()
        if not line or "|" not in line: continue
        parts = line.split("|")
        if len(parts) < 4: continue
        topics.append({'label': parts[0].strip()[:20], 'icon': parts[1].strip()[:5], 'prompt': parts[2].strip()[:200], 'style': parts[3].strip()[:20], 'source': parts[4].strip()[:50] if len(parts) > 4 else 'AI生成'})
    return topics


async def _save_topics(date_str: str, topics: list[dict], scene: str = None):
    import uuid
    payload = {
        "date": date_str,
        "scene": scene,  # 按场景覆盖（不传则全量替换）
        "topics": [{"id": f"ht_{date_str.replace('-','')}_{uuid.uuid4().hex[:6]}", "date": date_str, "scene": t['scene'], "label": t['label'], "icon": t['icon'], "prompt": t['prompt'], "style": t['style'], "source": t['source'], "sort_order": i} for i, t in enumerate(topics)],
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{PMS_SERVER_URL}/api/internal/ai-tools/hot-topics/save",
                json=payload, headers={"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN},
            )
            if resp.status_code != 200:
                logger.error(f"[TrendJob] 写入失败: {resp.status_code} {resp.text}")
    except Exception as e:
        logger.error(f"[TrendJob] 写入请求失败: {e}")
