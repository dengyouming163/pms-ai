from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from datetime import datetime, timedelta
import logging
import asyncio
import time
import httpx

from src.config import PMS_SERVER_URL, INTERNAL_SERVICE_TOKEN

logger = logging.getLogger(__name__)
scheduler = AsyncIOScheduler()


async def get_active_tenants() -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{PMS_SERVER_URL}/api/internal/ai-tools/tenants/active",
                headers={"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN}
            )
            if resp.status_code == 200:
                return resp.json().get("tenants", [])
    except Exception as e:
        logger.error(f"获取活跃租户失败: {e}")
    return [{"merchant_id": "default", "store_id": "default_store"}]


async def daily_pricing_job():
    """每天早上8:03为所有活跃租户生成定价建议"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        logger.info(f"[Cron] 定价: {mid}/{sid}")
        try:
            from src.crews.pricing_crew import create_pricing_crew
            crew = create_pricing_crew(mid, sid)
            loop = asyncio.get_event_loop()
            start = time.time()
            await loop.run_in_executor(None, crew.kickoff)
            elapsed = int((time.time() - start) * 1000)
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(f"{PMS_SERVER_URL}/api/internal/ai-tools/metrics/sync",
                        headers={"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN, "Content-Type": "application/json"},
                        json={"merchant_id": mid, "agent": "收益管理师", "crew": "pricing_crew", "latency_ms": elapsed, "insight_generated": True})
            except:
                pass
        except Exception as e:
            logger.error(f"[Cron] 定价失败 {mid}/{sid}: {e}")


async def daily_customer_check_job():
    """每天早上9:00为所有活跃租户检测昨日离店客人"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        logger.info(f"[Cron] 客户检测: {mid}/{sid}")
        try:
            from src.tools.registry import ToolRegistry
            order_tool = ToolRegistry.get("get_order_list")
            if order_tool:
                # order_tool needs merchant/store context injected
                setattr(order_tool, '_override_scope', {'merchantId': mid, 'storeId': sid})
                yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
                result = order_tool._run(status="checked_out", date_from=yesterday, date_to=yesterday)
                total = result.get('pagination', {}).get('total', 0)
                logger.info(f"[Cron] {mid}/{sid}: 检测到 {total} 位昨日离店客人")
        except Exception as e:
            logger.error(f"[Cron] 客户检测失败 {mid}/{sid}: {e}")


async def housekeeping_check_job():
    """每小时为所有活跃租户执行房务巡检"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        logger.info(f"[Cron] 房务巡检: {mid}/{sid}")
        try:
            from src.crews.housekeeping_crew import create_housekeeping_check_crew
            crew = create_housekeeping_check_crew(mid, sid)
            loop = asyncio.get_event_loop()
            start = time.time()
            await loop.run_in_executor(None, crew.kickoff)
            elapsed = int((time.time() - start) * 1000)
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(f"{PMS_SERVER_URL}/api/internal/ai-tools/metrics/sync",
                        headers={"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN, "Content-Type": "application/json"},
                        json={"merchant_id": mid, "agent": "房务巡检员", "crew": "housekeeping_crew", "latency_ms": elapsed, "insight_generated": True})
            except:
                pass
        except Exception as e:
            logger.error(f"[Cron] 房务巡检失败 {mid}/{sid}: {e}")


async def weekly_report_job():
    """每周一为所有活跃租户生成周报"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        logger.info(f"[Cron] 周报: {mid}/{sid}")
        try:
            from src.crews.weekly_report_crew import create_weekly_report_crew
            crew = create_weekly_report_crew(mid, sid)
            loop = asyncio.get_event_loop()
            start = time.time()
            await loop.run_in_executor(None, crew.kickoff)
            elapsed = int((time.time() - start) * 1000)
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(f"{PMS_SERVER_URL}/api/internal/ai-tools/metrics/sync",
                        headers={"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN, "Content-Type": "application/json"},
                        json={"merchant_id": mid, "agent": "周报生成", "crew": "weekly_report_crew", "latency_ms": elapsed, "insight_generated": True})
            except:
                pass
        except Exception as e:
            logger.error(f"[Cron] 周报生成失败 {mid}/{sid}: {e}")


async def monthly_report_job():
    """每月1日为所有活跃租户生成月报"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        logger.info(f"[Cron] 月报: {mid}/{sid}")
        try:
            from src.crews.weekly_report_crew import create_monthly_report_crew
            crew = create_monthly_report_crew(mid, sid)
            loop = asyncio.get_event_loop()
            start = time.time()
            await loop.run_in_executor(None, crew.kickoff)
            elapsed = int((time.time() - start) * 1000)
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(f"{PMS_SERVER_URL}/api/internal/ai-tools/metrics/sync",
                        headers={"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN, "Content-Type": "application/json"},
                        json={"merchant_id": mid, "agent": "月报生成", "crew": "monthly_report_crew", "latency_ms": elapsed, "insight_generated": True})
            except:
                pass
        except Exception as e:
            logger.error(f"[Cron] 月报生成失败 {mid}/{sid}: {e}")


async def ota_check_job():
    """每15分钟: OTA超时订单检测"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        try:
            from src.agents.ota_expert import ota_expert_agent
            from crewai import Crew, Process, Task
            crew = Crew(
                agents=[ota_expert_agent],
                tasks=[Task(description="检查所有渠道是否有超时未确认的订单，如有立即生成预警通知。同时检查各平台评价状态。", expected_output="OTA巡检结果", agent=ota_expert_agent)],
                process=Process.sequential,
            )
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, crew.kickoff)
        except Exception as e:
            logger.error(f"[Cron] OTA巡检失败 {mid}/{sid}: {e}")

