"""R-N1~R-N4 NPC 引用完整性测试（spec §9）。

与 TS 侧 pms-server/src/services/__tests__/wenlv-integrity.test.ts 的
「Task 12: R-N1~R-N4 NPC 引用完整性」describe 块**一一对应**。

错误格式与既有规则同款 —— string[] 文案数组，每条错误含 (R-Nx) 编号便于定位。
校验位置：mode 分流之前（narrative / rally 共享，NPC 引用与 mode 无关）。

跳过条件：
  - input_data["npcs"] 未提供（None）⇒ R-N1~R-N4 全部跳过（向后兼容既有调用点；
    T13 才在 publish 调用点组装 npcs/characters 入参）。**用 `is not None` 守卫**：
    传空 list 也要进入校验（与 TS 侧 `if (input.npcs)` 对空数组的 truthy 同构 ——
    TS 的 [] 是 truthy，会进入校验但遍历空数组无操作）。
  - 节点无 npc_id ⇒ R-N1/R-N2 跳过该节点（老剧本零迁移）。
  - npc 无 character_id ⇒ R-N3 跳过该 npc（spec：若存在）。
  - input_data["characters"] 未提供（None）⇒ R-N3 跳过（但 R-N1/R-N2/R-N4 仍跑）。
"""
from src.schemas.wenlv_creation import LevelNode
from src.services.wenlv_integrity import validate_wenlv_integrity


def _base_npc():
    """合法 narrative 骨架：1 scene + 1 ending，且补全合法 npc/character/line。

    既是 R-N1~R-N4 的「全部合法」正例，也是各负例的基线夹具（每条用例只改一处）。
    """
    return {
        "product": {"id": "P1", "name": "NPC 测试", "mode": "narrative"},
        "nodes": [
            {"id": "N1", "node_type": "scene", "title": "村口",
             "npc_id": "npc1", "npc_line_ids": ["l1"],
             "unlock_collected": [], "unlock_completed": [],
             "grant_collectibles": [], "complete_nodes": []},
        ],
        "collectibles": [],
        "endings": [{"id": "E1", "title": "圆满", "collected_ids": [], "reward_id": ""}],
        "rewards": [],
        "npcs": [
            {"id": "npc1", "name": "张三", "character_id": "ch1",
             "lines": [{"id": "l1", "text": "你好"}]},
        ],
        "characters": [{"id": "ch1", "name": "主角"}],
    }


def _node(npc_id="npc1", npc_line_ids=None, title="村口"):
    return {"id": "N1", "node_type": "scene", "title": title,
            "unlock_collected": [], "unlock_completed": [],
            "grant_collectibles": [], "complete_nodes": [],
            **({"npc_id": npc_id, "npc_line_ids": npc_line_ids or ["l1"]}
               if npc_id is not None else {})}


# ---------------------------------------------------------------------------
# R-N1：节点 npc_id 必须在 product.npcs 内
# ---------------------------------------------------------------------------

def test_rn1_node_npc_id_not_in_product_npcs():
    """R-N1：节点 npc_id 不在产品 NPC 表内 → 报错且文案点名该 NPC 与节点。

    npc_line_ids 非空（['l1']）：R-N1 命中后实现里有 `continue` 跳过该节点的 R-N2。
    若有人删掉那个 continue，R-N2 会拿 None 的 npc 去查 lines —— 本用例钉住
    「R-N1 命中 ⇒ 该节点不再走 R-N2」这一短路：R-N2 必须不报。
    """
    bad = _base_npc()
    bad["nodes"] = [_node(npc_id="missing", npc_line_ids=["l1"])]
    errs = validate_wenlv_integrity(bad)
    hits = [e for e in errs if "R-N1" in e]
    assert hits, errs
    assert "missing" in hits[0] and "村口" in hits[0], hits
    # R-N2 必须不报：R-N1 命中后 continue 短路了该节点的 R-N2
    assert not any("R-N2" in e for e in errs), errs


# ---------------------------------------------------------------------------
# R-N2：节点 npc_line_ids 每项必须存在于所属 NPC.lines.id
# ---------------------------------------------------------------------------

def test_rn2_node_line_not_in_npc_lines():
    """R-N2：节点 npc_line_ids 引用的台词不在所属 NPC.lines 内 → 报错。"""
    bad = _base_npc()
    bad["nodes"] = [_node(npc_id="npc1", npc_line_ids=["ghost-line"])]
    errs = validate_wenlv_integrity(bad)
    hits = [e for e in errs if "R-N2" in e]
    assert hits, errs
    assert "ghost-line" in hits[0] and "npc1" in hits[0], hits


