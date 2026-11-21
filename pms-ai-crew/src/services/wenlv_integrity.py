"""文旅内容完整性校验（落库/publish 前置，纯函数无 IO）。

逐条对齐 pms-server src/services/wenlv-integrity.ts 的 narrative/rally 分流规则：
- narrative：至少 1 scene + 至少 1 ending；节点/结局的引用闭环。
- rally：禁 ending、须档位/可收集物/点位；档位 condition 只引 collected 且须 stamp；
  谜题须可判定（禁 photo、答案非空）。

输入为落库前的语义化中间结构（LevelNode 字段：unlock_collected/unlock_completed/
grant_collectibles/complete_nodes；character 字段：id/name 与其**嵌套**的
hidden_quest.collectible_ids —— 读成扁平键 hidden_quest_collectible_ids 不会报错，
只会一条规则都不触发），输出错误文案数组（空=通过）。
"""

import json

# 需要判定答案的题型。puzzle 节点只能用它；scene 节点也可用，
# 但语义是「剧情回味」—— 答对只给正反馈，不改变进度状态。
QUIZ_TYPES = ("single", "multiple", "judge", "input")
# 无需服务端判定、只能在现场做的动作。**只允许出现在 scene 节点**：
# photo 是拍照水印分享，meditate 是静坐计时。
ACTION_TYPES = ("photo", "meditate")


def collect_skill_refs(cond, out=None):
    """递归收集条件树中所有 skill 引用的 id（R4 用）。

    与 TS 侧 collectSkillRefs 逐字同构。与 collectRefs（可达性检查）分开：后者跳过 skill，
    这里只收 skill 引用——技能不参与节点/线索可达性判定，但必须指向某个角色拥有的技能。
    """
    if out is None:
        out = []
    if not cond:
        return out
    if cond.get("type") == "ref" and (cond.get("ref") or {}).get("kind") == "skill":
        out.append(cond["ref"]["id"])
    elif cond.get("type") in ("all", "any"):
        for c in (cond.get("conditions") or []):
            collect_skill_refs(c, out)
    elif cond.get("type") == "nofM":
        for c in (cond.get("of") or []):
            collect_skill_refs(c, out)
    return out


