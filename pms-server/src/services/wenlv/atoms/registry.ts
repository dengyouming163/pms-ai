// 原子注册中心（spec §4/§8.1）：每种原子一个 config zod schema + 元数据。
// C 端渲染器注册表（pms-nimi src/components/wenlv/atoms/registry.ts）的 renderer 字段与本表同名。
import { z } from 'zod';
import type { WenlvAtom, WenlvAtomType } from '../../../db/schema/wenlv.js';

export type WenlvAtomCategory = 'explore' | 'social' | 'reasoning' | 'spectacle' | 'commerce' | 'quiz';
export type WenlvAtomVerify = 'code' | 'cipher' | 'answer' | 'llm-text' | 'collectibles' | 'attest' | 'auto';

export interface AtomMeta {
  category: WenlvAtomCategory;
  renderer: string;
  verify: WenlvAtomVerify;
  isCommerce: boolean;
  /** false = 仅注册不上架（P1 guest-social） */
  enabled: boolean;
  label: string;
}

// 预留给 R10 免费旁路：持有旁路凭证的玩家可跳过必做原子。
const bypassSchema = z.object({ how: z.string().min(1).max(200) }).passthrough();

export const ATOM_META: Record<WenlvAtomType, AtomMeta> = {
  'physical-search': { category: 'explore', renderer: 'PhysicalSearchAtom', verify: 'code', isCommerce: false, enabled: true, label: '实体寻物' },
  observe: { category: 'explore', renderer: 'ObserveAtom', verify: 'llm-text', isCommerce: false, enabled: true, label: '空间观察' },
  'ar-echo': { category: 'explore', renderer: 'ArEchoAtom', verify: 'auto', isCommerce: false, enabled: true, label: 'AR 残影' },
  'cross-place': { category: 'explore', renderer: 'CrossPlaceAtom', verify: 'collectibles', isCommerce: false, enabled: true, label: '跨店拼图' },
  'cipher-contact': { category: 'social', renderer: 'CipherContactAtom', verify: 'cipher', isCommerce: true, enabled: true, label: '暗号接头' },
  'human-quest': { category: 'social', renderer: 'HumanQuestAtom', verify: 'attest', isCommerce: false, enabled: true, label: '真人委托' },
  'guest-social': { category: 'social', renderer: 'GuestSocialAtom', verify: 'attest', isCommerce: false, enabled: false, label: '住客弱社交' },
  'fragment-assembly': { category: 'reasoning', renderer: 'FragmentAssemblyAtom', verify: 'answer', isCommerce: false, enabled: true, label: '碎片拼合' },
  'item-combine': { category: 'reasoning', renderer: 'ItemCombineAtom', verify: 'answer', isCommerce: false, enabled: true, label: '道具组合' },
  'ambient-soundscape': { category: 'spectacle', renderer: 'AmbientScapeAtom', verify: 'auto', isCommerce: false, enabled: true, label: '环境音景' },
  'night-light-person': { category: 'spectacle', renderer: 'NightLightAtom', verify: 'auto', isCommerce: false, enabled: true, label: '灯下人' },
  'physical-surprise': { category: 'spectacle', renderer: 'PhysicalSurpriseAtom', verify: 'attest', isCommerce: false, enabled: true, label: '实体惊喜' },
  'merchant-grant': { category: 'commerce', renderer: 'MerchantGrantAtom', verify: 'attest', isCommerce: true, enabled: true, label: '情报随赠' },
  'token-redeem': { category: 'commerce', renderer: 'TokenRedeemAtom', verify: 'attest', isCommerce: true, enabled: true, label: '信物兑换' },
  'paid-customization': { category: 'commerce', renderer: 'PaidCustomizationAtom', verify: 'attest', isCommerce: true, enabled: true, label: '定制结局' },
  single: { category: 'quiz', renderer: 'QuizAtom', verify: 'answer', isCommerce: false, enabled: true, label: '单选' },
  multiple: { category: 'quiz', renderer: 'QuizAtom', verify: 'answer', isCommerce: false, enabled: true, label: '多选' },
  judge: { category: 'quiz', renderer: 'QuizAtom', verify: 'answer', isCommerce: false, enabled: true, label: '判断' },
  input: { category: 'quiz', renderer: 'QuizAtom', verify: 'answer', isCommerce: false, enabled: true, label: '填空' },
  photo: { category: 'quiz', renderer: 'QuizAtom', verify: 'answer', isCommerce: false, enabled: true, label: '拍照' },
  meditate: { category: 'quiz', renderer: 'QuizAtom', verify: 'answer', isCommerce: false, enabled: true, label: '静坐' },
};

