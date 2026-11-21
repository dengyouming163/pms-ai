"""剧本房 AI 向导会话客户端：经 Task 11 内部端点读写 pms-server ai_sessions。

铁律（spec FR-10 / AI 协作铁律）：
  · AI  crew 不直连 DB，所有会话状态/草案/采纳都走本客户端的 HTTP 调用；
  · 草案只进 ai_sessions.draftSnapshots（save_draft）；
  · 唯一落四表的通道是 adopt（用户确认后由 API 层 Task 13 调用）；
  · Redis 仅作 SSE 运行态，权威 stage 在 ai_sessions。

封套：pms-server 统一返回 {success:true,data} / {success:false,error}；
4xx 的业务错误（404 会话不存在/409 非 active/400 跨房）抛 WenlvSessionError(status_code, message)，
与 5xx/网络错误区分，供调用方决定恢复策略（如 404 → 新建会话）。
"""
import logging
from typing import Optional

import httpx

from src.config import PMS_SERVER_URL, INTERNAL_SERVICE_TOKEN

logger = logging.getLogger(__name__)

API_PREFIX = "/api/admin/wenlv-ai-sessions"


class WenlvSessionError(Exception):
    """pms-server 返回的业务错误（非 2xx 且带 JSON 封套）。payload 保留完整错误体（如发布 409 的 todos）。"""

    def __init__(self, status_code: int, message: str, payload: Optional[dict] = None):
        super().__init__(f"[{status_code}] {message}")
        self.status_code = status_code
        self.message = message
        self.payload = payload


