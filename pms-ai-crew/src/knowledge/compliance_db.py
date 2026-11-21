# src/knowledge/compliance_db.py
"""合规审核 8 词库（权威源：wwwskill/knowledge/compliance-databases.md，唯一权威）

risk_level 三档取值：高危 / 高 / 中（排序 高危 > 高 > 中），命中多词取最高档。
安全替换统一以第 8 库为唯一输出口径。
"""

# 第 1 库 极限词库（字段：word / industry / risk_level / safe_expression）
EXTREME_WORDS = [
    {"word": "最好 / 最佳", "industry": "全行业", "risk_level": "高", "safe_expression": "优选、更佳、市场口碑靠前"},
    {"word": "第一", "industry": "全行业", "risk_level": "高", "safe_expression": "位居前列、头部之一（有第三方数据支撑时可用「据 XX 报告」）"},
    {"word": "国家级", "industry": "食品/健康/教育", "risk_level": "高", "safe_expression": "具备真实认证资质时写具体证书名（如「通过 XX 检测」），无资质禁用"},
    {"word": "顶级", "industry": "全行业", "risk_level": "中", "safe_expression": "高端、优质、精工"},
    {"word": "100% / 百分百", "industry": "美妆/健康/食品", "risk_level": "高", "safe_expression": "绝大多数、高达 99%（须有实测依据）"},
    {"word": "永不反弹 / 永不复发", "industry": "美妆/健康", "risk_level": "高", "safe_expression": "长效维持、坚持护理更稳定"},
    {"word": "彻底解决", "industry": "健康/家清/美妆", "risk_level": "高", "safe_expression": "有效缓解、显著改善、逐步改善"},
    {"word": "唯一", "industry": "全行业", "risk_level": "高", "safe_expression": "少数、稀缺、限定款（仅限确有独家授权/专利时使用）"},
    {"word": "独家", "industry": "电商/本地生活", "risk_level": "中", "safe_expression": "本店专供（须确有授权）"},
    {"word": "万能", "industry": "全行业", "risk_level": "高", "safe_expression": "多场景适用、一物多用"},
    {"word": "绝对 / 一定", "industry": "全行业", "risk_level": "高", "safe_expression": "大概率、大概率有效（去掉确定性）"},
    {"word": "根治", "industry": "医疗健康/美妆", "risk_level": "高", "safe_expression": "见第 8 库（长期护理、持续改善）"},
    {"word": "全球首发 / 首创", "industry": "全行业", "risk_level": "中", "safe_expression": "新品上市、新配方上市（须有客观事实）"},
]

# 第 2 库 功效宣传词库（字段同上）
EFFECT_CLAIMS = [
    {"word": "治疗 / 治愈", "industry": "医疗健康", "risk_level": "高", "safe_expression": "缓解、改善、辅助调理（无资质禁用）"},
    {"word": "根治", "industry": "医疗健康", "risk_level": "高", "safe_expression": "见第 8 库（长期护理、持续改善）"},
    {"word": "改善疾病", "industry": "医疗健康/食品", "risk_level": "高", "safe_expression": "改善不适状态（不指向具体疾病）"},
    {"word": "永久美白", "industry": "美妆", "risk_level": "高", "safe_expression": "见第 8 库（提亮肤色、长效护理）"},
    {"word": "快速瘦身 / 7天瘦10斤", "industry": "美妆/食品/运动", "risk_level": "高", "safe_expression": "见第 8 库（记录 7 天体态变化，保留「体态」痛点、去掉承诺数字）"},
    {"word": "消除皱纹 / 消除问题", "industry": "美妆", "risk_level": "高", "safe_expression": "淡化细纹、改善肤感"},
    {"word": "祛斑", "industry": "美妆", "risk_level": "高", "safe_expression": "见第 8 库（淡化斑点、均匀肤色，特殊化妆品备案功效范围内）"},
    {"word": "降三高", "industry": "食品/健康", "risk_level": "高", "safe_expression": "辅助调节、科学管理（保健食品须有蓝帽子）"},
    {"word": "防癌 / 抗肿瘤", "industry": "全行业", "risk_level": "高危", "safe_expression": "严禁与产品功效挂钩，只可引用权威科普"},
    {"word": "抗衰老", "industry": "美妆/食品", "risk_level": "中", "safe_expression": "延缓初老迹象、抗氧化、紧致"},
    {"word": "修复受损细胞", "industry": "美妆/健康", "risk_level": "中", "safe_expression": "修护、滋养、增强屏障"},
    {"word": "增强免疫力", "industry": "食品/健康", "risk_level": "中", "safe_expression": "有保健食品批文才可用「有助于维持免疫」类备案表述"},
]

