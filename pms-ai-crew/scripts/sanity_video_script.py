# scripts/sanity_video_script.py
"""民宿房券端到端 sanity：验证 8 步编排在 DeepSeek 上跑通，输出契约合规"""
import json
import sys

sys.path.insert(0, ".")

# Windows 控制台默认 GBK，无法编码 emoji/中文；强制 stdout 用 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from src.crews.video_script_crew import VideoScriptOrchestrator
from src.config import _get_redis


class FakeRedis:
    """内存版 Redis mock：本地无 Redis 时降级，用于验证编排逻辑（状态仅在内存流转）。"""

    def __init__(self):
        self._data = {}

    def get(self, key):
        return self._data.get(key)

    def set(self, key, value):
        self._data[key] = value

    def ping(self):
        return True


def main():
    redis = _get_redis()
    if not redis:
        print("⚠️ Redis 不可达，降级为内存 FakeRedis（仅验证编排，不持久化）")
        redis = FakeRedis()

    orch = VideoScriptOrchestrator(redis)
    pid = "VIDEO_SANITY_001"

    # 阶段①
    r1 = orch.run_stage1(pid, {
        "product_name": "海景民宿房券",
        "selling_points": ["一线海景", "温泉泡池", "真实入住实拍"],
        "usage": "引流订房",
    }, {"industry": "旅游住宿", "platform": "通用"})
    assert r1["status"] == "CONFIRM1_WAIT", r1
    assert r1["output"]["product_insight"]["category"], "category 缺失"
    print("✅ 阶段① 通过：product_insight + user_persona")

    # 阶段②
    r2 = orch.run_stage2(pid, "healing")
    assert r2["status"] == "CONFIRM2_WAIT", r2
    hooks = r2["confirm"]["options"]
    assert len(hooks) == 3, f"钩子候选应为 3，实际 {len(hooks)}"
    print("✅ 阶段② 通过：3 钩子候选 + marketing_script")

    # 阶段③ 合规锁定
    r3 = orch.run_stage3(pid, "1", industry="旅游住宿")
    approved = r3["output"].get("approved_script", {})
    assert approved.get("text_hook"), "approved_script.text_hook 缺失"
    print("✅ 阶段③ 通过：approved_script 已锁定")

    # 阶段④
    r4 = orch.run_stage4(pid)
    assert r4["status"] == "CONFIRM3_WAIT", r4
    sb = r4["output"]["storyboard_prompts"]["storyboard"]
    assert sb and all("shot_id" in s for s in sb), "分镜字段不全"
    print("✅ 阶段④ 通过：storyboard_prompts")

    # 聚合
    fin = orch.finalize(pid, "all")
    keys = fin["final_package"].keys()
    assert len([k for k in keys if k in {
        "project_info", "product_insight", "user_persona", "decision_map", "visual_plan",
        "approved_script", "character_assets", "scene_assets", "storyboard_prompts",
        "generation_params"}]) == 10
    print("✅ 聚合通过：FinalPackage 10 键齐全")
    print("\n全部 sanity 通过 ✅")


if __name__ == "__main__":
    main()