async def ota_evening_job():
    """每天18:00: 尾房甩卖检查"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        try:
            from src.agents.ota_expert import ota_expert_agent
            from crewai import Crew, Process, Task
            crew = Crew(
                agents=[ota_expert_agent],
                tasks=[Task(description="现在是傍晚18点，检查今晚还有哪些空房。如果有空房，建议立即在美团/抖音/朋友圈做尾房甩卖（降价20-30%），避免空房过夜。", expected_output="尾房甩卖建议", agent=ota_expert_agent)],
                process=Process.sequential,
            )
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, crew.kickoff)
        except Exception as e:
            logger.error(f"[Cron] 尾房检查失败 {mid}/{sid}: {e}")

async def ai_pricing_generate_job():
    """每天早上6:00为所有门店生成14天AI定价记录"""
    tenants = await get_active_tenants()
    for t in tenants:
        mid, sid = t["merchant_id"], t["store_id"]
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{PMS_SERVER_URL}/api/ai-pricing/generate-all",
                    headers={"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN, "X-Store-Id": sid, "Content-Type": "application/json"},
                    json={}
                )
                if resp.status_code == 200:
                    data = resp.json()
                    logger.info(f"[Cron] AI定价: {mid}/{sid} 生成 {data.get('data',{}).get('total',0)} 条记录")
        except Exception as e:
            logger.error(f"[Cron] AI定价失败 {mid}/{sid}: {e}")

async def daily_trend_job():
    """每天 16:03 为7个场景生成当日热点话题（不采集直播方案）"""
    from src.crews.trend_crew import run_trend_job
    try:
        await run_trend_job()  # 不传 scene，自动跑全部 7 个场景
        logger.info("[Cron] 全部场景热点话题已生成（房间/干货/周边/见证/促销/情感/热点）")
    except Exception as e:
        logger.error(f"[Cron] 热点采集失败: {e}")


def start_scheduler():
    scheduler.add_job(ai_pricing_generate_job, CronTrigger(hour=6, minute=0), id="ai_pricing_generate", replace_existing=True)
    scheduler.add_job(daily_pricing_job, CronTrigger(hour=8, minute=3), id="daily_pricing", replace_existing=True)
    scheduler.add_job(daily_customer_check_job, CronTrigger(hour=9, minute=3), id="daily_customer", replace_existing=True)
    scheduler.add_job(housekeeping_check_job, CronTrigger(hour='*', minute=0), id="housekeeping_hourly", replace_existing=True)
    scheduler.add_job(weekly_report_job, CronTrigger(day_of_week='mon', hour=8, minute=15), id="weekly_report", replace_existing=True)
    scheduler.add_job(monthly_report_job, CronTrigger(day=1, hour=8, minute=30), id="monthly_report", replace_existing=True)
    scheduler.add_job(ota_check_job, CronTrigger(minute='*/15'), id="ota_check_15min", replace_existing=True)
    scheduler.add_job(ota_evening_job, CronTrigger(hour=18, minute=0), id="ota_evening", replace_existing=True)
    scheduler.add_job(daily_trend_job, CronTrigger(hour=0, minute=5), id="daily_trend", replace_existing=True)
    scheduler.start()
    logger.info("Scheduler started with pricing + customer care + housekeeping + weekly/monthly report + OTA check + OTA evening + Trend jobs")


def shutdown_scheduler():
    scheduler.shutdown()
    logger.info("Scheduler stopped")
