// 读端投影与写端规范化：puzzle ↔ atoms 的唯一接缝，本文件共三个出口。
// puzzleToAtom 只在 DTO 下发时调用（不落库）——老剧本在 C 端也能吃到统一的原子渲染。
// normalizeNodeAtoms 只在写入口（POST/PATCH /nodes）调用——零迁移纪律下它是 atoms 的唯一守门员。
// toClientAtom 是 mini DTO 脱敏接缝（剥离 answer/expectedCode/criteria/revealText）——admin 通道不过。
import { z } from 'zod';
import type { WenlvAtom, WenlvAtomType, WenlvInteraction } from '../../../db/schema/wenlv.js';
import { ATOM_META, parseAtomConfig } from './registry.js';

/** 老剧本 puzzle → 兼容 quiz 原子（id 固定 quiz_main；null/undefined ⇒ null）。 */
export function puzzleToAtom(puzzle: WenlvInteraction | null | undefined): WenlvAtom | null {
  if (!puzzle) return null;
  return { id: 'quiz_main', type: puzzle.type, config: puzzle as unknown as Record<string, unknown> };
}

/** 写端规范化：校验类型上架/类型内 config/节点内 id 唯一。空入参 ⇒ null（老剧本路径）。 */
export function normalizeNodeAtoms(atoms: WenlvAtom[] | null | undefined): WenlvAtom[] | null {
  if (!atoms || atoms.length === 0) return null;
  if (!Array.isArray(atoms)) throw new Error('atoms 必须是原子数组');
  const seen = new Set<string>();
  for (const a of atoms) {
    const meta = ATOM_META[a.type as keyof typeof ATOM_META];
    if (!meta) throw new Error(`原子 ${a.id} 类型未注册: ${a.type}`);
    if (!meta.enabled) throw new Error(`原子 ${a.id} 类型未上架: ${a.type}`);
    if (seen.has(a.id)) throw new Error(`原子 id 重复: ${a.id}`);
    seen.add(a.id);
    try {
      parseAtomConfig(a.type, a.config);
    } catch (e) {
      throw new Error(`原子 ${a.id}（${a.type}）配置不合法: ${z.prettifyError(e as z.ZodError)}`);
    }
  }
  return atoms;
}

/** mini DTO 出参脱敏：剥离服务端核验用的剧透键（answer/expectedCode/criteria/revealText）。admin 通道不脱敏。 */
export const ATOM_CLIENT_SECRET_KEYS: Partial<Record<WenlvAtomType, string[]>> = {
  'physical-search': ['expectedCode'],
  observe: ['criteria'],
  'fragment-assembly': ['answer'],
  'item-combine': ['revealText'],
  single: ['answer'],
  multiple: ['answer'],
  judge: ['answer'],
  input: ['answer'],
};
export function toClientAtom(atom: WenlvAtom): WenlvAtom {
  const secretKeys = ATOM_CLIENT_SECRET_KEYS[atom.type];
  if (!secretKeys || secretKeys.length === 0) return atom;
  const config = { ...(atom.config as Record<string, unknown>) };
  for (const k of secretKeys) delete config[k];
  return { ...atom, config };
}
