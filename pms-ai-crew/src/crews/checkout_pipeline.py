from crewai import Crew, Process, Task
from src.agents.customer_steward import customer_steward_agent


def create_checkout_care_crew(merchant_id: str, store_id: str, customer_id: str, order_id: str):
    analysis_task = Task(
        description=(
            f"客人已退房。订单ID: {order_id}。客户ID: {customer_id}。\n\n"
            "请执行以下流程:\n"
            f"1. 拉取客户画像获取消费记录 (get_customer_profile, customer_id={customer_id})\n"
            "2. 拉取该客户的最近订单 (get_order_list)\n"
            "3. 分析消费行为: 入住天数、消费金额、房型偏好、特殊需求\n"
            "4. 生成智能标签: 如'商务出行'、'亲子旅游'、'高消费'、'偏好高楼层'等\n"
            "5. 判断VIP资格: 累计消费≥4次或总消费≥¥5,000 → 建议升级VIP\n"
            "6. 检测是否需要特殊关怀: 生日/纪念日在30天内、提前退房等\n"
            "7. 生成关怀方案: 72小时后触发满意度回访+优惠券\n"
            "8. 自动打标签 (add_customer_tag) — L1自动执行\n"
            "9. 如果要发优惠券或升级VIP — 生成L2建议，老板确认后执行\n\n"
            "输出格式: 结构化JSON，包含分析结果+标签建议+VIP判断+关怀方案+执行级别标注"
        ),
        expected_output=(
            "一份客户分析报告，包含: 消费行为分析摘要、建议标签列表、"
            "VIP资格判断(是/否/升级到哪个级别)、关怀方案(时间+内容+优惠金额)、各操作执行级别"
        ),
        agent=customer_steward_agent,
    )
    return Crew(agents=[customer_steward_agent], tasks=[analysis_task], process=Process.sequential, verbose=True)
