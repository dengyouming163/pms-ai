"""人工审批决策校验（Task 9）。

纯函数，无副作用：approve 端点 / 图恢复前用它校验人审输入，非法值直接 422 拒绝。
规则：
  - approve：直接通过（理由可选）。
  - reject：必须有非空理由（去空白后仍非空）。
  - 其它值：拒绝。
"""
from __future__ import annotations


def decide(decision: str, reason: str | None) -> dict:
    """校验审批决策。返回 {"accepted": bool} 或 {"accepted": False, "error": str}。"""
    if decision == "approve":
        return {"accepted": True}
    if decision == "reject":
        if not (reason or "").strip():
            return {"accepted": False, "error": "驳回必须填写理由"}
        return {"accepted": True}
    return {"accepted": False, "error": f"无效的决策值：{decision!r}"}


__all__ = ["decide"]
