// 发布待办清单（publish-todos）：把发布闸的校验错误结构化 + 路由到 AI 修复能力。
//
// 数据源 = 发布闸本体（validateWenlvIntegrity 结构化 issues + validateGraphIntegrity 的 Rn 前缀），
// 保证「待办清单」与「发布 409」永不同源漂移 —— 清单清空 ⇔ 发布必过。
//
// 每条待办带 fixBy 路由：
//   - ai：一键修复（入队对应 AI agent 任务，任务中心跟踪，采纳后重新校验）
//   - manual：人工处理（AI 无法猜业务意图的项，如点位配置、引用改绑）
import { collectWenlvIssues, type IntegrityIssue } from '../wenlv-integrity.js';
import { validateGraphIntegrity } from './node-graph/integrity.js';

export interface PublishTodo {
  /** 稳定错误码（FIX_ROUTING 的键 + 测试钉住）。 */
  code: string;
  /** 人读文案（与发布 409 逐字一致）。 */
  message: string;
  /** 定位实体（待办清单「去处理」深链 + AI 修复入参）。 */
  target?: { kind: string; id: string; name?: string };
  /** 修复方式。 */
  fixBy: 'ai' | 'manual';
  /** fixBy=ai 时的修复动作（前端据此调对应 AI 入队接口）。 */
  aiAction?: {
    /** 对应 npc_jobs.type / 资源任务类型。flow_repair 为产品级流程疏通（边/节点/结局条件 + 线索派挂）。 */
    type: 'node_refine' | 'single_optimize' | 'character_optimize' | 'ending_optimize' | 'batch_generate' | 'skeleton_generate' | 'flow_repair';
    /** 目标实体 id（node_refine→nodeId、single_optimize→npcId、character_optimize→characterId）。 */
    targetId?: string;
    /** 给 AI 的修复提示（入队时透传为 hint/brief）。 */
    hint: string;
    /** 按钮文案。 */
    label: string;
  };
  /** fixBy=manual 时的处理指引（前端深链锚点 key）。 */
  manualHint?: string;
}

/**
 * 错误码 → 修复能力路由表。
 * 未登记的 code 默认 manual —— 清单永不丢项，新增校验规则不登记也能展示（退化为人工处理）。
 */
