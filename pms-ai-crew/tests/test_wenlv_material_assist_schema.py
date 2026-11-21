import pytest
from pydantic import ValidationError

from src.schemas.wenlv_material_assist import (
    MaterialOptimizeResult,
    MaterialOrganizeResult,
)


def test_minimal_payload_is_valid():
    m = MaterialOptimizeResult(content="据资料记载……", used_sources=[1, 3])
    assert m.content == "据资料记载……"
    assert m.used_sources == [1, 3]
    assert m.note == ""


def test_extra_fields_ignored():
    """LenientModel 契约：LLM 多吐字段不能炸。"""
    m = MaterialOptimizeResult(content="x", used_sources=[2], found=True, sources=[1, 2], 疑似多余="y")
    assert m.content == "x"
    assert not hasattr(m, "found")


def test_content_wrapped_in_dict_is_unwrapped():
    """LLM 常把字段嵌在同名键下 —— LenientModel 会把它提上来。

    ⚠️ 两个字段都要断言：只断言 `content` 时，若解包只对 content 生效、
    `used_sources` 没提上来 ⇒ 本用例仍绿，而线上是「必填字段缺失 ⇒ 组装步整个失败」。
    """
    m = MaterialOptimizeResult(
        **(__import__("json").loads('{"result":{"content":"嵌套的","used_sources":[1]}}'))
    )
    assert m.content == "嵌套的"
    assert m.used_sources == [1]


def test_content_key_missing_is_rejected_not_silently_empty():
    """🔴 本闸防的是「读不到」被伪装成「公网没有」。

    这两个载荷都是**不抛异常**的形态，也就是「模型答了、我们读不到」的两种常见形状：
      · 正文被吐在别的键名下（`optimized_content`）
      · 干脆只剩一句结论（只有 `note`）
    没有这条断言，上面两种都会静默降级成 `content=""` ⇒ 下游判「公网未查到」。

    🔴 **两个载荷都必须显式给出 `used_sources`**（2026-09-23 修，见下）：
    不给的话它们会因为**缺 `used_sources`** 而抛，本闸照样绿 ——
    判据还在，判别力没了（`single-instance-fixture-zeroes-and-bite` 同族）。
    所以这里还**钉住报错点名的是 content**，把「因为别的原因抛」这条路堵死。
    """
    with pytest.raises(ValidationError) as ei:
        MaterialOptimizeResult(**{"optimized_content": "据资料记载，该井建于明代…", "used_sources": []})
    assert "content" in str(ei.value)

    with pytest.raises(ValidationError) as ei2:
        MaterialOptimizeResult(**{"note": "公网未查到与该素材相关的独立来源", "used_sources": []})
    assert "content" in str(ei2.value)


def test_used_sources_key_missing_is_rejected():
    """🔴 `used_sources` 与 `content` 同样**必填**，理由也同一个。

    若给它一个默认值（`default_factory=list` 看着更「安全」），那么
    「模型漏写了这个键」与「模型判定检索结果与素材无关」会产出**完全一样**的结果：
    绿底整理卡 + 「公网未查到你这条素材的独立来源」。来源明明查到了、只是没被点名时，
    这句话就是**假话** —— 正是上面那条 `content` 闸所防的同一种伪装。
    必填 ⇒ 漏写就报错、由 `_run_agent` 带错误清单重跑，可自纠，且不留假话。
    """
    with pytest.raises(ValidationError) as ei:
        MaterialOptimizeResult(content="据资料记载……")
    assert "used_sources" in str(ei.value)


def test_empty_content_and_empty_used_sources_are_still_legal():
    """必填 ≠ 非空：`content=""` 与 `used_sources=[]` 都是**合法**输出。

    这一对就是「检索结果与这条素材无关」的合法形态（设计文档 §4.4 的分支）——
    下游据此走整理步。没有这条，后来的维护者很容易把「必填」顺手读成「不许空」，
    或者在 `pick_used_sources` 里加一句「空数组就报错」，把这条正常路径堵死。
    """
    note = "公网未查到与该素材相关的可靠来源，本次不补充内容。"
    m = MaterialOptimizeResult(content="", used_sources=[], note=note)
    assert m.content == ""
    assert m.used_sources == []
    assert m.model_dump() == {"content": "", "used_sources": [], "note": note}


def test_organize_result_has_no_source_fields():
    """整理步的产出契约里**不许**有 `used_sources`（哪怕只有内容与结论）。

    这是「整理态不标出处」的**类型层**保障，与 `test_default_organize_takes_no_search_result`
    的签名层保障配对：那一层保证**喂不进**检索结果，这一层保证**吐不出**引用编号。

    🔴 为什么必须分成两个类（不是「省一个类」的风格问题）：整理步是「公网查不到」时
    **必经**的兜底路径，它连来源都没有，把 `used_sources` 挂上来只会给它新增一个合规面
    （模型漏写 ⇒ 校验失败 ⇒ 重试 ⇒ `assemble_failed`）。而本项目所有流程用例都用**假
    `organize_fn`**，那种回归**全绿也抓不到**。
    """
    assert set(MaterialOrganizeResult.model_fields) == {"content", "note"}
    # 阳性对照：组装步那个类**确实**带着这个字段 —— 少了它，上面那条在
    # 「字段被整体删掉」时也会绿，什么也没证明。
    assert "used_sources" in MaterialOptimizeResult.model_fields


def test_organize_result_keeps_content_required():
    """整理步的 `content` 同样是必填（漏写 ⇒ 报错重跑，而不是静默产出空稿）。"""
    with pytest.raises(ValidationError) as ei:
        MaterialOrganizeResult(note="只有一句话")
    assert "content" in str(ei.value)
