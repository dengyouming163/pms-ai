from pydantic import BaseModel, Field, field_validator


class PriceSuggestion(BaseModel):
    room_type: str = Field(description="房型名称")
    room_number: str = Field(description="房间号")
    current_price: float = Field(gt=0, le=99999, description="当前价格")
    suggested_price: float = Field(gt=0, le=99999, description="建议价格")
    adjustment_pct: float = Field(ge=-30, le=30, description="调价百分比，硬边界 ±30%")
    confidence: float = Field(ge=0, le=1, description="置信度 0-1")
    reasons: list[str] = Field(description="决策依据列表")
    expected_revenue_impact: float = Field(description="预期收入影响(元)")
    risk_level: str = Field(pattern=r"^L[123]$", description="执行级别")
    competitor_avg: float = Field(default=0, description="竞品均价")
    expires_at: str = Field(description="建议过期时间 ISO8601")

    @field_validator("suggested_price")
    @classmethod
    def price_in_range(cls, v, info):
        current = info.data.get("current_price", 0)
        if current > 0 and abs(v - current) / current > 0.30:
            raise ValueError(f"价格调整 {abs(v - current) / current * 100:.1f}% 超出 ±30% 硬边界")
        return v


class PricingOutput(BaseModel):
    summary: str = Field(description="定价分析总结")
    suggestions: list[PriceSuggestion] = Field(description="调价建议列表")
    this_month_savings: float = Field(default=0, description="本月AI帮你多赚的金额")
    market_context: str = Field(default="", description="市场环境分析")
