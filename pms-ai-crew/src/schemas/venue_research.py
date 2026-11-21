"""场地网络调研的三步产出契约：候选 → 逐节条目 → （汇总在代码里做）。

🔴 **本模块每个字段的「必填 / 带默认」都是判定权的归属问题**，不是风格：
`LenientModel` 的 extra="ignore" 会让拼错的键名**静默消失**，于是「模型答了但读不到」
与「模型判定查不到」产出同一个结果。同族前科见
`src/schemas/wenlv_material_assist.py` 的 `used_sources` 注释（2026-09-23 上线冒烟查出的缺陷）。

判定规则（照抄 material_assist 的结论）：
 · 字段代表**模型的判断**（「我引用了哪几条来源」「本节查没查到」）⇒ 必填。
   漏写就报错重跑，让人看得见；给默认值等于允许模型不作答而我们替他答。
 · 字段代表**可选的补充信息**（区位线索、素材类型）⇒ 可带默认，
   因为「没给」与「没有」在这个字段上真的同义。
"""

from pydantic import Field

from src.schemas.common import LenientModel


class ResearchCandidate(LenientModel):
    """一个候选调研对象。**即使只有一个强命中也要给候选**（设计文档 §6.2 第 1 步）。"""

    name: str = Field(description="地名全称，如「镇山村」")
    region: str = Field(default="", description="行政区划，如「贵州省贵阳市花溪区」")
    one_liner: str = Field(default="", description="一句话说明这是哪个地方（用于人眼分辨重名）")
    source_urls: list[str] = Field(default_factory=list, description="支撑该候选的来源 URL")
    confidence: str = Field(default="", description="high / medium / low 三选一")
    why: str = Field(default="", description="为什么判断是它（或为什么拿不准）")


class CandidateList(LenientModel):
    """消歧步输出。`candidates` **必填**：漏写即为重跑，不静默产出空列表 ——
    空列表会被上游读成「公网查不到这个场地」，而那是一句我们没有依据的断言。"""

    candidates: list[ResearchCandidate] = Field(description="2~3 个候选，按可信度排序")


class ResearchItem(LenientModel):
    """一条正文条目。

    🔴 `sources` **必填**（可以是 `[]`）：这是设计文档 §6.3 第 1 条硬约束
    「每条必须挂来源编号」在**代码里**的落点 —— 提示词只是请求，必填字段才是闸。
    ⚠️ 必填 ≠ 非空：`[]` 是合法值，含义是「本条没有来源支撑」，由代码决定它的去向
    （进 verify 并标注「AI 推断，无来源」，见 split_items_by_source）。
    """

    title: str = Field(description="条目标题（简体中文，短）")
    content: str = Field(description="条目正文（简体中文；只用检索结果里出现的事实）")
    sources: list[int] = Field(
        description="本条真的引用了其内容的来源编号（1 起，如 [1,3]）；没有来源支撑时给 []。"
                    "**不要**为了凑数把没用到的编号写进来 —— 列了编号就等于说「这条来源支撑了这段话」。",
    )
    # 点位节用：区位线索（「村口古井旁」「上山步道 200 米处」）。其余节留空。
    # 带默认是**有意**的：其余四节本来就没有这个字段，「没给」与「没有区位线索」同义，
    # 不像 sources 那样存在「模型没答 vs 业务为空」的歧义。
    where: str = Field(default="", description="仅点位节：区位线索（不是坐标）")
    # 素材节用：必须是 history/legend/craft/festival/dialect/other 之一。代码侧兜底成 other。
    kind: str = Field(default="", description="仅素材节：素材类型枚举值之一")
    # 设计文档 §6.3 第 1 条的**出口**：模型自己知道这条是推断、没有来源时，把它标出来，
    # 而不是把它塞进正文（塞进正文 = 无来源的内容进了正文条目）。
    inferred: bool = Field(default=False, description="本条是否属于「AI 推断、无来源」")


class SectionResult(LenientModel):
    """一节正文。`items` **必填**：漏写触发重跑。"""

    items: list[ResearchItem] = Field(description="本节条目（可以为空数组 = 本节无内容）")
    # 设计文档 §6.3 第 3 条：「查不到」是一个**正当状态**，必须给它出口 ——
    # 不给出口，模型会为了填满 items 而编（这是本节最容易被写错的一处）。
    not_found: bool = Field(default=False, description="本节公网确实没查到可用资料（正当结果，不是失败）")
    note: str = Field(default="", description="给业务人员看的一句话（查到了什么 / 为什么没查到）")
