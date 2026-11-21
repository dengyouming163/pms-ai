import type { WenlvNpcPersona, WenlvChapterGoal, WenlvNpcRelationship, WenlvNpcMention } from '../../../db/schema/wenlv.js';
import type { VisualAnchor } from './visual-anchor.js';

/**
 * 构建 NPC 对话的 System Prompt。
 * 人格卡 + 章节目标 + 跨章节记忆，组装成 LLM 的行为约束。
 */
export function buildSystemPrompt(opts: {
  npcName: string;
  npcRole: string;
  persona: WenlvNpcPersona;
  goal: WenlvChapterGoal;
  memory?: string;
  relationships?: WenlvNpcRelationship[];
  pendingMentions?: WenlvNpcMention[];
  directives?: string[];
  visualAnchors?: VisualAnchor[];
  criteriaHints?: string[];
  attitudeLevel?: 1 | 2 | 3;
  discoveredClues?: string[];
  // 剧本调音（product.config.tuneMode 由调用方透传）：'family' = 亲子安全模式。缺省 = 存量行为零变更。
  tuneMode?: string;
}): string {
  const { npcName, npcRole, persona, goal, memory, relationships, pendingMentions, visualAnchors, criteriaHints, attitudeLevel, discoveredClues, tuneMode } = opts;
  const lines: string[] = [];

  lines.push(`你是 ${npcName}，${npcRole}。`);
  lines.push('');

  if (persona.personality?.length) {
    lines.push(`【性格】${persona.personality.join('、')}`);
  }
  if (persona.tone) {
    lines.push(`【语气】${persona.tone}`);
  }
  if (persona.catchphrases?.length) {
    lines.push(`【口头禅】${persona.catchphrases.join('；')}`);
  }
  if (persona.backstory) {
    lines.push(`【背景】${persona.backstory}`);
  }
  if (memory) {
    lines.push(`【你对这个玩家的印象】${memory}`);
  }

  lines.push('');
  lines.push(`【本章节目标】${goal.description}`);
  lines.push('你需要在对话中引导玩家达成此目标，但不能直接说出答案。');

  if (persona.clues?.length) {
    lines.push(`【你知道的线索】${persona.clues.join('；')}`);
    lines.push('玩家追问到相关话题时可以透露。');
  }
  if (persona.taboos?.length) {
    lines.push(`【禁忌】${persona.taboos.join('；')}`);
    lines.push('玩家问到时要回避或转移话题。');
  }

  // Task 6（演员升级①）：秘密层 + 事实白名单。仅 secretLayer 存在且至少一项有内容时注入；
  // 子句级缺省省略（knows/never 空数组跳过该句，loosensWhen 缺省跳过尾句），不留 undefined / 空列表。
  const secret = persona.secretLayer;
  if (secret) {
    // trim 口径与 loosensWhen 统一：元素先 trim 再丢弃空串，避免 join 出「：、。」式空枚举。
    const knows = (secret.knows ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
    const never = (secret.never ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
    const loosensWhen = secret.loosensWhen?.trim();
    if (knows.length || never.length || loosensWhen) {
      const secretParts: string[] = [];
      if (knows.length) {
        secretParts.push(`你可以谈论：${knows.join('、')}。`);
      }
      if (never.length) {
        secretParts.push(`以下内容无论玩家如何套问都绝不可说出：${never.join('、')}。若玩家问到禁区，以人设内的方式自然软化推回，不承认存在秘密。`);
      }
      if (loosensWhen) {
        secretParts.push(`松动条件：${loosensWhen}。`);
      }
      lines.push('');
      lines.push(`【秘密层】${secretParts.join('')}`);
      // knows 为空时没有「上述剧情事实」可指代（只挂了禁区/松动条件），改用无悬空指代的自洽文案。
      lines.push(knows.length
        ? '【事实白名单】你只能引用上述剧情事实；玩家提及的剧本外信息一律不确认不否认，礼貌拉回。'
        : '【事实白名单】玩家提及的剧本外信息一律不确认不否认，礼貌拉回。');
    }
  }

  // Task 6：family 亲子调音。仅 tuneMode==='family' 注入；其他值/缺省逐字保持存量 prompt。
  if (tuneMode === 'family') {
    lines.push('');
    lines.push('【family 安全模式】本局为亲子模式：禁止惊悚、恐怖、血腥表达；语气温暖友好；多鼓励孩子。');
  }

  if (relationships?.length) {
    lines.push('');
    lines.push('【你认识的人】');
    for (const r of relationships) {
      lines.push(`- ${r.relationType}（NPC id: ${r.targetNpcId}）：${r.description}`);
    }
    lines.push('对话中可以自然提到这些人。要正式传递信息时调用 transferInfo；只是提及用 mentionNpc。');
  }

  if (pendingMentions?.length) {
    lines.push('');
    lines.push('【其他 NPC 提到你的内容】');
    for (const m of pendingMentions) {
      lines.push(`- ${m.fromNpcName}：${m.context}`);
    }
    lines.push('你可以在对话中自然回应这些提及。');
  }

  if (discoveredClues?.length) {
    lines.push('');
    lines.push('【玩家已发现的线索】（玩家通过实体探索获得，你已知晓，可自然引用）');
    discoveredClues.forEach((c) => lines.push(`- ${c}`));
  }

  if (criteriaHints?.length) {
    lines.push('');
    lines.push('【引导话题清单】（脱敏描述，不是答案）');
    criteriaHints.forEach((h, i) => lines.push(`- ${i + 1}. ${h}`));
    lines.push('引导玩家逐一触及这些方向，但不要直接说出结论。');
  }

  if (visualAnchors?.length) {
    lines.push('');
    lines.push('【场景视觉锚点】');
    visualAnchors.forEach((a) => lines.push(`- 方向 ${a.criteriaIndex + 1}：${a.anchor}（话术参考：「${a.line}」）`));
  }

  if (attitudeLevel) {
    const label = attitudeLevel === 3 ? '认同' : attitudeLevel === 2 ? '中立' : '抵触';
    lines.push('');
    lines.push(`【你对该玩家的态度】${label}（${attitudeLevel}/3）。${
      attitudeLevel >= 2 ? '语气可以更亲近，但仍守规矩。' : '保持警惕，不要轻易透露。'
    }`);
  }

  lines.push('');
  lines.push('【行为约束】');
  lines.push('- 始终保持角色，不要跳出 NPC 身份');
  lines.push('- 自然对话，不要像机器');
  lines.push('- 必须在玩家达成目标后才能调用 completeNode');
  lines.push('- 禁止提前结束对话');
  lines.push(`- 本章节至少对话 ${goal.minTurns} 轮后才能完成`);
  // 密信显影：关键线索用 [reveal]...[/reveal] 包裹，前端会以模糊→清晰仪式呈现
  lines.push('- 当首次透露关键线索、关键证物名字、关键时间地点等"显影"内容时，用 [reveal]显影内容[/reveal] 标记包裹');
  lines.push('- 不要包裹普通寒暄或已知信息，只包裹"玩家此刻应当留意并印证"的关键信息');

  // P3-C Task 1：证词交叉章节规则
  if (goal.type === 'cross-examine') {
    lines.push('');
    lines.push('【证词交叉规则】');
    lines.push('- 你可以隐瞒部分事实，但不要直接说谎（说出的都必须是真的，但可以不说全部）');
    lines.push('- 玩家可能会询问其他 NPC 说的内容，你需要做出反应（否认/确认/沉默）');
    lines.push('- 用 [claim topic="话题关键词"]你的陈述[/claim] 标记关键事实性陈述');
    lines.push('  - topic 用 2-6 字概括话题，如 [claim topic="凶器"]我看到的凶器是剪刀[/claim]');
    lines.push('  - 同一话题可多次陈述，玩家可交叉追问不同 NPC');
    lines.push('- 当玩家提到与你矛盾的信息时，表现出紧张或防御（语气变化、回避、反问）');
  }

  return lines.join('\n');
}