def validate_wenlv_integrity(input_data: dict) -> list[str]:
    errs: list[str] = []
    product = input_data.get("product") or {}
    nodes = input_data.get("nodes") or []
    collectibles = input_data.get("collectibles") or []
    endings = input_data.get("endings") or []
    rewards = input_data.get("rewards") or []
    tiers = input_data.get("tiers") or []
    # R3 用。**另取名字**：下方 NPC 块（`if npcs is not None:` 内）会把 `characters` 重绑为
    # `input_data.get("characters")`（R-N3 故意要区分「None」与「空 list」）。共用那个名字时，
    # 两种形态都是**整函数抛异常**（而不是返回错误清单），只是异常类型不同：
    #   · 未传 `npcs` ⇒ 该块不进入 ⇒ `characters` 这个名字整个函数从未绑定 ⇒ UnboundLocalError（主导形态）；
    #   · 传了 `npcs` 但没传 `characters` ⇒ 该块把它绑成 None ⇒ TypeError: 'NoneType' object is not iterable。
    # 故这里另取 `r3_chars`。
    r3_chars = input_data.get("characters") or []

    if not (product.get("name") or "").strip():
        errs.append("产品名称不能为空")

    node_ids = {n.get("id") for n in nodes if n.get("id")}
    collectible_ids = {c.get("id") for c in collectibles if c.get("id")}
    reward_ids = {r.get("id") for r in rewards if r.get("id")}
    stamp_ids = {c.get("id") for c in collectibles if c.get("type") == "stamp"}

    # 可达性（2026-09-15）。上面各条只查「引用存在」，于是「引用了存在、但**永不被满足**的 id」
    # 静默通过。引擎语义（pms-server src/services/wenlv-engine.ts:37-38 是**引擎内**唯二写入点，已逐行核实）：
    #   - state.collected 由 effects.grant 写入（⚠️ 引擎之外另有运营侧补印直写，见下）；
    #   - state.completed 只由 effects.complete 写入（markVisited 只写 visited，与二者独立）。
    # 故不在下面两个集合里的引用在**引擎路径**上永远无法满足。⚠️ 例外（已核 2026-09-30）：collected
    # 另有运营侧人工补印直写（assist-grant，pms-server routes/admin/wenlv.ts:3220，不要求任何节点发放）
    # ⇒ 对「只能靠补印拿到」的线索，本闸仍按「无节点发放」拦（行为符合 spec §9，但错因文案与事实不符）。
    #
    # 生产实测（同日走查）：AI 生成的剧本里 scene 节点普遍不自 complete，后继节点却把前一个 scene
    # 当作 completed 引用 ⇒ 第 2 关硬死锁，玩家玩不下去；全库 4 个产品共 28 处。同批还发现 3 条
    # 线索无任何节点发放却被 4 个结局写进触发条件。TS 侧同名规则在同一次提交里落地，两份须逐条对齐。
    grantable_ids = set()
    completable_ids = set()
    for n in nodes:
        for cid in n.get("grant_collectibles") or []:
            grantable_ids.add(cid)
        for nid in n.get("complete_nodes") or []:
            completable_ids.add(nid)

    def _check_grant(label, grant_ids, stamp_check=False):
        for cid in grant_ids or []:
            if cid not in collectible_ids:
                errs.append(f"{label} effects.grant 引用不存在的线索 {cid}")
            elif stamp_check and cid not in stamp_ids:
                errs.append(f"{label} effects.grant 引用 {cid} 非印章（stamp）可收集物，集章产品只能盖章收集")

    def _check_complete(label, complete_ids):
        for nid in complete_ids or []:
            if nid not in node_ids:
                errs.append(f"{label} effects.complete 引用不存在的节点 {nid}")

    def _check_unlock(label, unlock_collected, unlock_completed, stamp_check=False):
        for cid in unlock_collected or []:
            if cid not in collectible_ids:
                errs.append(f"{label} unlock_condition 引用不存在的线索 {cid}")
                continue
            if stamp_check and cid not in stamp_ids:
                errs.append(f"{label} unlock_condition 引用 {cid} 非印章（stamp）可收集物，集章产品只能盖章收集")
            if cid not in grantable_ids:
                errs.append(f"{label} 引用线索 {cid}，但没有任何节点发放它 —— 该条件永远无法满足；"
                            f"请让某个节点的 grant_collectibles 包含 {cid}")
        for nid in unlock_completed or []:
            if nid not in node_ids:
                errs.append(f"{label} unlock_condition 引用不存在的节点 {nid}")
                continue
            if nid not in completable_ids:
                errs.append(f"{label} 要求节点 {nid} 已完成（completed），但没有任何节点的 "
                            f"effects.complete 会完成它 —— 该条件永远无法满足；"
                            f"请在产出该节点的节点（通常是它自己）的 complete_nodes 里补上 {nid}")

    def _check_npc_refs(nodes, npcs, char_ids):
        """NPC 引用完整性（R-N1~R-N4，spec §9）。与 TS 侧 wenlv-integrity.ts 的
        NPC 校验块**逐字同构**（文案含 R-Nx 编号便于定位）。在 mode 分流之前调用 ——
        narrative/rally 两种 mode 都可能有 NPC 出场，NPC 引用与 mode 无关。

        跳过条件（与 TS 侧逐字同构）：
        - 调用方未传 npcs（None）⇒ 不进入本函数（R-N1~R-N4 全跳过，向后兼容）；
        - 节点无 npc_id ⇒ 跳过该节点的 R-N1/R-N2（老剧本零迁移）；
        - npc 无 character_id ⇒ 跳过该 npc 的 R-N3（spec：若存在）；
        - char_ids 为 None（characters 未传）⇒ R-N3 跳过（但 R-N1/R-N2/R-N4 仍跑）。
        """
        npc_map = {n.get("id"): n for n in npcs if n.get("id")}
        # NPC 标签：同时含 name 与 id，name 缺省时退化为裸 id（与「节点[title]」同款的人读优先）。
        # 两者都给是因为 NPC 名字在产品内可能重复，id 才是数据库里的稳定锚点 —— 操作员排查需要 id。
        def _npc_label(npc):
            name = npc.get("name")
            nid = npc.get("id", "")
            return f"{name}({nid})" if name else str(nid)
        # R-N1 / R-N2：节点级
        for n in nodes:
            npc_id = n.get("npc_id")
            if not npc_id:
                continue  # 老剧本节点无 npc_id ⇒ 跳过 R-N1/R-N2
            npc = npc_map.get(npc_id)
            # R-N1：node.npc_id（若存在）必须在 product.npcs 内
            if not npc:
                errs.append(f"节点[{n.get('title')}] 引用的 NPC {npc_id} 不存在（R-N1）")
                continue  # NPC 不存在 ⇒ R-N2 无 NPC 可对照，跳过该节点的 R-N2
            # R-N2：node.npc_line_ids 每项必须存在于该 NPC.lines.id
            line_ids = {l.get("id") for l in (npc.get("lines") or []) if l.get("id")}
            for lid in (n.get("npc_line_ids") or []):
                if lid not in line_ids:
                    errs.append(f"节点[{n.get('title')}] 引用的台词 {lid} 不在 NPC[{_npc_label(npc)}] 的 lines 内（R-N2）")
        # R-N3 / R-N4：NPC 级
        for npc in npcs:
            # R-N4：lines 至少 1 条（强制约束，与 character 不可为空同款）；id 在该 NPC 内唯一
            npc_lines = npc.get("lines") or []
            if not npc_lines:
                errs.append(f"NPC[{_npc_label(npc)}] 至少需要 1 条台词（R-N4）")
            else:
                seen = set()
                for l in npc_lines:
                    lid = l.get("id")
                    if lid in seen:
                        errs.append(f"NPC[{_npc_label(npc)}] 的台词 {lid} 重复（R-N4）")
                    else:
                        seen.add(lid)
            # R-N3：npc.character_id（若存在）必须在 product.characters 内。
            # characters 未提供（char_ids is None）⇒ 跳过；character_id 缺省 ⇒ 跳过该 npc。
            char_id = npc.get("character_id")
            if char_ids is not None and char_id and char_id not in char_ids:
                errs.append(f"NPC[{_npc_label(npc)}] 引用的角色 {char_id} 不存在（R-N3）")

    def _check_interactions(label, node_type, interactions):
        """交互规则（S4④）。**必须在两个 mode 下对每个节点都跑** ——
        与 pms-server src/services/wenlv-integrity.ts 的 checkInteractions **必须逐字同构**。
        分叉会让同一份内容在一侧通过、另一侧被拦。"""
        items = interactions if isinstance(interactions, list) else []

        def _type_of(it):
            return it.get("type") if isinstance(it, dict) else None

        def _is_quiz(t):
            return t in QUIZ_TYPES

        def _answer_empty(t, ans):
            # 与 TS 侧 `ans === undefined || ans === null || String(ans).trim() === ''` 等价。
            # ⚠️ 非 multiple 分支**不能**直接用 `str(ans)`：JS 的 String([]) 是 ''，
            # 而 Python 的 str([]) 是 '[]' —— 实测的分叉（答案为空数组时 TS 拦、Python 放行）。
            if t == "multiple":
                return not isinstance(ans, list) or len(ans) == 0
            if isinstance(ans, list):
                # 复刻 JS String(array) === array.join(',')，null/undefined 元素渲染成空串
                return ",".join("" if x is None else str(x) for x in ans).strip() == ""
            return ans is None or str(ans).strip() == ""

        def _check_quiz_fields(label, t, it):
            # ⚠️ 与 TS 侧 wenlv-integrity.ts 的 checkQuizFields 逐字同构。
            # judge 的答案域见 TS 注释（全链路只认 'true' | 'false'）。
            ans = it.get("answer") if isinstance(it, dict) else None
            if _answer_empty(t, ans):
                errs.append(f"{label} {t} 题型答案不能为空")
                return
            if t == "judge" and ans != "true" and ans != "false":
                errs.append(f"{label} judge 题型答案只能是 'true' 或 'false'，当前是 {json.dumps(ans, ensure_ascii=False)}")

        if node_type == "puzzle":
            if len(items) == 0:
                errs.append(f"谜题[{label}] 必须有交互题目")
                return
            for it in items:
                t = _type_of(it)
                if not _is_quiz(t):
                    errs.append(f"谜题[{label}] 不接受 {t} 交互（拍照打卡 / 静坐计时请用 scene 节点）")
                    continue
                _check_quiz_fields(f"谜题[{label}]", t, it)
            return

        # scene（以及未来的其它非 puzzle 类型）：承载「剧情回味题」+「现场动作」
        for it in items:
            t = _type_of(it)
            if _is_quiz(t):
                _check_quiz_fields(f"节点[{label}]", t, it)
                continue
            if t in ("photo", "meditate"):
                # 现场动作**必须有题干** —— 与 TS 侧逐字同构（见 wenlv-integrity.ts 的 checkInteractions 里 t === 'photo' || t === 'meditate' 那个分支；不写行号：行号会随对方文件增长漂移）。
                # 前端 photo/meditate 两个分支都直接渲染 question，空的会让游客看到无字弹层。
                q = it.get("question")
                # TS 是 `typeof q !== 'string' || q.trim() === ''`；Python 的 str 无 trim，
                # 用 .strip()。两边都必须把「非字符串」与「纯空白」都判为缺失。
                if not isinstance(q, str) or q.strip() == "":
                    label_cn = "拍照打卡" if t == "photo" else "静坐计时"
                    errs.append(f"节点[{label}] {label_cn}缺少题干（question 不能为空）")
                if t == "meditate":
                    s = it.get("seconds")
                    # 与 TS 的 Number.isInteger 等价：接受「整数值的 float」（JSON 里 60.0 与 60 同义），
                    # 拒绝 bool（Python 的 bool 是 int 子类，不排掉会把 True 当成 1 秒）、
                    # 拒绝 NaN/Infinity/非整值 float。实测分叉：60.0 在 TS 通过、在 Python 曾误报。
                    is_int_like = (isinstance(s, int) and not isinstance(s, bool)) or \
                                  (isinstance(s, float) and s.is_integer())
                    # ⚠️ 短路是必需的：`not is_int_like` 为真时 `s < 1` 不会被求值，
                    # 否则 None/str 之类的非数值类型会在这里抛 TypeError。
                    if not is_int_like or s < 1 or s > 1800:
                        errs.append(f"节点[{label}] 静坐时长必须是 1~1800 的整数秒")
                # 🔴 收敛成一个 continue：原来 photo / meditate 各自分支各一个；
                # 漏掉它会掉到函数末尾的「交互类型非法」兜底，每个现场动作节点多报一条 ⇒ 与 TS 分叉。
                continue
            errs.append(f"节点[{label}] 交互类型 '{t}' 非法（只能是 {'/'.join(QUIZ_TYPES + ACTION_TYPES)}）")

    # NPC 引用完整性（R-N1~R-N4，spec §9）。**在 mode 分流之前** —— 与 TS 侧
    # wenlv-integrity.ts 的 NPC 校验块同位置（mode 分流前，narrative/rally 共享）。
    # 跳过条件：input_data["npcs"] 未提供（None）⇒ R-N1~R-N4 全部跳过（向后兼容
    # 既有调用点；T13 才在 publish 调用点组装 npcs/characters 入参）。
    # **用 `is not None` 守卫**：传空 list 也要进入校验（与 TS 侧 `if (input.npcs)`
    # 对空数组的 truthy 同构 —— TS 的 [] 是 truthy，会进入校验但遍历空数组无操作）。
    npcs = input_data.get("npcs")
    if npcs is not None:
        characters = input_data.get("characters")
        # characters 未传（None）⇒ char_ids=None ⇒ R-N3 跳过（但 R-N1/R-N2/R-N4 仍跑）。
        # characters 传空 list ⇒ char_ids=set() ⇒ R-N3 仍跑，character_id 不在空集 ⇒ 报错
        # （与 TS 侧 `input.characters ? new Set(...) : null` 对空数组的 truthy 同构）。
        char_ids = ({c.get("id") for c in characters if c.get("id")}
                    if characters is not None else None)
        _check_npc_refs(nodes, npcs, char_ids)

    # R3 隐秘任务引用可达（spec §9）。**narrative 与 rally 都查** —— 与 TS 侧
    # pms-server/src/services/wenlv-integrity.ts 的同名块同位置（NPC 块之后、rally 分流之前），
    # 规则与错误文案逐条对齐（spec §8.3③）。
    #
    # 入参形状＝**schema 写下的形状**：`Character.hidden_quest` 是**嵌套**的，`collectible_ids`
    # 在其下、无 alias（见 src/schemas/wenlv_creation.py 的 Character / HiddenQuest）。与
    # `unlock_collected` 同款约定 —— 本文件从不「先摊平再读」。读成扁平键
    # （`hidden_quest_collectible_ids`）不会报错，只会**一条规则都不触发**（恒 0 命中，静默失效）。
    for ch in r3_chars:
        for cid in ((ch.get("hidden_quest") or {}).get("collectible_ids") or []):
            who = f"角色[{ch.get('name') or ch.get('id')}]"
            if cid not in collectible_ids:
                errs.append(f"{who} 的隐秘任务引用了不存在的线索 {cid}")
            elif cid not in grantable_ids:
                errs.append(f"{who} 的隐秘任务引用了没有任何节点发放的线索 {cid}——该隐秘任务永远无法完成")

    # R1（spec §9）：产品至少需要 1 个角色。
    # 跳过条件：input_data["characters"] 未提供（None）⇒ 跳过（老调用点不传，不炸）。
    # 空 list = 传了但 0 个角色 ⇒ 报错（与 R3 同口径：传了就校验）。
    # **必须用 `is not None` 守卫**：r3_chars 已把 None 转成 []，无法区分「未传」与「传了空数组」。
    if input_data.get("characters") is not None and len(input_data["characters"]) == 0:
        errs.append("产品至少需要 1 个角色（R1）")

    # R4（spec §9）：条件树中的 skill 引用必须指向某个角色拥有的技能。
    # 收集范围：nodes[].unlock_condition、endings[].trigger_condition、tiers[].condition、
    #           nodes[].interactions[].requires。
    # 跳过条件：input_data["characters"] 未提供。
    chars = input_data.get("characters")
    if chars and len(chars) > 0:
        valid_skill_ids = set()
        for ch in chars:
            for s in (ch.get("skills") or []):
                if s.get("id"):
                    valid_skill_ids.add(s["id"])
        skill_refs = set()
        for n in nodes:
            skill_refs.update(collect_skill_refs(n.get("unlock_condition")))
        for e in endings:
            skill_refs.update(collect_skill_refs(e.get("trigger_condition")))
        for t in tiers:
            skill_refs.update(collect_skill_refs(t.get("condition")))
        for n in nodes:
            for it in (n.get("interactions") or []):
                skill_refs.update(collect_skill_refs((it or {}).get("requires")))
        for sid in skill_refs:
            if sid not in valid_skill_ids:
                errs.append(f"条件引用了不存在的技能 {sid}（R4）：没有任何角色拥有该技能")

    if product.get("mode") == "rally":
        if len(endings) > 0:
            errs.append("集章产品不能包含结局（ending），请用 reward_tiers 表达兑奖")
        if len(tiers) == 0:
            errs.append("集章产品至少 1 个档位（reward_tier）才能发布")
        if len(collectibles) == 0:
            errs.append("集章产品至少 1 个可收集物")
        if len(nodes) == 0:
            errs.append("集章产品至少 1 个点位节点")
        for t in tiers:
            label = f"档位[{t.get('name') or t.get('id')}]"
            if not (t.get("name") or "").strip():
                errs.append(f"档位[{t.get('id')}] 名称不能为空")
            collected_ids = t.get("collected_ids") or []
            if not collected_ids:
                errs.append(f"{label} 必须设置达成条件（condition）")
            for cid in collected_ids:
                if cid not in collectible_ids:
                    errs.append(f"{label} 引用不存在的线索 {cid}")
                    continue
                if cid not in stamp_ids:
                    errs.append(f"{label} 引用 {cid} 非印章（stamp）可收集物，集章产品只能盖章收集")
                # 可达性：无人发放的印章 ⇒ 该档位永远达不成（与 _check_unlock 同源，档位走独立循环）
                if cid not in grantable_ids:
                    errs.append(f"{label} 引用印章 {cid}，但没有任何节点发放它 —— 该档位永远无法达成；"
                                f"请让某个发章节点的 grant_collectibles 包含 {cid}")
            rid = t.get("reward_id")
            if rid and rid not in reward_ids:
                errs.append(f"{label} 引用不存在的奖励 {rid}")
        for n in nodes:
            label = f"节点[{n.get('title')}]"
            _check_unlock(label, n.get("unlock_collected"), n.get("unlock_completed"), stamp_check=True)
            _check_grant(label, n.get("grant_collectibles"), stamp_check=True)
            _check_complete(label, n.get("complete_nodes"))
            _check_interactions(n.get("title"), n.get("node_type"), n.get("interactions"))
        return errs

    # narrative：空气包拦截。二元节点模型下 scene/npc 均为一等可玩节点，
    # 纯 NPC 剧本合法（与 pms-server wenlv-integrity.ts NARRATIVE_NO_SCENE 同构）。
    playable_count = sum(1 for n in nodes if n.get("node_type") in ("scene", "npc"))
    if playable_count == 0:
        errs.append("至少 1 个剧情节点（scene/npc）才能发布")
    if len(endings) == 0:
        errs.append("至少 1 个结局（ending）才能发布")
    for n in nodes:
        label = f"节点[{n.get('title')}]"
        _check_unlock(label, n.get("unlock_collected"), n.get("unlock_completed"))
        _check_grant(label, n.get("grant_collectibles"))
        _check_complete(label, n.get("complete_nodes"))
        _check_interactions(n.get("title"), n.get("node_type"), n.get("interactions"))
    # 结局互斥性做不到，但**可区分性**必须做到 —— 与 pms-server/src/services/wenlv-integrity.ts 同规则。
    # ① 引用集合完全相同：两个结局在任何状态下同真同假 ⇒ 硬拒。
    # ② priority 重复：解析靠 priority 决胜，平手只能退化到 id 字典序（任意）⇒ 要求作者显式打破。
    # （空 collected_ids 的无条件结局会全部落到 key == "" ⇒ 第二个即报①。这是**有意**的：
    #  两个无条件结局确实无法区分，且与 TS 侧行为一致。）
    seen_refs: dict[str, str] = {}       # key: 排序去重后的 collected_ids 串 → 结局 title
    seen_priority: dict[int, str] = {}   # priority → 结局 title
    for e in endings:
        label = f"结局[{e.get('title')}]"
        for cid in e.get("collected_ids") or []:
            if cid not in collectible_ids:
                errs.append(f"{label} trigger_condition 引用不存在的线索 {cid}")
                continue
            # 可达性：无人发放的线索 ⇒ 该结局永不触发（生产实测有 3 条这样的孤儿线索 + 4 个不可达结局）
            if cid not in grantable_ids:
                errs.append(f"{label} 引用线索 {cid}，但没有任何节点发放它 —— 该条件永远无法满足；"
                            f"请让某个节点的 grant_collectibles 包含 {cid}")
        rid = e.get("reward_id")
        if rid and rid not in reward_ids:
            errs.append(f"{label} 引用不存在的奖励 {rid}")
        key = "|".join(sorted(set(e.get("collected_ids") or [])))
        prev = seen_refs.get(key)
        if prev:
            errs.append(f"{label} 与 结局[{prev}] 的达成条件完全相同（引用了同一组线索）"
                        f"—— 玩家拿到哪一个无意义，请合并或改条件")
        else:
            seen_refs[key] = e.get("title")
        pr = int(e.get("priority") or 0)
        prev_pr = seen_priority.get(pr)
        if prev_pr:
            errs.append(f"{label} 与 结局[{prev_pr}] 的 priority 重复（都是 {pr}）"
                        f"—— 平手时解析会退化到 id 字典序，请给二者不同的 priority")
        else:
            seen_priority[pr] = e.get("title")
    return errs