// 各类型 config schema；quiz 题型复用 WenlvInteraction 的字段语义（question/answer 必填）。
const quizBase = { question: z.string().min(1), hint: z.string().optional() } as const;

export const ATOM_CONFIG_SCHEMAS: Partial<Record<WenlvAtomType, z.ZodTypeAny>> = {
  'physical-search': z.object({ prompt: z.string().min(1), expectedCode: z.string().min(2).max(40).optional(), hint: z.string().optional() }),
  observe: z.object({ prompt: z.string().min(1), criteria: z.string().min(1), photoRequired: z.boolean().optional() }),
  'ar-echo': z.object({ assetUrl: z.string().min(1), durationSec: z.number().int().min(3).max(60).optional(), prompt: z.string().optional() }),
  'cross-place': z.object({ collectibleIds: z.array(z.string().min(1)).min(1), parts: z.array(z.object({ label: z.string(), fromNodeTitle: z.string().optional() })).optional(), hint: z.string().optional() }),
  'cipher-contact': z.object({ cipherPhrase: z.string().min(1), replyHint: z.string().optional(), merchantPartnerId: z.string().min(1).optional() }),
  'human-quest': z.object({ questBrief: z.string().min(1), verifyHint: z.string().optional() }),
  'guest-social': z.object({ boardBrief: z.string().min(1) }),
  'fragment-assembly': z.object({ pieces: z.array(z.object({ id: z.string(), text: z.string().min(1) })).min(2), answer: z.string().min(1), hint: z.string().optional() }),
  'item-combine': z.object({ itemIds: z.array(z.string().min(1)).min(2), revealText: z.string().min(1), hint: z.string().optional() }),
  'ambient-soundscape': z.object({ audioUrl: z.string().min(1), playOnEnter: z.boolean().optional() }),
  'night-light-person': z.object({ lines: z.array(z.string().min(1)).min(1), audioUrl: z.string().optional() }),
  'physical-surprise': z.object({ instruction: z.string().min(1) }),
  'merchant-grant': z.object({ merchantPartnerId: z.string().min(1).optional(), grantCollectibleIds: z.array(z.string().min(1)).min(1), note: z.string().optional() }),
  'token-redeem': z.object({ rewardId: z.string().min(1), sourceCollectibleIds: z.array(z.string().min(1)).optional() }),
  'paid-customization': z.object({ fields: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), placeholder: z.string().optional() })).min(1) }),
  // 兼容题型按「字段在场」校验（测试钉死 options 单项也合法），不强制选项数下限 2。
  single: z.object({ ...quizBase, options: z.array(z.string()).min(1), answer: z.string().min(1) }),
  multiple: z.object({ ...quizBase, options: z.array(z.string()).min(2), answer: z.array(z.string()).min(1) }),
  judge: z.object({ ...quizBase, answer: z.enum(['true', 'false']) }),
  input: z.object({ ...quizBase, answer: z.string().min(1) }),
  photo: z.object({ ...quizBase }),
  meditate: z.object({ ...quizBase, seconds: z.number().int().min(1).max(1800) }),
};

export function parseAtomConfig(type: WenlvAtomType, config: unknown): Record<string, unknown> {
  if (!ATOM_META[type]) throw new Error(`未注册原子类型: ${type}`);
  const schema = ATOM_CONFIG_SCHEMAS[type];
  if (!schema) throw new Error(`未注册原子类型: ${type}`);
  return schema.parse(config) as Record<string, unknown>;
}

export function isCommerceAtom(a: Pick<WenlvAtom, 'type'>): boolean {
  return ATOM_META[a.type]?.isCommerce ?? false;
}

/** 节点完成判定所需的必做原子 id（required 缺省 = true）。 */
export function requiredAtomIds(atoms: WenlvAtom[]): string[] {
  return atoms.filter((a) => a.required !== false).map((a) => a.id);
}
