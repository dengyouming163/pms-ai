from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class UpgradeVip(HttpTool):
    name: str = "upgrade_vip"
    description: str = "升级客户会员等级。参数: customer_id(str), new_level(str: diamond/gold/silver/regular)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/customers/upgrade-vip"

    def _run(self, customer_id: str, new_level: str) -> dict:
        return self._request("POST", json_body={"customer_id": customer_id, "new_level": new_level})


class CreateCareReminder(HttpTool):
    name: str = "create_care_reminder"
    description: str = "创建客户关怀提醒。参数: customer_id(str), type(str: rebuy/upgrade/birthday), content(str), priority(str: low/medium/high)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/customers/care"

    def _run(self, customer_id: str, type: str = "rebuy", content: str = "", priority: str = "medium") -> dict:
        return self._request("POST", json_body={
            "customer_id": customer_id, "type": type,
            "content": content, "priority": priority,
        })


ToolRegistry.register(UpgradeVip())
ToolRegistry.register(CreateCareReminder())
