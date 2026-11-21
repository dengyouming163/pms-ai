"""R3 隐秘任务引用可达（spec §9）—— 部分用例名与断言文案取自 TS 侧 wenlv-integrity.test.ts 的同名
describe，便于两侧对读；本文件另有无 TS 对应的用例（例如下方喂 _build_draft 的端到端）。

🔴 形状前提：入参是 **schema 写下的形状** —— `Character.hidden_quest` 是**嵌套**的
（src/schemas/wenlv_creation.py 的 Character / HiddenQuest），`collectible_ids` 在其下、无 alias。
夹具必须照这个形状写：夹具若改直塞扁平键（hidden_quest_collectible_ids）而实现仍读嵌套，
R3 一条都不触发 ⇒ **期望报错的用例会红**（不是绿）。真正会全绿的是「夹具与实现**同时**
改用扁平键」—— 那时直塞夹具的用例照样通过，而生产用的是嵌套形状 ⇒ R3 静默失效；本文件
的端到端用例喂的是 _build_draft 透传的真实嵌套形状，仍会拦住这种「同时漂移」。
"""
from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator
from src.services.wenlv_integrity import validate_wenlv_integrity


def _base():
    return {
        "product": {"id": "p", "name": "测试剧本", "mode": "narrative"},
        "nodes": [{"id": "n1", "node_type": "scene", "title": "第一幕",
                   "unlock_collected": [], "unlock_completed": [],
                   "grant_collectibles": ["c1"], "complete_nodes": ["n1"]}],
        "collectibles": [{"id": "c1", "name": "线索一", "type": "clue"},
                         {"id": "c2", "name": "无人发放的线索", "type": "clue"}],
        "endings": [{"id": "e1", "title": "结局", "collected_ids": []}],
        "rewards": [], "tiers": [], "characters": [],
    }


def test_R3_隐秘任务引用不存在的线索_报错():
    d = _base()
    d["characters"] = [{"id": "ch1", "name": "沈砚",
                        "hidden_quest": {"title": "旧信", "description": "", "collectible_ids": ["nope"]}}]
    errs = validate_wenlv_integrity(d)
    assert errs == ["角色[沈砚] 的隐秘任务引用了不存在的线索 nope"], errs


def test_R3_隐秘任务引用存在但无人发放的线索_报错():
    d = _base()
    d["characters"] = [{"id": "ch1", "name": "沈砚",
                        "hidden_quest": {"title": "旧信", "description": "", "collectible_ids": ["c2"]}}]
    errs = validate_wenlv_integrity(d)
    assert errs == ["角色[沈砚] 的隐秘任务引用了没有任何节点发放的线索 c2——该隐秘任务永远无法完成"], errs


def test_R3_隐秘任务引用有发放的线索_不报错():
    d = _base()
    d["characters"] = [{"id": "ch1", "name": "沈砚",
                        "hidden_quest": {"title": "旧信", "description": "", "collectible_ids": ["c1"]}}]
    assert validate_wenlv_integrity(d) == []


def test_R3_没有隐秘任务的角色_不报错():
    d = _base()
    d["characters"] = [{"id": "ch1", "name": "沈砚"}]          # 无 hidden_quest 键
    assert validate_wenlv_integrity(d) == []


def test_R3_角色没有name时回退用id():
    """`who` 取 `name or id` 的回退支：既有夹具的角色都有 name，删掉回退也不红。"""
    d = _base()
    d["characters"] = [{"id": "ch1", "hidden_quest": {"collectible_ids": ["nope"]}}]   # 无 name 键
    errs = validate_wenlv_integrity(d)
    assert errs == ["角色[ch1] 的隐秘任务引用了不存在的线索 nope"], errs


