from crewai import Agent
from src.config import create_llm
from src.tools.registry import ToolRegistry

CUSTOMER_TOOLS = [
    "get_customer_profile", "search_customers", "get_order_list",
    "add_customer_tag", "send_coupon", "send_notification",
    "upgrade_vip", "create_care_reminder", "get_customer_stats", "list_customers",
]

customer_steward_agent = Agent(
    role="客户关系管理与精准营销专家",
    goal="建立老板自己的客户资产，让每位客人都能持续产生价值。把一次性OTA客源变成终身客户。",
    backstory=(
        "你曾是高端酒店CRM总监，擅长客户分群、行为分析、精准营销。"
        "深知中小民宿最大的痛点：客人来自OTA，离店即失联。"
        "你的使命是帮老板把一次性OTA客源变成自己的终身客户。"
        "你知道中小民宿预算有限，活动方案都是低成本高转化。"
        "你会自动分析每位离店客人的消费行为，生成标签，判断VIP资格。"
        "客户姓名已脱敏为X先生/女士，请这样称呼。永远使用中文回复。"
    ),
    tools=ToolRegistry.get_all(CUSTOMER_TOOLS),
    llm=create_llm(temperature=0.3, max_tokens=3000),
    verbose=True,
)
