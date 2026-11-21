from crewai import Crew, Process, Task
from src.agents.sales_manager import sales_manager_agent
from src.schemas.pricing import PricingOutput


def create_pricing_crew(merchant_id: str, store_id: str):
    pricing_task = Task(
        description=(
            "请对当前定价进行全面分析:\n"
            "1. 拉取价格日历 (get_pricing_calendar)\n"
            "2. 拉取仪表盘 KPI 了解入住率/收益 (get_dashboard_kpi)\n"
            "3. 拉取财务汇总了解近期收益趋势 (get_finance_summary)\n"
            "4. 检查渠道表现 (get_channel_performance)\n"
            "5. 参考天气和本地活动（如可用）\n\n"
            "分析维度: 当前价格 vs 入住率是否合理、是否有周末/节假日提价机会、是否有淡季降价建议\n\n"
            "输出要求:\n"
            "- 每条建议给出具体的调整金额和百分比\n"
            "- 每条建议标注置信度(0-1)和执行级别: L1(±5%以内)/L2(±5%~15%)/L3(>±15%)\n"
            "- 价格调整不得超过 ±30%（硬边界）\n"
            "- 给出总体市场分析和预期收益影响\n"
            "- 估算本月AI定价帮你多赚了多少钱\n"
        ),
        expected_output="结构化定价分析报告：市场环境分析、逐房型定价建议(当前价→建议价→理由→置信度→执行级别)、预期收益影响、本月增收估算",
        agent=sales_manager_agent,
        # 注意：不使用 output_pydantic，因为 DeepSeek 不支持 response_format JSON mode
    )
    return Crew(agents=[sales_manager_agent], tasks=[pricing_task], process=Process.sequential, verbose=True)
