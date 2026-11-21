"""P1-A：build_npcs_from_product_full 的返回 shape 钉死测试。

与 build_characters_from_product_full 同款：基线**附带 characters + 5 个剧本上下文键**
（world_setting/storyline/chapters/endings/location），让 NPC agent 知道已有哪些角色
（避免重名、合理设置 character_id）以及剧本脉络（为哪个故事设计谁）。

关键契约（ab912445 后与 build_characters_from_product_full **同款**）：空 npcs 也返回 dict
（npcs=[] + characters + 5 个上下文键）——「一键生成 NPC」正是用于 npcs 表为空的场景，
返回 None 会被 refine 的 `if not base` 守卫拒答，空表永远无法生成。
本文件用最少用例钉死这两条契约的回归边界。
"""
from src.services.wenlv_persist import build_npcs_from_product_full


def _full(*, npcs=None, config=None, characters=None):
    """与 test_wenlv_creation_crew.py 的 _full 同款形状（/products/:id/full 的 data）。"""
    return {
        "id": "P1",
        "name": "测试产品",
        "theme": {},
        "nodes": [],
        "collectibles": [],
        "endings": [],
        "rewards": [],
        "tiers": [],
        "config": config or {},
        "characters": characters or [],
        "npcs": npcs or [],
    }


def test_returns_npcs_plus_characters_plus_five_context_keys():
    """P1-A 承重断言：返回 shape 必须含 npcs + characters + 5 个上下文键。

    回归边界：将来任何人删掉 characters 抽取块、或漏一个上下文键，本用例当场红。
    """
    base = build_npcs_from_product_full(_full(
        npcs=[{"id": "NPC_1", "name": "船夫", "role": "npc",
               "lines": [{"id": "L1", "text": "上船吧"}]}],
        config={
            "world_setting": {"era": "北宋"},
            "storyline": {"premise": "寻灯"},
            "chapters": {"act1": "夜行"},
            "endings": {"end1": "归途"},
            "location": {"venue": "舞阳河"},
        },
        characters=[{"id": "CHAR_1", "name": "灯芯", "role": "主角",
                     "avatarUrl": "http://img/a.png", "ipPrompt": "水墨少女"}],
    ))

    assert base is not None
    assert set(base) == {"npcs", "characters",
                         "world_setting", "storyline", "chapters", "endings", "location"}
    # npcs 形状仍是 AI 产出侧（snake_case），剥离 voiceUrl/duration 等
    assert base["npcs"][0]["id"] == "NPC_1"
    assert base["npcs"][0]["lines"] == [{"id": "L1", "text": "上船吧"}]
    # characters 形状与 build_characters_from_product_full 同款（含 avatar_url/ip_prompt）
    assert base["characters"][0]["id"] == "CHAR_1"
    assert base["characters"][0]["avatar_url"] == "http://img/a.png"
    assert base["characters"][0]["ip_prompt"] == "水墨少女"
    # 5 个上下文键从 config 快照原样透传
    assert base["world_setting"] == {"era": "北宋"}
    assert base["storyline"] == {"premise": "寻灯"}
    assert base["chapters"] == {"act1": "夜行"}
    assert base["endings"] == {"end1": "归途"}
    assert base["location"] == {"venue": "舞阳河"}


def test_empty_npcs_returns_context_baseline_even_with_characters_present():
    """ab912445（2026-10-02）翻转后的契约，与 build_characters_from_product_full 同款：

    空表（库里没 NPC）→ 仍返回 dict：npcs=[] + characters + 5 个上下文键。
    「一键生成 NPC」正是用于 npcs 表为空的场景 —— agent 需要 characters + 剧本上下文才能
    从零设计；返回 None 会被 refine 的 `if not base` 守卫拒答，空表永远无法生成
    （batch_generate 调度器先删旧 NPC 再插新 NPC，无误覆盖人工改动的风险）。
    本用例钉死：**characters 在场时，空 npcs 拿到的是可用于从零设计的完整上下文基线**。
    """
    base = build_npcs_from_product_full(_full(
        npcs=[],
        config={"world_setting": {"era": "北宋"}},
        characters=[{"id": "CHAR_1", "name": "灯芯"}],
    ))
    assert base is not None
    # shape 与非空场景完全一致（test_returns_npcs_plus_characters_plus_five_context_keys）：
    # 不允许空 npcs 时悄悄换一套键
    assert set(base) == {"npcs", "characters",
                         "world_setting", "storyline", "chapters", "endings", "location"}
    assert base["npcs"] == []
    assert base["characters"][0]["id"] == "CHAR_1"
    assert base["characters"][0]["name"] == "灯芯"
    assert base["world_setting"] == {"era": "北宋"}
    # 其余 4 个上下文键缺失时退化为 {}（与非空场景同款）
    assert base["storyline"] == {}
    assert base["chapters"] == {}
    assert base["endings"] == {}
    assert base["location"] == {}


def test_characters_part_can_be_empty_array_when_npcs_present():
    """characters 部分可空数组（与 build_characters_from_product_full 同款）：

    npcs 非空 = 库里有 NPC 草稿，但剧本可能尚未建任何选角卡 —— 此时 characters=[]，
    5 个上下文键也照常返回（让 NPC agent 至少能从 config 取到剧本脉络）。
    """
    base = build_npcs_from_product_full(_full(
        npcs=[{"id": "NPC_1", "name": "船夫", "lines": []}],
        config={"world_setting": {"era": "北宋"}},
        characters=[],
    ))
    assert base is not None
    assert base["characters"] == []
    assert base["world_setting"] == {"era": "北宋"}
    # 其余 4 个上下文键缺失时退化为 {}（与 build_characters_from_product_full 同款）
    assert base["storyline"] == {}
    assert base["chapters"] == {}
    assert base["endings"] == {}
    assert base["location"] == {}


def test_missing_config_defaults_to_empty_context_objects():
    """config 整个缺失时，5 个上下文键一律 {}（不抛、不 None）——

    与 build_characters_from_product_full 同款：让 agent 拿到「形状一致、值全空」的基线
    而不是 KeyError。回归边界：删掉 `if not isinstance(config, dict): config = {}` 立刻红。
    """
    base = build_npcs_from_product_full(_full(
        npcs=[{"id": "NPC_1", "name": "船夫", "lines": []}],
    ))
    assert base is not None
    for k in ("world_setting", "storyline", "chapters", "endings", "location"):
        assert base[k] == {}


def test_non_dict_data_returns_none():
    """非 dict 输入 → None（与 build_level_from_product_full 同款守卫）。"""
    assert build_npcs_from_product_full(None) is None
    assert build_npcs_from_product_full("not a dict") is None