const FIX_ROUTING: Record<string, (t: PublishTodo['target']) => Pick<PublishTodo, 'fixBy' | 'aiAction' | 'manualHint'>> = {
  // ---- 节点内容类 → node_refine（AI 一键完善剧情） ----
  PUZZLE_REQUIRED: (t) => aiNodeRefine(t, '该节点的谜题缺失，请补一个与剧情契合的完整谜题（题面/选项/答案齐全）'),
  PUZZLE_ANSWER_EMPTY: (t) => aiNodeRefine(t, '该节点谜题答案为空，请补全答案且保证与选项一致'),
  PUZZLE_ANSWER_INVALID: (t) => aiNodeRefine(t, "该节点判断题答案必须是 'true' 或 'false'，请修正谜题"),
  PUZZLE_QUESTION_EMPTY: (t) => aiNodeRefine(t, '该节点互动缺少题干，请补全题面文案'),
  PUZZLE_SECONDS_INVALID: (t) => aiNodeRefine(t, '该节点静坐时长必须是 1~1800 的整数秒，请修正'),
  PUZZLE_TYPE_INVALID: (t) => aiNodeRefine(t, '该节点交互类型非法，请改为合法题型/动作类型'),
  GRAPH_R7: (t) => aiNodeRefine(t, '该 NPC 剧情节点缺少绑定 NPC/章节目标/开场白，或谜题结构不合法，请一次性补全'),
  // ---- NPC 类 → single_optimize ----
  NPC_NO_LINES: (t) => ({
    fixBy: 'ai',
    aiAction: { type: 'single_optimize', targetId: t?.id, hint: '该 NPC 没有任何台词，请补充至少 1 条符合人设的台词', label: 'AI 补台词' },
  }),
  NPC_PORTRAIT_PROMPT_EMPTY: (t) => ({
    fixBy: 'ai',
    aiAction: { type: 'single_optimize', targetId: t?.id, hint: '该 NPC 缺少立绘文生图 prompt，请根据人设生成', label: 'AI 生成立绘描述' },
  }),
  NPC_VOICE_EMPTY: () => ({ fixBy: 'manual', manualHint: '音色需从音色库人工挑选，请打开 NPC 编辑面板选择' }),
  // ---- 角色类 → character_optimize ----
  CHAR_NAME_EMPTY: (t) => aiCharacter(t, '角色名称为空，请生成符合剧情的角色名'),
  CHAR_FACTION_EMPTY: (t) => aiCharacter(t, '角色阵营为空，请根据剧情设定补全阵营'),
  CHAR_IDENTITY_EMPTY: (t) => aiCharacter(t, '角色社会身份为空，请补全（如隐士/捕快/商贾）'),
  CHAR_ATTR_RANGE: (t) => aiCharacter(t, '角色属性超出 0-100 范围，请修正为合理数值'),
  PRODUCT_NO_CHARACTER: () => ({
    fixBy: 'ai',
    aiAction: { type: 'batch_generate', hint: '产品没有任何角色，请根据剧本生成完整角色阵容', label: 'AI 生成角色阵容' },
  }),
  // ---- 结局类 → ending_optimize ----
  NARRATIVE_NO_ENDING: () => ({
    fixBy: 'ai',
    aiAction: { type: 'ending_optimize', hint: '剧情没有任何结局，请根据剧情生成至少 1 个结局（含触发条件）', label: 'AI 生成结局' },
  }),
  ENDING_SAME_CONDITION: (t) => aiEnding(t, '该结局与另一结局触发条件完全相同，请调整触发条件使其可区分'),
  ENDING_DUP_PRIORITY: (t) => aiEnding(t, '该结局与另一结局 priority 重复，请调整优先级'),
  // ---- 结构类 ----
  NARRATIVE_NO_SCENE: () => ({
    fixBy: 'ai',
    aiAction: { type: 'skeleton_generate', hint: '剧情没有任何剧情节点（空气包），请生成完整剧情骨架', label: 'AI 生成剧情骨架' },
  }),
  RALLY_NO_NODE: () => ({
    fixBy: 'ai',
    aiAction: { type: 'skeleton_generate', hint: '集章产品没有节点，请生成发章节点骨架', label: 'AI 生成节点' },
  }),
  // ---- 人工类（AI 无法猜业务意图） ----
  POINT_PRODUCT_NO_VENUE: () => ({ fixBy: 'manual', manualHint: '请先在「产品设置」中选择所属场地' }),
  POINT_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '点位被删或不属于本场地，请重新绑定点位' }),
  POINT_NO_CODE: () => ({ fixBy: 'manual', manualHint: '请到「场地点位」为该点位生成二维码/信标' }),
  POINT_WRONG_VENUE: () => ({ fixBy: 'manual', manualHint: '请改绑本产品场地内的点位' }),
  NODE_STAMP_NO_POINT: () => ({ fixBy: 'manual', manualHint: '发章节点必须绑定物理点位，请打开节点编辑绑定' }),
  NODE_NPC_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '引用的 NPC 已被删除，请打开节点编辑重新绑定或清除' }),
  NODE_NPC_LINE_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '引用的台词已不存在，请打开节点编辑重新选择台词' }),
  NPC_CHARACTER_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '引用的角色已被删除，请打开 NPC 编辑重新绑定' }),
  NODE_REF_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '条件引用了不存在的节点，请打开条件编辑器修正' }),
  // completed 废弃 / 线索无人发放 / 隐秘任务线索断流 / R9 边时序死锁：同一类「流程阻塞」，
  // 统一路由到 flow_repair（机械迁移 completed→visited + all 门安全松弛 + AI 给孤儿线索选发放边），
  // product 级一次疏通，targetId 在 buildPublishTodos 里统一补为 productId。
  COMPLETED_DEPRECATED: (t) => aiFlowRepair(`条件引用了已废弃的 completed 状态（${t?.name ?? t?.id ?? ''}），AI 将自动迁移为 visited 并校验时序`),
  COLLECTIBLE_REF_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '引用了不存在的线索/证物，请修正引用或先创建该证物' }),
  COLLECTIBLE_UNREACHABLE: (t) => aiFlowRepair(`「${t?.name ?? t?.id ?? ''}」需要的线索没有任何节点/边发放，AI 将按剧情选择合适的边补挂发放`),
  COLLECTIBLE_TYPE_INVALID: () => ({ fixBy: 'manual', manualHint: '集章产品只能收集 stamp 型证物，请调整证物类型或引用' }),
  SKILL_REF_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '条件引用了不存在的技能，请修正条件或给角色补该技能' }),
  CHAR_HIDDEN_REF_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '隐秘任务引用了不存在的线索，请修正' }),
  CHAR_HIDDEN_UNREACHABLE: (t) => aiFlowRepair(`角色「${t?.name ?? t?.id ?? ''}」隐秘任务的线索没有发放点，AI 将按剧情补挂到合适的边`),
  REWARD_REF_NOT_FOUND: () => ({ fixBy: 'manual', manualHint: '引用了不存在的奖励，请修正引用或先创建奖励' }),
  TIER_NO_CONDITION: () => ({ fixBy: 'manual', manualHint: '请打开档位编辑设置达成条件' }),
  TIER_NAME_EMPTY: () => ({ fixBy: 'manual', manualHint: '请打开档位编辑补全名称' }),
  TIER_CONDITION_KIND: () => ({ fixBy: 'manual', manualHint: '集章档位条件只能引用 collected，请调整' }),
  RALLY_HAS_ENDING: () => ({ fixBy: 'manual', manualHint: '集章产品不能含结局，请删除结局或改用档位兑奖' }),
  RALLY_NO_TIER: () => ({ fixBy: 'manual', manualHint: '请创建至少 1 个兑奖档位' }),
  RALLY_NO_COLLECTIBLE: () => ({ fixBy: 'manual', manualHint: '请创建至少 1 个可收集物（印章）' }),
  PRODUCT_NAME_EMPTY: () => ({ fixBy: 'manual', manualHint: '请在「产品设置」中填写产品名称' }),
  GRAPH_R1: () => ({ fixBy: 'manual', manualHint: '节点无入边（玩家走不到），请到剧情图连接前置节点' }),
  GRAPH_R3: () => ({ fixBy: 'manual', manualHint: '边引用了不存在的节点，请到剧情图删除/重连该边' }),
  GRAPH_R4: () => ({ fixBy: 'manual', manualHint: '节点绑定的点位不存在，请重新绑定' }),
  GRAPH_R5: () => ({ fixBy: 'manual', manualHint: '触发器关联的节点不存在，请到触发器面板修正' }),
  GRAPH_R6: () => ({ fixBy: 'manual', manualHint: '视角角色已被删除，请重新选择视角角色' }),
  GRAPH_R8: () => ({ fixBy: 'manual', manualHint: '剧情图存在环路，请到剧情图断开回路边' }),
  // R9 边条件时序死锁（自产自锁 / 线索发放点晚于判定点 / completed 恒假 / visited 指下游）
  GRAPH_R9: (t) => aiFlowRepair(`「${t?.name ?? ''}」所在边的条件在时序上无法满足，AI 将疏通死锁条件并把缺失线索补挂到上游边`),
  // R10 商业原子缺免费旁路：旁路方案依赖线下业态设计，AI 无法猜，人工补 config.bypass.how。
  GRAPH_R10: () => ({ fixBy: 'manual', manualHint: '商业原子必须配置免费旁路（旁听/观察/数字替代），请打开节点原子编辑补 config.bypass.how' }),
};

