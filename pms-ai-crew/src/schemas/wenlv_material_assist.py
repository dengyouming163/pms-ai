"""文化素材 AI 补充的两步产出契约（**组装步一个类、整理步一个类**）。

⚠️ 这里**没有 `found` 字段**，是有意的：判「公网到底查到没查到」的责任在
`src/services/wenlv_material_assist.py` 的 `decide_found()`，不在 LLM。
理由：那句绿字（「公网未查到…」）是本功能的可信度承重点，把判定权交给模型
等于允许它「无来源地说查到了」。模型只负责写内容、并**点名它引用了哪几条来源**，
能不能算数由代码按「有内容 **且** 有被引用的来源」裁定。

🔴 **为什么整理步单独一个类**（2026-09-23 修「序号匹配」时查出，**差点写成事故**）：
两个步骤本来共用一个 `MaterialOptimizeResult`。若把 `used_sources` 加成**必填**而
不拆类，整理步（`_default_organize`）会跟着开始校验失败 → 重试 → `assemble_failed` ——
而整理步正是「公网查不到」时**必经**的兜底路径（连来源都没有，无从引用）。
本项目所有流程用例都用**假 `organize_fn`**，所以那种回归**全绿也抓不到**。
⇒ 契约按步骤分：组装步严（要交代引用了谁），整理步照旧（它没有出处可交代）。

设计依据：docs/superpowers/specs/2026-09-23-wenlv-material-collect-assist-design.md §4.4。
"""

from pydantic import Field

from src.schemas.common import LenientModel


class MaterialOptimizeResult(LenientModel):
    """**组装步**输出：补充后的素材内容 + 引用了哪几条来源 + 给采集员看的一句话结论。"""

    # 🔴 `content` **必填**（无 default），这是复核后有意改的：
    # 两个字段都带默认值时，LLM 把正文吐在别的键名下（`{"optimized_content": …}`）或
    # 干脆漏写 content 键（只给 note），都会被 `LenientModel` 的 extra="ignore" 静默吃掉
    # ⇒ content="" ⇒ 下游 `decide_found()` 判 False ⇒ 界面说「公网未查到」——
    # 把「模型答了但读不到」伪装成「公网真的没有」，且不走重试、不留日志。
    # 改必填后：键缺失 ⇒ pydantic 报错 ⇒ `_run_agent` 带错误清单重跑 ⇒ 耗尽抛
    # `StageFailedError` ⇒ 落 `assemble_failed`（并退还配额），语义正确且可自纠。
    # ⚠️ **必填 ≠ 非空**：`content=""` 仍是**合法值**（设计文档 §4.4：「组装步判定素材
    # 与公网无关 ⇒ `content` 留空」），这条路径一字未变。
    content: str = Field(
        description="补充后的素材内容（简体中文，可以直接入库）。完全补充不出来时给空串。",
    )
    # 🔴 `used_sources` 同样**必填**，理由与 `content` 一模一样，而且它是本类存在的**唯一**
    # 新增理由（2026-09-23 上线冒烟查出的第二个缺陷）：
    #
    # 症状：检索回 10 条**与这条素材无关**的来源；提示词的铁律3 要求模型「content 给空串」，
    #   模型**只遵守了 note 那一半** —— content 写了 32 个字的现场记录整理，
    #   note 写了「公网未查到与这条素材相关的独立来源」。于是 `decide_found`（有内容 且 有来源）
    #   判 True ⇒ 前端展示**「AI 补充」卡片 + 10 条无关来源链接 + 一个「合并」动作**。
    #   本该是绿底「AI 整理」，实际是「AI 补充」—— 而这一态的判定，实际上被交给了 LLM
    #   去遵守一条**要求它主动作废自己产出**的规则（与本模块头注「判定权在代码里」相反）。
    #
    # 修法（序号匹配）：把「哪几条来源支撑了这段话」变成模型必须**点名**的字段 ——
    #   检索结果带编号喂给它，它回 `[1,3]`；与素材无关时回 `[]`。
    #   `[]` ⇒ 收窄后来源为空 ⇒ `decide_found` 判 False ⇒ 走整理步（绿底）。
    #   **判定权回到代码**：模型只需如实回答「我引用了哪几条」，不必自己作废产出。
    #
    # ⚠️ 为什么不能给 default（哪怕 `default_factory=list` 看起来更安全）：缺省 `[]` 会让
    #   「模型漏写了这个键」与「模型判定无关」**产出同一个结果**——绿底卡 + 那句
    #   「公网未查到你这条素材的独立来源」。来源明明查到、只是没被点名时，这句话就是**假话**，
    #   正是 `content` 那条注释所防的同一种伪装。必填 ⇒ 漏写就报错重跑，可自纠且不留假话。
    used_sources: list[int] = Field(
        description=(
            "你在 content 里**真的引用了其内容**的来源编号（1 起，如 [1,3]）。"
            "检索结果与这条素材无关时给空数组 []。**不要**为了凑数把没用到的编号写进来。"
        ),
    )
    note: str = Field(
        default="",
        description="给采集员看的一句话结论，例如「公网未查到与该素材相关的独立来源」。",
    )


class MaterialOrganizeResult(LenientModel):
    """**整理步**输出：只整理一手材料，**没有任何出处字段**。

    ⚠️ **不要**把它与 `MaterialOptimizeResult` 合并成一个类（见本模块头注的 🔴）：
    整理步没有来源可引用，把 `used_sources` 挂在它头上只会给「公网查不到」这条
    必经兜底路径新增一个**合规面**（模型若漏写 ⇒ 校验失败 ⇒ 重试 ⇒ `assemble_failed`），
    而所有流程用例都用假 `organize_fn`，抓不到。
    """

    # 必填的理由与组装步的 `content` 逐字相同（漏写 ⇒ 报错重跑，而不是静默产出空稿）。
    content: str = Field(
        description="整理后的素材内容（简体中文，可以直接入库）。整理不出来时给空串。",
    )
    note: str = Field(
        default="",
        description="给采集员看的一句话结论。⚠️ 整理态的展示 note 由代码拥有，本字段只是契约占位。",
    )
