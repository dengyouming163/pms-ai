"""wenlv_creation 输出契约容错测试（LenientModel 行为）。"""
from src.schemas.wenlv_creation import Characters, Endings, LevelDesign, LevelNode, ProjectPositioning


def test_characters_single_dict_coerced_to_list():
    # LLM 常把「应为数组」的字段输出成单个 dict，LenientModel 应自动包成 list
    raw = {"characters": {
        "id": "CHAR_1", "name": "主角", "role": "主角",
        "faction": "孤山书社", "faction_color": "#3A7D5C",
        "identity": "隐士", "identity_desc": "曾为京官",
        "vitality": 60, "wisdom": 80, "insight": 70,
        "skills": [{"id": "track", "label": "追踪", "description": "循迹"}],
        "ip_prompt": "水墨青衫",
    }}
    model = Characters(**raw)
    assert isinstance(model.characters, list)
    assert model.characters[0].id == "CHAR_1"
    # 承重：**一致改名**（schema 与夹具同时改）时上面两条断言全绿，只有这条会红 ——
    # 实测过：把 ip_prompt 一致改成 ip_description，前两条照过，此处 AttributeError。
    # （不一致的改名会 ValidationError 响亮报错；「静默丢弃」只发生在可选/带默认值的字段上。）
    assert model.characters[0].ip_prompt == "水墨青衫"


def test_project_positioning_extra_field_ignored():
    raw = {"mode": "narrative", "world_tone": "武侠", "style_tag": "guochao", "bogus": 123}
    model = ProjectPositioning(**raw)
    assert model.mode == "narrative"
    assert not hasattr(model, "bogus")


def test_level_design_defaults():
    raw = {"nodes": [{"id": "NODE_1", "node_type": "scene", "title": "起点", "story_text": "..."}]}
    model = LevelDesign(**raw)
    assert model.collectibles == []
    assert model.tiers == []
    assert model.nodes[0].trigger_type == "manual"


def test_ending_priority_survives_model_dump():
    """结局 priority 必须活过剧本第 5 步 → 关卡设计之间的 pydantic 边界。

    `_run_agent` 用 `schema_cls(**raw).model_dump()` 收口 agent 产出，而 `Ending` 继承的
    `LenientModel` 是 `extra="ignore"` —— 未声明的字段会被**静默**丢弃。若不给 `Ending`
    声明 priority，ending_designer 就算乖乖输出它，level_designer 也看不到，
    整条链路的 priority 只能靠 level_designer 凭空编，第 5 步的 prompt 形同虚设。
    """
    raw = {"schema_version": "w2.5", "endings": [
        {"id": "END_1", "title": "真相大白", "condition_hint": "集齐三件信物",
         "emotional_climax": "恍然", "priority": 5},
    ]}
    dumped = Endings(**raw).model_dump()
    assert dumped["endings"][0].get("priority") == 5, dumped


def test_level_node_keeps_venue_point_id():
    """venue_point_id 必须在 schema 里显式声明 —— LenientModel 会丢弃未声明字段。

    未声明时：AI 产出的 id 被 model_dump() 静默丢掉，下游再也拿不到它 ——
    落库那一跳（create_node 逐字段手工构造 body，需显式投影该字段）由 Task B4 补上，
    两跳合取才真正闭合；而这一切在日志里毫无痕迹。
    """
    n = LevelNode(**{
        "id": "NODE_1", "node_type": "scene", "title": "古井旁",
        "story_text": "…", "venue_point_id": "p1",
    })
    assert n.model_dump()["venue_point_id"] == "p1"


def test_level_node_venue_point_id_defaults_empty():
    """缺省为空串 —— 纯剧情节点不绑点位是**合法状态**，不是错误。"""
    n = LevelNode(**{"id": "NODE_2", "node_type": "puzzle", "title": "谜题", "story_text": "…"})
    assert n.model_dump()["venue_point_id"] == ""


def test_level_node_keeps_trigger_type():
    """🔴 trigger_type / trigger_credential **必须继续留在 schema 里**。

    它们是出稿与精修**共用**的 schema；run_refine(stage='level') 也用 LevelDesign 校验。
    一旦移除，精修产出恒不含这两个字段 ⇒ 前端 mapNode 落到兜底
    `(n.trigger_type ?? 'manual')` / `(n.trigger_credential ?? null)`
    ⇒ 用户配好的 qrcode + 凭证每点一次「应用精修」就被打回 manual/null
    （applyLevel 是删光再重建）—— 那正是本次要修的「免凭证可远程触发」。
    """
    n = LevelNode(**{
        "id": "NODE_3", "node_type": "scene", "title": "闸口", "story_text": "…",
        "trigger_type": "qrcode", "trigger_credential": "WLP-ABC",
    })
    d = n.model_dump()
    assert d["trigger_type"] == "qrcode"
    assert d["trigger_credential"] == "WLP-ABC"
