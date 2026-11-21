"""撞 max_tokens 上限被截断的识别测试。

回归背景（2026-09-11 生产事故）：level_design 产物（nodes+collectibles+endings+
tiers+rewards 全集）是本流水线最大的一份，两次产出都**精确停在 7996 tokens**
（= `max_tokens=8000` 上限，实测把原文喂回 API 数出来的），JSON 停在 rewards 数组
中途：`"value": "于巷口流动摊「未竟之诺」领取半句`（无闭合引号、无闭合括号）。
但报错是 `Expecting ',' delimiter: line 580 column 6` —— 极易被误判成「模型写错 JSON」，
实际是预算不够。此函数把这类失败标出来，省掉下一次的排查时间。
"""
from src.schemas.common import looks_truncated_json


def test_truncated_mid_string_is_detected():
    # 真实形状：raw-10 尾部（花括号净差 +2，字符串未闭合）
    raw = '{"nodes": [{"id": "NODE_1"}], "rewards": [{"id": "REWARD_A", "name": "三钥合灯", "value": "于旧宅文创店「灯影不灭」领取半句'
    assert looks_truncated_json(raw) is True


def test_truncated_mid_object_is_detected():
    # 字符串闭合了，但结构没闭合（数组/对象悬空）
    raw = '{"nodes": [{"id": "NODE_1", "title": "起点"}, {"id": "NODE_2"'
    assert looks_truncated_json(raw) is True


def test_truncated_after_escape_char_is_detected():
    raw = '{"value": "行尾反斜杠\\'
    assert looks_truncated_json(raw) is True


def test_complete_json_is_not_flagged():
    assert looks_truncated_json('{"nodes": [{"id": "NODE_1"}], "rewards": []}') is False


def test_braces_inside_strings_do_not_false_positive():
    # 正文里出现花括号/引号是常态，不能被误判成截断
    raw = '{"story_text": "他说「{暗号}」然后离开了", "note": "含 \\" 转义引号"}'
    assert looks_truncated_json(raw) is False