# 第 3 库 医疗风险词库（疾病名称 + 医疗行为，两问判断）
MEDICAL_RISK = {
    "disease_names": ["糖尿病", "癌症", "高血压", "高血脂", "脱发", "失眠", "近视", "鼻炎", "关节炎", "抑郁症"],
    "treatment_hints": ["治疗", "用药", "药效", "疗程", "处方", "医嘱", "临床试验", "根治"],
    "judge_two_questions": [
        "1. 产品是否具备医疗资质？——是否为药品、三类医疗器械、持有执业许可的医疗机构产品。无资质 → 一切与疾病的因果表述均违规。",
        "2. 是否存在治疗承诺？——是否把产品与「治好 / 治愈 / 治疗某病」建立因果关系。有承诺即触发，无论资质如何都要改写（普通内容平台禁止功效性医疗宣传）。",
    ],
    "examples": [
        {"scene": "糖尿病（与产品绑定）", "risk_level": "高", "handle": "只可作痛点描述「血糖偏高人群」，禁「治疗糖尿病」"},
        {"scene": "癌症", "risk_level": "高危", "handle": "严禁出现与产品功效挂钩的任何表述"},
        {"scene": "高血压", "risk_level": "高", "handle": "仅可「辅助调节、科学管理」，禁「根治高血压」"},
        {"scene": "治疗 / 药效 / 疗程", "risk_level": "高", "handle": "无医疗资质不得使用"},
        {"scene": "脱发", "risk_level": "中", "handle": "痛点保留，见第 8 库「治疗脱发」映射：坚持头皮护理、缓解掉发"},
        {"scene": "失眠", "risk_level": "中", "handle": "改「睡眠质量改善」类表述，禁「治疗失眠」"},
    ],
    "pain_retention": "3. 痛点保留判定：疾病名称若仅用于描述用户痛点场景（如「脱发人群」「血糖偏高人群」）可保留痛点本身，但绝不能接治疗承诺（见通用红线）。",
}

# 第 4 库 收益承诺词库（字段同上）
INCOME_PROMISES = [
    {"word": "稳赚 / 稳赚不赔", "industry": "招商/创业/理财", "risk_level": "高", "safe_expression": "市场有波动，入局需评估"},
    {"word": "保证盈利", "industry": "招商/创业", "risk_level": "高", "safe_expression": "过往案例复盘（不构成承诺）"},
    {"word": "零风险", "industry": "招商/创业", "risk_level": "高", "safe_expression": "低门槛试水、小额测试"},
    {"word": "快速赚钱", "industry": "招商/创业", "risk_level": "高", "safe_expression": "记录经营过程、展示算账逻辑"},
    {"word": "日入过万 / 月入十万", "industry": "招商/创业", "risk_level": "高", "safe_expression": "用真实后台数据，禁主观收益承诺"},
    {"word": "躺着赚钱", "industry": "招商/创业", "risk_level": "中", "safe_expression": "模式讲解、时间安排"},
    {"word": "包赚 / 只赚不赔", "industry": "招商/创业", "risk_level": "高危", "safe_expression": "严禁使用，改为事实性说明"},
    {"word": "年入百万", "industry": "招商/创业", "risk_level": "高", "safe_expression": "个体案例，注明「结果因人而异」"},
    {"word": "无本万利", "industry": "招商/创业", "risk_level": "高", "safe_expression": "启动成本说明、投入产出测算"},
    {"word": "被动收入暴增", "industry": "招商/创业", "risk_level": "中", "safe_expression": "收入结构讲解、时间沉淀"},
]