def test_R3_集章模式rally_也查隐秘任务():
    """R3 在 narrative 与 rally **两种 mode 都查**：既有用例的 product.mode 全是 narrative，
    rally 臂于是零判据（把 R3 那段循环跳过 rally 不会有任何用例变红）。"""
    # 夹具按**该闸的**合规形状写：发章节点绑定点位（venue_point_id）。TS 侧 wenlv-integrity.ts 有
    # 「发放印章的节点必须绑定点位」硬闸，Python 侧目前没有这条规则（已单独登记）；夹具仍照合规
    # 形状写，免得将来 Python 补齐该规则时，此例因与 R3 无关的原因变红。
    d = {
        "product": {"id": "p2", "name": "集章产品", "mode": "rally"},
        "nodes": [{"id": "n1", "node_type": "scene", "title": "点位一",
                   "unlock_collected": [], "unlock_completed": [],
                   "grant_collectibles": ["s1"], "complete_nodes": ["n1"],
                   "venue_point_id": "pt1"}],
        "collectibles": [{"id": "s1", "name": "印章一", "type": "stamp"}],
        "endings": [],
        "tiers": [{"id": "t1", "name": "档位一", "collected_ids": ["s1"]}],
        "rewards": [],
    }
    # 先自证夹具是干净的：无角色时一条错误都没有 ⇒ 下面唯一的错误必然来自 R3。
    assert validate_wenlv_integrity(d) == [], validate_wenlv_integrity(d)
    d["characters"] = [{"id": "ch1", "name": "沈砚",
                        "hidden_quest": {"title": "旧信", "description": "",
                                         "collectible_ids": ["nope"]}}]
    assert validate_wenlv_integrity(d) == ["角色[沈砚] 的隐秘任务引用了不存在的线索 nope"], \
        validate_wenlv_integrity(d)


def test_R3_characters_缺省不报错():
    d = _base()
    d.pop("characters")
    assert validate_wenlv_integrity(d) == []


def test_R3_传了npcs但没传characters_不抛异常():
    """NPC 块会把 `characters` 重绑为 input_data 里的值（可能 None）——
    R3 若共用这个名字，这里会 TypeError（整函数抛异常），而不是返回错误清单。"""
    d = _base()
    d.pop("characters")
    d["npcs"] = []
    errs = validate_wenlv_integrity(d)
    assert errs == [], errs


def test_R3_端到端_关卡草稿喂入角色后拦住不存在的线索():
    """端到端：真实的 _build_draft（脚本阶段产物的形状）→ _validate ⇒ 报错。

    只测「夹具 → validate」抓不到「读端读的键没人写入」。把 _build_draft 的 characters
    投影删掉、或改成扁平键，这个用例变红，而上面那些直塞夹具的用例照样全绿。
    """
    orch = WenlvCreationOrchestrator()
    level = {"nodes": [{"id": "NODE_1", "node_type": "scene", "title": "起点",
                        "unlock_collected": [], "unlock_completed": [],
                        "grant_collectibles": ["CLUE_1"], "complete_nodes": ["NODE_1"]}],
             "collectibles": [{"id": "CLUE_1", "name": "密信", "type": "clue"}],
             "endings": [{"id": "END_1", "title": "结局", "collected_ids": []}],
             "tiers": [], "rewards": []}
    script = {"characters": {"schema_version": "1.0", "characters": [
        {"id": "CH_1", "name": "沈砚",
         "hidden_quest": {"title": "旧信", "description": "", "collectible_ids": ["CLUE_MISSING"]}},
        "垃圾",              # 非 dict ⇒ 投影必须丢弃（否则投影处 AttributeError）
        {"name": "没有 id"},  # 无 id ⇒ 丢弃（不丢就会留在投影结果里，下面按 id 取值的断言会印出它）
    ]}}
    draft = orch._build_draft({"mode": "narrative", "world_tone": "武侠"}, level, {}, theme="题",
                              script=script)
    # 直接钉住投影过滤器的两个子句：非 dict 与 无 id 的条目都不得进入 draft["characters"]。
    assert [c.get("id") for c in draft["characters"]] == ["CH_1"], draft["characters"]
    # 阳性对照：带 1 个无 hidden_quest 的合法角色 ⇒ 必须一条错误都没有（证明夹具本身是干净的，
    # 上面那条红不是别的原因）。R1（spec §9）要求产品至少 1 个角色，故 clean 也须喂角色，
    # 否则 R1 先拦住，到不了 R3 的断言（夹具缺 characters 是 P0 加 R1 后的 pre-existing 遗留）。
    # 角色形状参考本文件 L53 的合法形状：{"id": ..., "name": ...}，无 hidden_quest ⇒ 不触发 R3，
    # 无 skills ⇒ 不触发 R4。
    clean_script = {"characters": {"schema_version": "1.0", "characters": [
        {"id": "CH_0", "name": "路人"}  # 无 hidden_quest、无 skills
    ]}}
    clean = orch._build_draft({"mode": "narrative", "world_tone": "武侠"}, level, {}, theme="题",
                              script=clean_script)
    assert orch._validate(clean) == [], orch._validate(clean)
    assert orch._validate(draft) == ["角色[沈砚] 的隐秘任务引用了不存在的线索 CLUE_MISSING"], \
        orch._validate(draft)