def test_rn2_line_in_other_npc_but_not_in_owner():
    """R-N2 判别力：台词存在于另一 NPC 但不在所属 NPC → 报错（禁止全局扫描 NPC.lines）。

    若有人把 R-N2 改成「扫所有 NPC 的 lines」（而非对照 node.npc_id 指向的那个 NPC），
    l2 会在全局扫描中找到 ⇒ 错误地通过本用例。正确实现只查 npc1 的 lines（含 l1 不含 l2）
    ⇒ 报 R-N2。这是 R-N2 区分「按 NPC 查」与「全局查」的唯一用例。
    """
    bad = _base_npc()
    bad["nodes"] = [_node(npc_id="npc1", npc_line_ids=["l2"])]
    bad["npcs"] = [
        {"id": "npc1", "name": "张三", "character_id": "ch1",
         "lines": [{"id": "l1", "text": "你好"}]},
        {"id": "npc2", "name": "李四", "character_id": "ch1",
         "lines": [{"id": "l2", "text": "别的台词"}]},
    ]
    errs = validate_wenlv_integrity(bad)
    hits = [e for e in errs if "R-N2" in e]
    assert hits, errs
    # 文案必须点名 l2（被引用的台词）与 npc1（应该拥有它的 NPC，但没有）
    assert "l2" in hits[0] and "npc1" in hits[0], hits


# ---------------------------------------------------------------------------
# R-N3：npc.character_id 必须在 product.characters 内
# ---------------------------------------------------------------------------

def test_rn3_character_id_not_in_characters():
    """R-N3：npc.character_id 不在 character 表内 → 报错。"""
    bad = _base_npc()
    bad["npcs"] = [{"id": "npc1", "name": "张三", "character_id": "ghost-char",
                    "lines": [{"id": "l1", "text": "你好"}]}]
    errs = validate_wenlv_integrity(bad)
    hits = [e for e in errs if "R-N3" in e]
    assert hits, errs
    assert "ghost-char" in hits[0] and "npc1" in hits[0], hits


# ---------------------------------------------------------------------------
# R-N4：npc.lines 至少 1 条；id 在该 NPC 内唯一
# ---------------------------------------------------------------------------

def test_rn4_duplicate_line_id():
    """R-N4：npc.lines.id 在该 NPC 内重复 → 报错。"""
    bad = _base_npc()
    bad["npcs"] = [{"id": "npc1", "name": "张三", "character_id": "ch1",
                    "lines": [{"id": "l1", "text": "你好"}, {"id": "l1", "text": "重复台词"}]}]
    errs = validate_wenlv_integrity(bad)
    assert any("R-N4" in e and "l1" in e for e in errs), errs


def test_rn4_empty_lines():
    """R-N4：npc.lines 为空数组 → 报错（lines 至少 1 条，强制约束）。

    同时钉住「至少需要 1 条台词」这一空 lines 专属文案，区分「空」与「id 重复」两个分支：
    若有人把空分支删掉、让空数组也走重复检查分支，本断言会红（空数组不产「至少」文案）。
    """
    bad = _base_npc()
    bad["nodes"] = [_node(npc_id="npc1", npc_line_ids=[])]
    bad["npcs"] = [{"id": "npc1", "name": "张三", "character_id": "ch1", "lines": []}]
    errs = validate_wenlv_integrity(bad)
    assert any("R-N4" in e and "至少需要 1 条台词" in e for e in errs), errs


# ---------------------------------------------------------------------------
# 跳过守卫（向后兼容）
# ---------------------------------------------------------------------------

def test_npcs_not_provided_skips_all():
    """npcs 未提供（None）→ R-N1~R-N4 全部跳过（向后兼容，既有调用点不传 npcs）。

    节点引用了不存在的 npc_id 与台词，但不传 npcs ⇒ 全部跳过，零 NPC 错误。
    这条是既有用例的护栏：它们都没传 npcs，新增校验不能让它们变红。
    """
    bad = _base_npc()
    bad["npcs"] = None
    bad["characters"] = None
    bad["nodes"] = [_node(npc_id="whatever", npc_line_ids=["ghost"])]
    errs = validate_wenlv_integrity(bad)
    assert not any("R-N" in e for e in errs), errs


def test_npcs_empty_list_still_enters_validation():
    """npcs 传空 list（[]）→ 仍进入校验块（与 TS 侧 `if (input.npcs)` 对 [] truthy 同构）。

    空列表时：R-N1/R-N2 遍历 nodes（节点无 npc_id 则跳过）；R-N3/R-N4 遍历空 npcs 无操作。
    关键是「传了空 list」与「未传」语义不同 —— 用 `is not None` 守卫区分。
    """
    bad = _base_npc()
    bad["npcs"] = []
    bad["characters"] = [{"id": "ch1", "name": "主角"}]
    bad["nodes"] = [_node(npc_id="whatever", npc_line_ids=["ghost"])]
    errs = validate_wenlv_integrity(bad)
    # 空列表仍进入校验：node 引用 'whatever' 不在空 npc_map 里 ⇒ R-N1 报
    assert any("R-N1" in e and "whatever" in e for e in errs), errs


def test_all_legal_is_clean():
    """R-N1~R-N4 全部合法 → 零错误（正例护栏，防过度拦截）。"""
    assert validate_wenlv_integrity(_base_npc()) == []


