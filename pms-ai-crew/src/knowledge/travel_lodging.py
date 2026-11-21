# src/knowledge/travel_lodging.py
"""旅游住宿/本地生活双轨合规（权威源：wwwskill/knowledge/travel-lodging-compliance.md）"""

# 7 项必披露（第 9 模块判定基准）
DISCLOSURE_ITEMS = [
    {"key": "退改政策", "critical": True, "example": "「入住前 24 小时可免费取消，逾期扣首晚房费」/「不可取消，改期需提前 3 天」"},
    {"key": "加价与隐藏消费", "critical": True, "example": "「节假日/周末加价 200 元」「到店另付清洁费/押金/税费」"},
    {"key": "有效期与限制", "critical": True, "example": "「房券有效期至 2026-12-31，节假日不可用，周末需预约」"},
    {"key": "预约与核销方式", "critical": False, "example": "「需提前 1 天电话预约，到店出示核销码」"},
    {"key": "服务内容边界", "critical": False, "example": "「含双早不含午晚餐」「含门票不含索道」"},
    {"key": "资质与安全提示", "critical": False, "example": "「持营业执照/卫生许可证」「温泉/泳池等高风险项目注意安全，儿童需陪同」"},
    {"key": "地址与名额限制", "critical": False, "example": "「本店位于 XX，每日限接待 20 组，预约名额有限」"},
]

# 农家乐/乡村游 6 类特有风险（本地生活纳入双轨后补充）
FARMHOUSE_RISKS = [
    {"risk": "食品安全/卫生", "expr": "「现杀活鱼」「土味健康」「野生菌火锅大补」", "handle": "禁疾病/疗效暗示（踩第 3 库医疗风险）；野生菌/野味提示食用安全风险；卫生资质如实披露"},
    {"risk": "农事体验安全", "expr": "「孩子放心摘」「免费垂钓不限时」", "handle": "采摘提示农药残留防护与禁采期；垂钓/骑马/水上项目儿童需陪同（属「资质与安全提示」必披露）"},
    {"risk": "土特产滋补跨界", "expr": "「野山参补气」「土蜂蜜治咳」「灵芝抗癌」", "handle": "踩医疗风险词库（第 3 库）→ 禁疗效，只可「口感 / 风味 / 本地特色」"},
    {"risk": "季节时令价", "expr": "「草莓季特价」「蟹季不加价」", "handle": "时令/节假日加价属「加价与隐藏消费」必披露，明示加价规则"},
    {"risk": "「土/野/纯天然」宣称", "expr": "「野生」「纯天然」「无农药」「有机」", "handle": "需可验证或认证；无认证禁绝对化宣称（无农药 → 「当天现摘」，见第 8 库映射）"},
    {"risk": "团购券履约", "expr": "「随时核销」「不限次数」", "handle": "有效期 / 使用条件 / 是否需预约属必披露；禁「随时 / 无限制」绝对化"},
]

TRAVEL_LODGING = {
    "disclosure_items": DISCLOSURE_ITEMS,
    "farmhouse_risks": FARMHOUSE_RISKS,
    "industry_trigger": ["旅游住宿", "本地生活"],  # 第 9 模块 + 实景一致性触发条件
}
