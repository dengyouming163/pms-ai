// AI 一键完善剧情（node_refine）的输出契约（spec §6.4）。
// 只包含「内容字段」；结构字段（venuePointId/素材/坐标/edges）不允许 LLM 产出。
import { z } from 'zod';

// 与 db/schema/wenlv.ts 的 WenlvInteraction 对齐：
// 六变体共享 question/hint；collaborative 只存在于 single/input/multiple/judge
//（photo/meditate 的真实类型上没有该字段，勿放进公共 base）。
const puzzleBase = {
  question: z.string().min(1),
  hint: z.string().optional(),
};

const collaborativeField = {
  collaborative: z.boolean().optional(),
};

export const puzzleSchema = z.union([
  z.object({ ...puzzleBase, ...collaborativeField, type: z.literal('single'), options: z.array(z.string()).min(2), answer: z.string().min(1) }),
  z.object({ ...puzzleBase, ...collaborativeField, type: z.literal('multiple'), options: z.array(z.string()).min(2), answer: z.array(z.string()).min(1) }),
  z.object({ ...puzzleBase, ...collaborativeField, type: z.literal('judge'), answer: z.enum(['true', 'false']) }),
  z.object({ ...puzzleBase, ...collaborativeField, type: z.literal('input'), answer: z.string().min(1) }),
  z.object({ ...puzzleBase, type: z.literal('photo') }),
  z.object({ ...puzzleBase, type: z.literal('meditate'), seconds: z.number().int().positive() }),
]);

// 对齐 WenlvChapterGoal（db/schema/wenlv.ts）。criteriaHints 不收：
// 它由服务端从 answerCriteria 脱敏派生（routes/mini/wenlv.ts 的 desensitizeCriteria），不由 LLM 产出。
const chapterGoalSchema = z.object({
  type: z.enum(['puzzle', 'choice', 'reveal', 'convince', 'cross-examine']),
  description: z.string().min(1),
  answerCriteria: z.array(z.string()).default([]),
  minTurns: z.number().int().min(1),
  collaborative: z.boolean().optional(),
  clueIds: z.array(z.string()).optional(),
  options: z.array(z.object({ label: z.string(), nextNodeId: z.string() })).optional(),
});

// 对齐 WenlvNpcPersona（db/schema/wenlv.ts）：六字段，三个串、三个数组；
// 库里 persona 列 default {} 全可选，parse 时归一为默认值，方便后续 apply 直接使用。
const personaSchema = z.object({
  personality: z.array(z.string()).default([]),
  tone: z.string().default(''),
  catchphrases: z.array(z.string()).default([]),
  backstory: z.string().default(''),
  clues: z.array(z.string()).default([]),
  taboos: z.array(z.string()).default([]),
});

// 实体道具包建议（Task 9 AI 履约包）：对齐 db/schema/wenlv.ts 的 pmsBuiWenlvProps。
// 字段名 camelCase（placeNote），与 DB 列一致；refine-apply 事务内按 name+nodeId 幂等登记。
const propSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['letter', 'key', 'card', 'prop']).default('letter'),
  placeNote: z.string().optional().nullable(),
});

export const refineDraftSchema = z.object({
  targetType: z.enum(['scene', 'npc']),
  title: z.string().min(1).max(200),
  storyText: z.string(),
  puzzle: puzzleSchema.nullable(),
  grants: z.array(z.string()),
  requires: z.unknown().nullable(),
  chapterGoal: chapterGoalSchema.nullable(),
  openingLine: z.string().nullable(),
  arDialogue: z.string().nullable(),
  npcId: z.string().nullable(),
  newNpc: z.object({ name: z.string().min(1), persona: personaSchema }).nullable(),
  notes: z.string().default(''),
  props: z.array(propSchema).optional().nullable(),
});

export type RefineDraft = z.infer<typeof refineDraftSchema>;
export type RefineTargetType = RefineDraft['targetType'];