def test_characters_not_provided_rn3_skips_others_run():
    """characters 未提供（None）但 npcs 提供 ⇒ R-N3 跳过但 R-N1/R-N2/R-N4 仍跑。

    npc.character_id 指向不存在的角色，但 characters 未传 ⇒ R-N3 不报；
    npc.lines 重复 ⇒ R-N4 仍报。
    """
    bad = _base_npc()
    bad["npcs"] = [{"id": "npc1", "name": "张三", "character_id": "ghost-char",
                    "lines": [{"id": "l1", "text": "a"}, {"id": "l1", "text": "b"}]}]
    bad["characters"] = None
    errs = validate_wenlv_integrity(bad)
    assert not any("R-N3" in e for e in errs), errs
    assert any("R-N4" in e for e in errs), errs


def test_npc_character_id_none_skips_rn3():
    """npc.character_id 缺省（None）⇒ R-N3 跳过该 npc 不报。"""
    bad = _base_npc()
    bad["npcs"] = [{"id": "npc1", "name": "张三", "character_id": None,
                    "lines": [{"id": "l1", "text": "你好"}]}]
    errs = validate_wenlv_integrity(bad)
    assert not any("R-N3" in e for e in errs), errs
    assert errs == [], errs


def test_node_without_npc_id_skips_rn1_rn2():
    """节点无 npc_id ⇒ R-N1/R-N2 跳过该节点（老剧本零迁移）。"""
    bad = _base_npc()
    bad["nodes"] = [_node(npc_id=None)]  # 不写 npc_id 键
    errs = validate_wenlv_integrity(bad)
    assert not any("R-N" in e for e in errs), errs


# ---------------------------------------------------------------------------
# mode 无关：rally 模式下 R-N1~R-N4 同样生效（校验在 mode 分流之前）
# ---------------------------------------------------------------------------

def test_rally_mode_rn1_still_active():
    """rally 模式下 R-N1~R-N4 同样生效（NPC 校验不分 mode）。

    与 TS 侧同名用例对齐：node 引用不存在的 npc_id 'missing' ⇒ 即便切到 rally 模式，
    R-N1 仍报。这钉住「NPC 校验在 mode 分流之前」这一位置约束。
    """
    rally = {
        "product": {"id": "P1", "name": "集章 NPC", "mode": "rally"},
        "nodes": [{"id": "N1", "node_type": "scene", "title": "村口",
                   "npc_id": "missing", "npc_line_ids": ["ghost"],
                   "unlock_collected": [], "unlock_completed": [],
                   "grant_collectibles": ["STAMP_1"], "complete_nodes": [],
                   "venue_point_id": ""}],
        "collectibles": [{"id": "STAMP_1", "name": "章", "type": "stamp"}],
        "endings": [],
        "rewards": [{"id": "REWARD_1", "name": "奖"}],
        "tiers": [{"id": "TIER_1", "name": "档", "collected_ids": ["STAMP_1"],
                   "reward_id": "REWARD_1"}],
        "npcs": [{"id": "npc1", "name": "张三", "character_id": "ch1",
                  "lines": [{"id": "l1", "text": "你好"}]}],
    }
    errs = validate_wenlv_integrity(rally)
    assert any("R-N1" in e for e in errs), errs


# ---------------------------------------------------------------------------
# LevelNode schema：npc_id / npc_line_ids 字段必须显式声明（LenientModel 会丢弃
# 未声明字段，与 venue_point_id 同款约束 —— 见 test_wenlv_schemas.py 的同名用例）
# ---------------------------------------------------------------------------

def test_level_node_keeps_npc_id():
    """npc_id 必须在 schema 里显式声明 —— LenientModel 会丢弃未声明字段。

    未声明时：AI 产出的 npc_id 被 model_dump() 静默丢掉，下游再也拿不到它 ——
    R-N1/R-N2 在落库那一跳（T15 调用 validate_wenlv_integrity）就会全部跳过。
    """
    n = LevelNode(**{
        "id": "NODE_1", "node_type": "scene", "title": "古井旁", "story_text": "…",
        "npc_id": "NPC_1",
    })
    assert n.model_dump()["npc_id"] == "NPC_1"


def test_level_node_npc_fields_default():
    """缺省：npc_id=None，npc_line_ids=[]（纯剧情节点不绑 NPC 是合法状态，不是错误）。"""
    n = LevelNode(**{"id": "NODE_2", "node_type": "puzzle", "title": "谜题", "story_text": "…"})
    dumped = n.model_dump()
    assert dumped["npc_id"] is None
    assert dumped["npc_line_ids"] == []


def test_level_node_keeps_npc_line_ids():
    """npc_line_ids 必须活过 model_dump —— 节点引用台词子集是 R-N2 的入参。"""
    n = LevelNode(**{
        "id": "NODE_3", "node_type": "scene", "title": "闸口", "story_text": "…",
        "npc_id": "NPC_2", "npc_line_ids": ["L1", "L2"],
    })
    d = n.model_dump()
    assert d["npc_id"] == "NPC_2"
    assert d["npc_line_ids"] == ["L1", "L2"]
