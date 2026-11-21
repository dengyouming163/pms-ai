"""WenlvNode.props 实体道具包字段测试（AI 履约包第一步）。

node_refine 在 pms-server 侧直连 LLM（不经 pms-ai-crew API），但 pms-ai-crew 的
WenlvNode 契约同步加 props 字段，保持两套 schema 形状一致，并为后续阶段级精修
（chapters 等）产出 props 预留入口。props 可选，缺省 None，不破坏存量输出。
"""
from src.schemas.wenlv_creation import WenlvNode


def test_node_refine_props_optional():
    """WenlvNode.props 可选：缺省 None 不破坏存量输出。"""
    # 存量输出形态：无 props 字段
    node = WenlvNode(title="村口", storyText="夜凉如水。")
    assert node.props is None

    # 显式传 null 也归一为 None
    node_null = WenlvNode(title="村口", storyText="夜凉如水。", props=None)
    assert node_null.props is None


def test_node_refine_props_defaults():
    """props 条目缺 kind ⇒ 默认 letter；缺 placeNote ⇒ 允许 None。"""
    node = WenlvNode(
        title="客房",
        storyText="枕下藏着一封家书。",
        props=[{"name": "家书"}],  # 只给 name，kind/placeNote 缺省
    )
    assert node.props is not None
    assert len(node.props) == 1
    prop = node.props[0]
    assert prop.name == "家书"
    assert prop.kind == "letter"  # 缺省 letter
    assert prop.placeNote is None  # 缺省 None


def test_node_refine_props_full_mapping():
    """props 全字段构造 → 字段映射正确，kind 四值枚举可显式指定。"""
    node = WenlvNode(
        title="前台",
        storyText="旧物包里塞着一枚铜钥。",
        props=[
            {"name": "铜钥", "kind": "key", "placeNote": "前台旧物包内"},
            {"name": "身份卡", "kind": "card", "placeNote": "客房枕头下"},
        ],
    )
    assert node.props is not None
    assert len(node.props) == 2
    assert node.props[0].name == "铜钥"
    assert node.props[0].kind == "key"
    assert node.props[0].placeNote == "前台旧物包内"
    assert node.props[1].name == "身份卡"
    assert node.props[1].kind == "card"
    assert node.props[1].placeNote == "客房枕头下"
