"""pms-agent → pms-server 工具调用客户端层。

节点不直接依赖 httpx：通过 ToolClient 接口注入，测试用 FakeTools 替换，
生产用 HttpToolClient 调 pms-server 内部端点 /api/internal/agent-tools/*。

鉴权头契约（与 pms-server internal-auth / tenant 中间件一致）：
  X-Internal-Service-Token = INTERNAL_SERVICE_TOKEN
  X-Merchant-Id = tenant.merchant_id
  X-Store-Id    = tenant.store_id（缺省不传）
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import httpx

from app.config import settings


class ToolClient(ABC):
    """工具客户端接口：4 个 revenue 只读工具 + price_adjust 写操作（Task 9）。"""

    @abstractmethod
    async def pricing_calendar(self, tenant: dict, date: str | None = None,
                               room_type_id: str | None = None) -> dict: ...

    @abstractmethod
    async def occupancy(self, tenant: dict, date: str | None = None) -> dict: ...

    @abstractmethod
    async def competitor_prices(self, tenant: dict, room_type_id: str | None = None,
                                date: str | None = None) -> dict: ...

    @abstractmethod
    async def channel_performance(self, tenant: dict, date_from: str | None = None,
                                  date_to: str | None = None) -> dict: ...

    async def price_adjust(self, tenant: dict, proposal: dict,
                           approval_id: str | None = None) -> dict:
        """执行层写操作（Task 9）。默认抛 NotImplementedError：假工具（鸭子类型）无需实现。"""
        raise NotImplementedError


class HttpToolClient(ToolClient):
    """生产实现：httpx 调 pms-server 内部端点，统一信封 { ok, data, latency_ms }。"""

    def __init__(self, base_url: str | None = None, token: str | None = None,
                 timeout: float = 10.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = (base_url or settings.agent_tools_base).rstrip("/")
        self.token = token or settings.internal_service_token
        self.timeout = timeout
        # 可注入 transport：测试用 httpx.MockTransport 验证契约，默认 None 行为不变
        self._transport = transport

    def _headers(self, tenant: dict) -> dict[str, str]:
        headers = {"X-Internal-Service-Token": self.token}
        merchant_id = tenant.get("merchant_id") or tenant.get("merchantId")
        if merchant_id:
            headers["X-Merchant-Id"] = str(merchant_id)
        store_id = tenant.get("store_id") or tenant.get("storeId")
        if store_id and store_id != "*":
            headers["X-Store-Id"] = str(store_id)
        return headers

    async def _get(self, path: str, params: dict[str, Any], tenant: dict) -> dict:
        # §7.3 工具失败重试 1 次：网络异常（TransportError/Timeout）与 HTTP 5xx
        # 重试一次，仍失败则抛出（由 revenue.collect 的 gather 捕获后落 evidence，
        # 避免单工具失败拖垮整条主流程）。4xx 属客户端错误，不重试直接抛出。
        last_exc: Exception | None = None
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(
                    timeout=self.timeout, transport=self._transport,
                ) as client:
                    resp = await client.get(
                        f"{self.base_url}{path}", params=params,
                        headers=self._headers(tenant),
                    )
                    resp.raise_for_status()
                    return resp.json()
            except httpx.HTTPStatusError as exc:
                # 5xx 重试；4xx 等不重试
                if exc.response.status_code >= 500:
                    last_exc = exc
                else:
                    raise
            except httpx.TransportError as exc:
                # 连接/超时等网络异常重试
                last_exc = exc
            # 非最后一次才继续重试
        raise last_exc  # type: ignore[misc]

    async def pricing_calendar(self, tenant, date=None, room_type_id=None):
        params: dict[str, Any] = {}
        if date:
            params["date"] = date
        if room_type_id:
            params["roomTypeId"] = room_type_id
        return await self._get("/pricing-calendar", params, tenant)

    async def occupancy(self, tenant, date=None):
        params = {"date": date} if date else {}
        return await self._get("/occupancy", params, tenant)

    async def competitor_prices(self, tenant, room_type_id=None, date=None):
        params: dict[str, Any] = {}
        if room_type_id:
            params["roomTypeId"] = room_type_id
        if date:
            params["date"] = date
        return await self._get("/competitor-prices", params, tenant)

    async def channel_performance(self, tenant, date_from=None, date_to=None):
        params: dict[str, Any] = {}
        if date_from:
            params["from"] = date_from
        if date_to:
            params["to"] = date_to
        return await self._get("/channel-performance", params, tenant)

    async def price_adjust(self, tenant, proposal, approval_id=None):
        """执行调价写操作：POST /price-adjust。

        body 严格对齐 pms-server 契约：
        { storeId, roomTypeId, date, expectedCurrentPrice, nextPrice, reason, approvalId }。
        409（价格已被改，期望值不符）不抛异常，返回 conflict 信封交由 execute 节点标记；
        422（护栏拒绝）属预期业务结果，同样不抛，返回 guard_rejected 信封如实记录而非当异常；
        其它非 2xx / 超时 / 网络异常向上抛（由 execute 节点捕获转 failed）。写操作不重试。
        """
        params = proposal.get("params") or {}
        body: dict[str, Any] = {
            "storeId": tenant.get("store_id") or tenant.get("storeId"),
            "roomTypeId": params.get("roomTypeId"),
            "date": params.get("date"),
            "expectedCurrentPrice": params.get("expectedCurrentPrice"),
            "nextPrice": params.get("nextPrice"),
            "reason": params.get("reason") or proposal.get("reason") or "agent price adjust",
            # approval_id 缺失时用 proposal_id 兜底，保证执行层 approvalId 非空
            "approvalId": approval_id or proposal.get("proposal_id"),
        }
        async with httpx.AsyncClient(
            timeout=self.timeout, transport=self._transport,
        ) as client:
            resp = await client.post(
                f"{self.base_url}/price-adjust",
                json=body,
                headers=self._headers(tenant),
            )
        if resp.status_code == 409:
            # 执行层硬校验失败（价格已被改）：不抛、不重试，由上层转 conflict 终态
            return {"ok": False, "error": "price_conflict", "conflict": True}
        if resp.status_code == 422:
            # 护栏拒绝（spec §8）：属预期业务结果，如实记录 guard_rejected，不当异常抛出
            return {"ok": False, "error": "guard_rejected", "guard_rejected": True}
        resp.raise_for_status()
        return resp.json()
