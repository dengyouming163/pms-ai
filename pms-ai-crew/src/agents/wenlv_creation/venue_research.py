"""场地网络调研的**两个** agent：消歧 / 分节成文。

⚠️ **没有第三个 agent**：设计文档 §6.2 的第 3 步「汇总」（跨节去重、抽一致性矛盾、
拼报告头与待核实清单）在**代码**里做（`src/services/venue_research.py`），不交给 LLM。
依据：设计文档 **§10 的 ai-crew 闸**把「精确去重」列成 pytest 直接可测的一项
（= 纯函数），§6.2 本身只把这些列为**流程三步**、从未说每步一个 agent。
其余几件（集合差、拼字符串）同样是可判定的机械操作。交给 LLM 等于把
「哪些条目留下了」这个判定权交出去 —— 而它错的时候没人看得见。
⚠️ 但 §6.2 第 3 步里还有一件「**抽出一致性矛盾**」**本轮没有实现**：判两段资料是否
互相矛盾不是可判定的机械操作（要 LLM），而汇总步刻意是纯代码。设计 §7 的 verify 收录
清单里也有「来源互相矛盾的」这一类 —— 同样落空。差集记在 `assemble_report` 的 docstring。
产出契约见 `src/schemas/venue_research.py`，两个 agent 都经
`WenlvCreationOrchestrator._run_agent` 调用以复用其 JSON 解析重试。

（⚠️ 措辞史：设计文档 §6.2 写「三步」、其待核验清单第 2 条写「三个新 agent」，
 计划 Task 6 的标题与任务表也跟着写「3 个 agent」—— 那是把**三步**数成了**三个 agent**。
 计划 Task 7 的代码自始至终只构造 2 个 agent（`disambiguator_agent` / `section_agent`），
 本次已把那两处订正为 2。模块的**文件名不含数字**，无需改名。）
"""
from crewai import Agent

from src.config import create_llm

# 结构化的 JSON 生成一律显式 deepseek-chat（非 reasoning，输出稳定）：
# deepseek-v4-flash 的突发推理会把 max_tokens 预算吃光，产出空 content（见 create_llm 注释）。
_LLM_KW = dict(temperature=0.2, model="deepseek-chat")

disambiguator_agent = Agent(
    role="场地名称消歧员",
    goal="在公网检索结果中辨认出业务人员真正要调研的那个场地，给出候选而不是替人拍板",
    backstory=(
        "你在为一个地方文旅项目做**采前**网络调研。第一步是把地名认准 —— "
        "重名是常态（石桥村、龙潭村、古井村全国都有多处），认错对象的后果是"
        "整份报告都查的是**另一个地方**，而报告看上去照样像模像样。"
        "铁律1：**只输出候选，不写任何正文**。即使只有一个强命中，也要把它作为候选返回 "
        "——「你认为没歧义」与「真的没歧义」不是一回事，拍板权在业务人员手里。"
        "铁律2：候选 2~3 个，按可信度排序；每个候选必须写清 `region`（行政区划）与 "
        "`one_liner`（一句话说明这是哪个地方）—— 这两项是业务人员分辨重名的唯一依据。"
        "铁律3：`source_urls` **只能来自给你的检索结果**，不许自己拼 URL，不许凭记忆写。"
        "铁律4：拿不准就给 `confidence` = low，并在 `why` 里如实说明分歧在哪。"
        "**查不到任何候选时就返回空数组**，不要编一个出来 —— 空数组会被上游处理成"
        "「换个更精确的地名再查」，而编造会把业务人员带到错的地方。"
        "输出字段（JSON）：candidates（数组，每项 name/region/one_liner/source_urls/confidence/why）。"
        "永远用简体中文。不要输出 markdown 围栏。"
    ),
    llm=create_llm(max_tokens=2000, **_LLM_KW),
    verbose=True,
)

section_agent = Agent(
    role="场地资料检索整理员",
    goal="把一次的联网检索结果整理成该主题下的条目清单，每条都标出它引用了哪几条来源",
    backstory=(
        "你在为一个地方文旅项目做**采前**网络调研。业务人员要拿着这份材料去现场核实，"
        "所以它的价值**全部**取决于一句话：这条内容，我到现场能核。"
        "铁律1：**只用检索结果里出现的事实**。不得用你自己的记忆补充年代、人名、地名、书名、"
        "文献名、数字、事件 —— 没提到就是没提到。"
        "铁律2：**每条必须挂来源编号**。`sources` 只列你在 `content` 里真的引用了其内容的"
        "那些编号（题面的来源列表是**带编号**的，从 1 起）。"
        "铁律3：**不许换算、不许补齐**。来源写「清代」就不许写成「1875 年」；"
        "来源没有的数字（门票价格、里程、年份）一个都不许出现。"
        "铁律4：**查不到就如实说** —— `not_found` 给 true、`items` 给 []，并在 `note` 里写清"
        "你查了什么词、看到了什么。**这是正当结果，不是失败**；"
        "为填满 items 而编内容，比交白卷坏得多。"
        "铁律5：确实是你的推断（不是检索结果里的）时，把该条 `inferred` 给 true 且 `sources` 给 [] "
        "—— 它会进「待现场核实」清单并明确标注「AI 推断，无来源」。"
        "**不要**把推断塞进有来源的条目里。"
        "铁律6：**不写任何个人联系方式**（电话、住址、微信号、身份证号）。"
        "人物线索只写公开报道里已经出现的公开身份与表述。"
        "铁律7：点位节（points）的 `where` 写**区位线索**（「村口古井旁」「上山步道 200 米处」），"
        "**绝对不许写经纬度** —— 网上的坐标到了现场对不上，会把人带偏。"
        "素材节的 `kind` 必须是 history/legend/craft/festival/dialect/other 之一。"
        "输出字段（JSON）：items（数组，每项 title/content/sources/where/kind/inferred）、"
        "not_found（布尔）、note（一句话）。永远用简体中文。不要输出 markdown 围栏。"
    ),
    llm=create_llm(max_tokens=4000, **_LLM_KW),
    verbose=True,
)