class WenlvDiySessionClient:
    def __init__(self, base_url: str = PMS_SERVER_URL, token: str = INTERNAL_SERVICE_TOKEN,
                 timeout: float = 20.0):
        self.base_url = base_url
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, *, params: Optional[dict] = None,
                 json_body: Optional[dict] = None) -> dict:
        url = path if path.startswith("/api/") else f"{API_PREFIX}{path}"
        with httpx.Client(
            base_url=self.base_url,
            headers={"X-Internal-Service-Token": self.token, "Content-Type": "application/json"},
            timeout=self.timeout,
        ) as client:
            resp = client.request(method, url, params=params, json=json_body)
            try:
                payload = resp.json()
            except Exception:
                payload = None
            if resp.is_success:
                if not isinstance(payload, dict) or payload.get("success") is not True:
                    raise RuntimeError(f"pms-server 响应封套异常：{payload!r}")
                return payload.get("data") or {}
            message = "pms-server 无错误详情"
            if isinstance(payload, dict) and payload.get("error"):
                message = str(payload["error"])
            raise WenlvSessionError(resp.status_code, message,
                                    payload if isinstance(payload, dict) else None)

    # ---------- 会话生命周期 ----------

    def create_or_resume(self, script_room_id: str, user_id: str,
                         intent: Optional[dict] = None) -> dict:
        """POST /sessions —— 同 room+user 有 active 会话则幂等恢复。返回 {session, resumed}。"""
        body = {"scriptRoomId": script_room_id, "userId": user_id}
        if intent is not None:
            body["intent"] = intent
        return self._request("POST", "/sessions", json_body=body)

    def get_session(self, session_id: str) -> Optional[dict]:
        """GET /sessions/:id —— 404 返回 None（不抛），供恢复流程判断。返回会话行本身。"""
        try:
            data = self._request("GET", f"/sessions/{session_id}")
        except WenlvSessionError as e:
            if e.status_code == 404:
                return None
            raise
        return data.get("session") if isinstance(data, dict) else None

    def get_active(self, script_room_id: str, user_id: str) -> Optional[dict]:
        """GET /rooms/:id/active-session —— 无活跃会话返回 None。"""
        try:
            data = self._request(
                "GET", f"/rooms/{script_room_id}/active-session",
                params={"userId": user_id})
            return data.get("session")
        except WenlvSessionError as e:
            if e.status_code == 404:
                return None
            raise

    def patch_session(self, session_id: str, *, stage: Optional[str] = None,
                      status: Optional[str] = None, intent: Optional[dict] = None) -> dict:
        body: dict = {}
        if stage is not None:
            body["stage"] = stage
        if status is not None:
            body["status"] = status
        if intent is not None:
            body["intent"] = intent
        return self._request("PATCH", f"/sessions/{session_id}", json_body=body)

    def append_transcript(self, session_id: str, entries: list[dict]) -> int:
        """追加对话记录（要求会话 active，否则 409）。返回追加后的 transcript 长度。"""
        data = self._request("POST", f"/sessions/{session_id}/transcript",
                             json_body={"entries": entries})
        return int(data.get("transcriptLength", 0))

    # ---------- 草案（不写四表）与采纳（唯一写四表通道）----------

    def save_draft(self, session_id: str, stage: str, draft: dict,
                   advance_to: Optional[str] = None) -> dict:
        """PUT /sessions/:id/drafts/:stage —— 只覆盖 draftSnapshots[stage]。"""
        body: dict = {"draft": draft}
        if advance_to is not None:
            body["advanceTo"] = advance_to
        return self._request("PUT", f"/sessions/{session_id}/drafts/{stage}", json_body=body)

    def adopt(self, session_id: str, script_room_id: str, payload: dict,
              advance_to: Optional[str] = None) -> dict:
        """POST /sessions/:id/adopt —— 单事务把草案 upsert 进 config/npcs/chapters/scenes/flows。

        payload 键：worldview/npcs/chapters/scenes/flows（camelCase 列名，与 pms-server
        AdoptPayload 逐字对齐；由 Task 13 API 层负责从本仓 snake_case 草案映射）。
        """
        body = {"scriptRoomId": script_room_id, **payload}
        if advance_to is not None:
            body["advanceTo"] = advance_to
        data = self._request("POST", f"/sessions/{session_id}/adopt", json_body=body)
        return data.get("adopted") or {}

    # ---------- 步①反向锚定 ----------

    def anchor_context(self, script_room_id: str) -> dict:
        """GET /rooms/:id/anchor-context —— venue/venueProfile/merchants/venuePoints 聚合。"""
        return self._request("GET", f"/rooms/{script_room_id}/anchor-context")

    # ---------- 权威剧本图（增量重生成/谜题回填合并的基线，读库优先）----------

    def get_room_detail(self, script_room_id: str) -> Optional[dict]:
        """GET 旧 admin 路由 /api/admin/wenlv/script-rooms/:id（Task 9 首屏全图）。

        返回 {room, chapters, scenes_by_chapter, scenes, flows}；404 → None。
        场景在 pms-server 按章分组（scenesByChapter），这里扁平成 scenes 列表并保留原分组。
        """
        try:
            data = self._request("GET", f"/api/admin/wenlv/script-rooms/{script_room_id}")
        except WenlvSessionError as e:
            if e.status_code == 404:
                return None
            raise
        grouped = data.get("scenesByChapter") or {}
        scenes = [s for arr in grouped.values() for s in (arr or [])]
        content_id = (data.get("room") or {}).get("contentId")
        npcs = self.get_product_npcs(content_id) if content_id else []
        return {
            "room": data.get("room") or {},
            "chapters": data.get("chapters") or [],
            "scenes_by_chapter": grouped,
            "scenes": scenes,
            "flows": data.get("flows") or [],
            "npcs": npcs,
        }

    def get_product_npcs(self, product_id: str) -> list:
        """GET /api/admin/wenlv/products/:id/npcs → 已采纳 NPC（库行，camelCase）。"""
        data = self._request("GET", f"/api/admin/wenlv/products/{product_id}/npcs")
        if isinstance(data, list):
            return data
        items = data.get("npcs") if isinstance(data, dict) else None
        return items if isinstance(items, list) else []

    # ---------- Task 14：发布闸（唯一上架裁决）----------

    def get_publish_todos(self, product_id: str) -> dict:
        """GET /api/admin/wenlv/products/:id/publish-todos → {todos,total,aiFixable}。

        todos 是发布闸本体的结构化结果（code/message/target/fixBy/aiAction/manualHint），
        与 POST /publish 的 409 同源，保证「清单清空 ⇔ 发布必过」零漂移。
        """
        return self._request("GET", f"/api/admin/wenlv/products/{product_id}/publish-todos")

    def publish_product(self, product_id: str) -> dict:
        """POST /api/admin/wenlv/products/:id/publish → 清零后真正上架。

        未清零时 pms-server 回 409（WenlvSessionError.payload 带 todos）——
        正常流程下向导在发布前先查闸，409 只可能来自竞态，调用方按 409 提示重查清单。
        """
        return self._request("POST", f"/api/admin/wenlv/products/{product_id}/publish")
