"""火山引擎 TTS 适配器（spec §7.3）。

- 环境变量：VOLCANO_TTS_APP_ID / VOLCANO_TTS_TOKEN（与视频生成共用账号体系）。
- voice_id 为预定义音色友好名（spec §7.2 六种），内部映射到火山 voice_type。
- synthesize() 返回 (audio_bytes, duration_seconds)；失败抛 TtsError。
- 真实 key 就绪前可被 S3 stage try/except 容错跳过（spec §5.5 每 stage 完成即写表、不跨 stage 大事务）。
"""
import base64
import os
import uuid

import requests


class TtsError(Exception):
    """TTS 合成失败。"""


# 预定义音色友好名 → 火山 voice_type 映射（spec §7.2 六种）。
# key 就绪后可按实际可用音色调整此映射。
VOICE_TYPE_MAP: dict[str, str] = {
    "male_young": "BV002_streaming",
    "male_middle": "BV700_streaming",
    "male_elder": "BV701_streaming",
    "female_young": "BV001_streaming",
    "female_middle": "BV406_streaming",
    "female_elder": "BV407_streaming",
}

TTS_API_URL = "https://openspeech.bytedance.com/api/v1/tts"


class TtsVolcanoAdapter:
    """火山引擎 TTS 适配器。"""

    def __init__(self, app_id: str | None = None, access_token: str | None = None,
                 cluster: str = "volcano_tts"):
        self.app_id = app_id or os.getenv("VOLCANO_TTS_APP_ID", "")
        self.access_token = access_token or os.getenv("VOLCANO_TTS_TOKEN", "")
        self.cluster = cluster

    def synthesize(self, text: str, voice_id: str) -> tuple[bytes, int]:
        """合成语音。

        Args:
            text: 待合成文本（必填非空）。
            voice_id: 预定义音色友好名或火山原生 voice_type。

        Returns:
            (audio_bytes, duration_seconds)

        Raises:
            TtsError: API 调用失败或响应异常。
        """
        if not text:
            raise TtsError("text 不能为空")
        if not self.app_id or not self.access_token:
            raise TtsError("VOLCANO_TTS_APP_ID / VOLCANO_TTS_TOKEN 未配置")

        voice_type = VOICE_TYPE_MAP.get(voice_id, voice_id)
        req_id = str(uuid.uuid4())

        payload = {
            "app": {
                "appid": self.app_id,
                "token": self.access_token,
                "cluster": self.cluster,
            },
            "user": {"uid": self.app_id},
            "audio": {
                "voice_type": voice_type,
                "encoding": "mp3",
                "speed_ratio": 1.0,
            },
            "request": {
                "reqid": req_id,
                "text": text,
                "text_type": "plain",
                "operation": "query",
            },
        }

        headers = {
            "Authorization": f"Bearer; {self.access_token}",
            "Content-Type": "application/json",
        }

        resp = requests.post(TTS_API_URL, json=payload, headers=headers, timeout=30)
        if resp.status_code != 200:
            raise TtsError(f"火山 TTS HTTP {resp.status_code}: {resp.text[:200]}")

        body = resp.json()
        code = body.get("code", -1)
        if code != 3000:
            raise TtsError(f"火山 TTS 业务错误 code={code}: {body.get('message', '')}")

        audio_b64 = body.get("data")
        if not audio_b64:
            raise TtsError("火山 TTS 返回空 audio data")

        audio_bytes = base64.b64decode(audio_b64)
        # 火山返回 duration 单位为毫秒
        duration_ms = body.get("duration", 0)
        duration_sec = int(duration_ms / 1000) if duration_ms else 0
        return audio_bytes, duration_sec
