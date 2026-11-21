import type { WenlvChapterGoal } from '../../../db/schema/wenlv.js';
import { normalizeCriteria } from './goal-checker.js';

const LLM_URL = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
function visionModel(): string {
  const raw = (process.env.WENLV_REVIEW_MODEL ?? '').trim();
  return raw === '' ? 'qwen-vl-max' : raw;
}
const VISUAL_TIMEOUT_MS = 8000;

export type VisualAnchor = {
  criteriaIndex: number;
  anchor: string;
  line: string;
};

type WenlvNodeLike = { image?: string | null; chapterGoal?: WenlvChapterGoal | null };

export async function generateVisualAnchors(
  node: WenlvNodeLike,
  goal: WenlvChapterGoal,
): Promise<VisualAnchor[]> {
  const imageUrl = (node.image || '').trim();
  if (!imageUrl) return [];
  const criteria = normalizeCriteria(goal.answerCriteria);
  if (!criteria.length) return [];

  const systemPrompt = [
    '你是实景剧本杀的视觉分镜师。观察给出的场景图，为每条通关条件找出一个"画面里真实存在、可指给玩家看"的视觉锚点。',
    '硬约束：1.只描述"画面里有什么、在哪"，禁止说出条件的结论或答案。2.anchor 必须是画面中客观可见的元素。3.line 是 NPC 可直接说的观察话术，引导玩家去看，不下结论。4.输出严格 JSON 数组。',
    '输出格式：[{"criteriaIndex":0,"anchor":"...","line":"..."}]',
  ].join('\n');

  const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const userText = `场景图已附在消息中。\n\n通关条件：\n${criteriaText}\n\n请为每条条件生成一个视觉锚点。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: imageUrl } },
    ]},
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISUAL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY || process.env.ARK_API_KEY || ''}` },
      body: JSON.stringify({ model: visionModel(), messages, temperature: 0 }),
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    return parseAnchors(raw, criteria.length);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function parseAnchors(raw: string, criteriaLen: number): VisualAnchor[] {
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as Array<Record<string, unknown>>;
    const result: VisualAnchor[] = [];
    for (const item of arr) {
      const idx = Number(item.criteriaIndex);
      const anchor = String(item.anchor || '').trim();
      const line = String(item.line || '').trim();
      if (!Number.isInteger(idx) || idx < 0 || idx >= criteriaLen) continue;
      if (!anchor || !line) continue;
      result.push({ criteriaIndex: idx, anchor, line });
    }
    return result;
  } catch {
    return [];
  }
}
