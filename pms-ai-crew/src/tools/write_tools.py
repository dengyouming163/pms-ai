from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class ApplyPriceAdjustment(HttpTool):
    name: str = "apply_price_adjustment"
    description: str = "执行价格调整。参数: room_type(str), new_price(float), reason(str), action_level(str:L1/L2/L3)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/pricing/adjust"

    def _run(self, room_type: str, new_price: float, reason: str = "", action_level: str = "L2") -> dict:
        return self._request("POST", json_body={
            "room_type": room_type, "new_price": new_price,
            "reason": reason, "action_level": action_level,
        })


class CreatePromotion(HttpTool):
    name: str = "create_promotion"
    description: str = "创建促销活动。参数: name(str), discount_pct(float), room_types(list), date_from(str), date_to(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/pricing/promotion"

    def _run(self, name: str, discount_pct: float, room_types: list, date_from: str, date_to: str) -> dict:
        return self._request("POST", json_body={
            "name": name, "discount_pct": discount_pct,
            "room_types": room_types, "date_from": date_from, "date_to": date_to,
        })


class AddCustomerTag(HttpTool):
    name: str = "add_customer_tag"
    description: str = "给客户打标签。参数: customer_id(str), tags(list[str])"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/customers/tag"

    def _run(self, customer_id: str, tags: list) -> dict:
        return self._request("POST", json_body={"customer_id": customer_id, "tags": tags})


class SendCoupon(HttpTool):
    name: str = "send_coupon"
    description: str = "给客户发优惠券。参数: customer_id(str), amount(float), reason(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/customers/coupon"

    def _run(self, customer_id: str, amount: float, reason: str = "") -> dict:
        return self._request("POST", json_body={"customer_id": customer_id, "amount": amount, "reason": reason})


class SendNotification(HttpTool):
    name: str = "send_notification"
    description: str = "发送通知给老板。参数: title(str), content(str), priority(int:1-5)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/notifications/send"

    def _run(self, title: str, content: str, priority: int = 3) -> dict:
        return self._request("POST", json_body={"title": title, "content": content, "priority": priority})


ToolRegistry.register(ApplyPriceAdjustment())
ToolRegistry.register(CreatePromotion())
ToolRegistry.register(AddCustomerTag())
ToolRegistry.register(SendCoupon())
ToolRegistry.register(SendNotification())
