from crewai import Crew, Process, Task
from src.agents.store_manager import store_manager_agent


def create_weekly_report_crew(merchant_id: str, store_id: str):
    task = Task(
        description=(
            "请生成本周经营周报:\n"
            "1. 拉取本周核心KPI (get_dashboard_kpi)\n"
            "2. 拉取财务汇总 (get_finance_summary)\n"
            "3. 拉取渠道表现 (get_channel_performance)\n"
            "4. 拉取订单列表了解本周订单情况 (get_order_list)\n"
            "5. 对比上周数据，计算环比变化\n\n"
            "周报结构:\n"
            "- 📊 本周核心指标（收益/入住率/ADR/RevPAR + 环比变化）\n"
            "- 📈 7日趋势简述\n"
            "- 🏨 渠道表现（各渠道单量+收益占比）\n"
            "- ⚠️ 需要关注的问题\n"
            "- 💡 下周建议\n"
            "- 📝 本周AI帮你做了什么（定价优化次数、客户关怀触发次数等）"
        ),
        expected_output="一份完整的周报，包含指标对比、趋势、渠道分析、问题预警、下周建议",
        agent=store_manager_agent,
    )
    return Crew(agents=[store_manager_agent], tasks=[task], process=Process.sequential, verbose=True)


def create_monthly_report_crew(merchant_id: str, store_id: str):
    task = Task(
        description=(
            "请生成本月月度经营分析报告:\n"
            "1. 拉取本月KPI、财务、渠道、订单数据\n"
            "2. 与上月数据做环比分析\n"
            "3. 月度趋势图数据（每周汇总）\n\n"
            "月报结构:\n"
            "- 📊 月度核心指标 + 环比\n"
            "- 📈 4周趋势\n"
            "- 🏨 渠道贡献排名\n"
            "- 👤 客户分析（新增/回头客/VIP升级）\n"
            "- 💰 AI定价增收金额\n"
            "- 🎯 下月经营目标建议"
        ),
        expected_output="一份完整的月度经营分析报告，含环比数据、趋势分析、下月建议",
        agent=store_manager_agent,
    )
    return Crew(agents=[store_manager_agent], tasks=[task], process=Process.sequential, verbose=True)