# 第 5 库 恐惧诱导词库（风险表达 → 正常表达）
FEAR_INDUCTION = [
    {"risk": "不解决一定毁掉", "normal": "很多人容易忽视这个问题"},
    {"risk": "再不用就晚了", "normal": "越早重视，改善越轻松"},
    {"risk": "不用会烂脸", "normal": "皮肤屏障需要认真关注"},
    {"risk": "错过了就后悔一辈子", "normal": "早一步了解，多一种选择"},
    {"risk": "再不防晒就毁容", "normal": "日晒累积会加速老化"},
    {"risk": "不调理就出事", "normal": "长期不注意会影响状态"},
    {"risk": "得了这个就完了", "normal": "发现得早，干预越有效"},
    {"risk": "剩 3 分钟不抢就没了", "normal": "库存有限，按需下单"},
    {"risk": "再不订就没了 / 错过等一年", "normal": "库存有限、按需预订（旅游住宿：旺季房态紧张是客观事实，可陈述紧张度但禁「错过就后悔」式灾难化）"},
    {"risk": "最后几间 / 手慢无", "normal": "房态实时变化，以预订页为准"},
]

# 第 6 库 行业规则库（行业 → 规则要点）
INDUSTRY_RULES = [
    {"industry": "食品", "rule": "不得宣传治疗疾病；保健食品须标注蓝帽子标志及「本品不能代替药物」；普通食品禁止任何功效声称；配料、功效成分如实标注"},
    {"industry": "美妆", "rule": "禁止医疗术语（药妆 / 医用 / 注射级）；特殊化妆品功效宣传不得超过备案范围；禁「永久」效果；禁止与药品功效类比"},
    {"industry": "教育", "rule": "禁止升学 / 提分 / 保过 / 保录承诺；师资资质如实披露；禁止贩卖「学不好就落后」的焦虑"},
    {"industry": "招商", "rule": "禁止收益承诺（稳赚 / 保底回报 / 保证盈利）；须明示投资风险；加盟费、退出机制如实披露；禁止夸大市场份额"},
    {"industry": "医疗健康", "rule": "无医疗资质禁止治疗承诺；禁止推荐处方药；禁止夸大功效；健康科普须提示「个体差异，仅供参考」"},
    {"industry": "本地生活", "rule": "禁止虚假评价 / 刷单；价格与服务承诺一致；团购券有效期与使用条件明示；禁止「全城最便宜」类绝对化；农家乐/乡村游另须禁效果图冒充实景、时令价与节假日加价明示、野生菌/野味禁疗效宣传（详见 `travel-lodging-compliance.md` 第八节）"},
    {"industry": "旅游住宿", "rule": "禁表达：禁「此生必去/最美/全网最低/天花板」类绝对化；禁效果图冒充实景（照骗）、盗用他人图片、夸大房型/海景；禁民宿加盟收益承诺（稳赚/包赚/躺赚）；禁温泉/康养类医疗暗示（治病/理疗）；禁「错过等一年/最后几间」恐吓限时；禁虚标星级、刷单假评价。必披露：退改政策、加价与隐藏消费、有效期与限制、预约核销方式、服务内容边界、资质与安全提示（详见 `travel-lodging-compliance.md`）"},
]

# 第 7 库 平台规则库（platform / category / rule / risk_level）
PLATFORM_RULES = [
    {"platform": "douyin", "category": "美妆个护", "rule": "禁医疗功效宣称；含商业植入内容须标「广告」", "risk_level": "高"},
    {"platform": "douyin", "category": "财经/招商", "rule": "禁收益承诺，账号须持相应资质", "risk_level": "高"},
    {"platform": "douyin", "category": "本地生活", "rule": "禁绝对化「最」；价格服务一致", "risk_level": "中"},
    {"platform": "douyin", "category": "酒旅团购", "rule": "团购券退改/有效期/加价须明示；禁虚假实景（照骗）；禁「最低价」绝对化", "risk_level": "高"},
    {"platform": "douyin", "category": "民宿/景区", "rule": "禁效果图冒充实景；资质证照须真实；禁刷单假评价", "risk_level": "高"},
    {"platform": "douyin", "category": "本地生活·农家乐/乡村游", "rule": "禁效果图冒充实景（照骗）；采摘/餐饮团购券退改、有效期、加价明示；野生菌/野味禁疗效宣传", "risk_level": "高"},
    {"platform": "kuaishou", "category": "食品健康", "rule": "禁疾病治疗宣传；保健食品须有蓝帽子", "risk_level": "高"},
    {"platform": "kuaishou", "category": "教育培训", "rule": "禁保过 / 保录承诺", "risk_level": "中"},
    {"platform": "kuaishou", "category": "本地生活", "rule": "团购券价格与服务承诺一致；禁绝对化「最低」", "risk_level": "中"},
    {"platform": "kuaishou", "category": "本地生活·农家乐/乡村游", "rule": "团购券价格与服务承诺一致；时令价/节假日加价明示；禁绝对化「最低」", "risk_level": "中"},
    {"platform": "xiaohongshu", "category": "美妆种草", "rule": "广告须标「广告 / 赞助」；软文合规", "risk_level": "中"},
    {"platform": "xiaohongshu", "category": "医疗健康", "rule": "禁处方药与治疗承诺", "risk_level": "高"},
    {"platform": "xiaohongshu", "category": "旅游种草", "rule": "广告/赞助须标注；实拍与描述一致；禁 P 图夸大实景", "risk_level": "中"},
    {"platform": "wechat_video", "category": "全品类", "rule": "医疗健康类目禁虚假宣称；导流外链需审核", "risk_level": "高"},
    {"platform": "wechat_video", "category": "教育培训", "rule": "禁保过保录承诺", "risk_level": "中"},
    {"platform": "wechat_video", "category": "电商带货", "rule": "功效表述须与备案一致", "risk_level": "高"},
    {"platform": "wechat_video", "category": "旅游住宿", "rule": "导流外链需审核；禁虚假实景宣传", "risk_level": "高"},
]