/** 产品级流程疏通：一次修复全剧本的流程阻塞（同产品多条待办会重复入参同一个动作）。 */
function aiFlowRepair(hint: string): Pick<PublishTodo, 'fixBy' | 'aiAction'> {
  return { fixBy: 'ai', aiAction: { type: 'flow_repair', hint, label: 'AI 疏通流程' } };
}

function aiNodeRefine(t: PublishTodo['target'], hint: string): Pick<PublishTodo, 'fixBy' | 'aiAction'> {
  return { fixBy: 'ai', aiAction: { type: 'node_refine', targetId: t?.id, hint, label: 'AI 一键完善' } };
}
function aiCharacter(t: PublishTodo['target'], hint: string): Pick<PublishTodo, 'fixBy' | 'aiAction'> {
  return { fixBy: 'ai', aiAction: { type: 'character_optimize', targetId: t?.id, hint, label: 'AI 完善角色' } };
}
function aiEnding(t: PublishTodo['target'], hint: string): Pick<PublishTodo, 'fixBy' | 'aiAction'> {
  return { fixBy: 'ai', aiAction: { type: 'ending_optimize', targetId: t?.id, hint, label: 'AI 完善结局' } };
}

/** 把图校验的「Rn: 节点「title」…」消息解析成结构化待办（code + 按标题反查 nodeId）。 */
function parseGraphError(msg: string, nodeIdByTitle: Map<string, string>): PublishTodo {
  const m = msg.match(/^R(\d+):/);
  const code = m ? `GRAPH_R${m[1]}` : 'OTHER';
  const titleMatch = msg.match(/「([^」]*)」/);
  const title = titleMatch?.[1];
  const nodeId = title ? nodeIdByTitle.get(title) : undefined;
  const target = nodeId ? { kind: 'node' as const, id: nodeId, name: title } : undefined;
  const routing = FIX_ROUTING[code]?.(target) ?? { fixBy: 'manual' as const };
  return { code, message: msg, target, ...routing };
}

/** 组装某产品的发布待办清单。输入与发布闸完全同参。 */
export async function buildPublishTodos(input: Parameters<typeof collectWenlvIssues>[0] & { product: { id: string } }): Promise<PublishTodo[]> {
  const issues: IntegrityIssue[] = collectWenlvIssues(input);
  const todos: PublishTodo[] = issues.map((i) => {
    const routing = FIX_ROUTING[i.code]?.(i.target) ?? { fixBy: 'manual' as const };
    return { code: i.code, message: i.message, target: i.target, ...routing };
  });
  const graphErrs = await validateGraphIntegrity(input.product.id);
  const nodeIdByTitle = new Map(input.nodes.map((n) => [n.title, n.id]));
  for (const msg of graphErrs) todos.push(parseGraphError(msg, nodeIdByTitle));
  // flow_repair 是产品级动作（一次疏通全剧本），targetId 统一补为 productId。
  for (const t of todos) {
    if (t.aiAction?.type === 'flow_repair') t.aiAction.targetId = input.product.id;
  }
  return todos;
}
