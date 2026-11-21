# src/knowledge/word_count.py
"""字数 / 时长唯一标准（权威源：wwwskill/knowledge/word-count-standards.md）"""

WORD_COUNT = {
    "versions": {
        "15s": {"label": "15s 极速版", "duration": 15, "total_words": 60, "range": (60, 60)},
        "40_60s": {"label": "40-60s 标准版", "duration": "40-60", "total_words": 200, "range": (160, 240)},
        "90s": {"label": "90s 深化版", "duration": 90, "total_words": 360, "range": (360, 360)},
    },
    "speech_rate": {
        "normal": (3, 4),          # 普通口播 3-4 字/秒（默认按 4 字/秒取整）
        "emotion": (2, 3),         # 情绪段落 2-3 字/秒（默认按 2.5 字/秒取整）
        "normal_default": 4,
        "emotion_default": 2.5,
    },
    "rule": "段字数 = 段秒数 × 速率；总字数 ≈ 总秒数 × 速率（40-60s 固定 160-240 字，50s≈200；禁沿用旧版更高字数口径）",
}