# 第 8 库 安全表达替换库（原违规 → 安全表达，唯一替换口径）
SAFE_REPLACEMENTS = {
    "7天瘦10斤": "记录 7 天体态变化（保留「体态」=瘦身关切，去掉承诺数字与绝对「瘦」）",
    "治疗脱发": "坚持头皮护理、缓解掉发（保留「掉发/脱发」痛点，去掉「治疗」医疗承诺）",
    "快速祛斑": "均匀肤色、淡化斑点（保留「斑点」，去掉「快速」与绝对「祛」）",
    "根治痘痘": "坚持护理、稳定痘痘状态（保留「痘痘」痛点，去掉「根治」）",
    "根治": "长期护理、持续改善（保留「问题」关切，去掉根治承诺）",
    "祛斑": "淡化斑点、均匀肤色（保留「斑」痛点，去掉绝对「祛」）",
    "保证不反弹": "坚持护理更稳定（保留「反弹」关切）",
    "不解决一定毁掉": "很多人容易忽视这个问题（保留问题关切，去掉恐吓）",
    "稳赚不赔": "市场有波动，入局需评估（保留「赚钱」诉求，去掉确定性承诺）",
    "永久美白": "提亮肤色、长效护理（保留「肤色」关切，去掉「永久」）",
    "三天见效": "坚持使用感受变化",
    "一次彻底解决": "循序改善、逐步向好（保留改善关切，去掉绝对）",
    "国家级认证": "通过 XX 检测（写具体证书名）",
    "全球第一": "头部品牌之一",
    "此生必去 / 一生必住": "值得一去的目的地、很多人专程来打卡（须真实）",
    "全网最低价 / 最低价": "本店直订价、平台比价有优势（须真实可比）",
    "零差评 / 无差评": "真实入住评价、口碑见评论区",
    "绝无仅有 / 天花板": "稀缺房型、本地区少有的体验",
    "随时退 / 全额退": "按退改政策（见详情页）——转为必披露表述，非承诺",
    "温泉治病 / 理疗 / 治疗失眠": "温泉休闲放松、舒缓疲劳（保留「放松」诉求，去掉医疗承诺）",
    "错过等一年 / 最后几间": "库存有限、按需预订",
    "野生 / 纯天然 / 无农药": "现摘现采、当日直供（须可验证，无认证不得宣称无农药/有机）",
    "免费不限量 / 无限续": "按套餐份量、到店详询",
}

# 汇总（供 compliance_auditor 注入 backstory）
COMPLIANCE_DB = {
    "extreme_words": EXTREME_WORDS,
    "effect_claims": EFFECT_CLAIMS,
    "medical_risk": MEDICAL_RISK,
    "income_promises": INCOME_PROMISES,
    "fear_induction": FEAR_INDUCTION,
    "industry_rules": INDUSTRY_RULES,
    "platform_rules": PLATFORM_RULES,
    "safe_replacements": SAFE_REPLACEMENTS,
}
