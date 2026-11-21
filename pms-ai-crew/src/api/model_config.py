"""模型配置 API — 运行时热切换 LLM 模型（DeepSeek ↔ 千问等）"""
from fastapi import APIRouter
from src.config import MODEL_PRESETS, get_active_preset, set_active_preset, get_active_config

router = APIRouter()


@router.get("/model")
async def get_model():
    """查询当前模型配置及所有可用预设"""
    preset = get_active_preset()
    cfg = get_active_config()
    api_key = cfg.get("api_key", "")
    return {
        "active": preset,
        "config": {
            "label": cfg["label"],
            "model": cfg["model"],
            "provider": cfg["provider"],
            "base_url": cfg["base_url"],
            "api_key_masked": (
                api_key[:8] + "***" + api_key[-4:]
                if len(api_key) > 12 else "***"
            ),
        },
        "presets": [
            {
                "id": k,
                "label": v["label"],
                "model": v["model"],
                "provider": v["provider"],
                "api_key_masked": (
                    v["api_key"][:8] + "***" + v["api_key"][-4:]
                    if len(v.get("api_key", "")) > 12 else "***"
                ),
            }
            for k, v in MODEL_PRESETS.items()
        ],
    }


@router.post("/model/switch")
async def switch_model(body: dict):
    """切换当前使用的 LLM 模型预设"""
    preset = body.get("preset", "")
    if not preset:
        return {"success": False, "error": "缺少 preset 参数"}

    ok = set_active_preset(preset)
    if not ok:
        return {
            "success": False,
            "error": f"无效预设 '{preset}'，可用: {list(MODEL_PRESETS.keys())}",
        }

    cfg = MODEL_PRESETS[preset]
    return {
        "success": True,
        "active": preset,
        "model": cfg["model"],
        "label": cfg["label"],
        "provider": cfg["provider"],
    }
