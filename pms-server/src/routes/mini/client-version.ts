// 小程序契约版本门：1.1.0 起节点为二元模型新契约（nodeType 仅 scene/npc、无 driverType）；
// 旧版客户端（1.0.x）把节点投影回 scene/puzzle/npc + driverType 老口径。
export const BINARY_NODE_CLIENT_VERSION = '1.1.0';

// 旧版线格式的 nodeType 取值（0074 之前的五值 + 二元回退派生值）。
export type LegacyWireNodeType = 'scene' | 'npc' | 'puzzle' | 'choice' | 'ending';

const LEGACY_PREFIX = 'v1:';
const LEGACY_TYPES: readonly LegacyWireNodeType[] = ['scene', 'npc', 'puzzle', 'choice', 'ending'];

/**
 * 旧版客户端（<1.1.0）详情 DTO 的 nodeType 投影。
 *
 * 线上实测（2026-10-05）：在役 1.0.x 客户端按 node_type 字符串渲染（扫码文案 / 完成判定 /
 * 谜题容器显隐 / 协作门都判 ==='puzzle'、!=='scene'），只认 interactions[]、不认单 puzzle
 * 对象；driverType 自 0065 起从未下发过。故旧版投影必须逐字复刻切换前的线格式类型：
 *
 * - legacy_node_type 带 'v1:' 前缀 = 0074 封存的历史行 ⇒ 回吐后缀原值（v1:npc 仍是 'npc'，
 *   v1:scene 即使挂 puzzle 也仍是 'scene'），玩家侧零变化；
 * - 无前缀（'scene' 出生标记）= 二元时代新建行 ⇒ 真实 npc 报 'npc'，
 *   其余按 puzzle 对象有无派生 'puzzle'/'scene'。
 */
export function legacyWireNodeType(n: {
  nodeType: string;
  legacyNodeType?: string | null;
  puzzle?: unknown;
}): LegacyWireNodeType {
  const legacy = n.legacyNodeType;
  if (typeof legacy === 'string' && legacy.startsWith(LEGACY_PREFIX)) {
    const t = legacy.slice(LEGACY_PREFIX.length) as LegacyWireNodeType;
    if ((LEGACY_TYPES as readonly string[]).includes(t)) return t;
  }
  return n.nodeType === 'npc' ? 'npc' : n.puzzle ? 'puzzle' : 'scene';
}

export function clientSupportsBinaryNodes(version: string | null | undefined): boolean {
  if (!version) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const [ta, tb] = BINARY_NODE_CLIENT_VERSION.split('.').map(Number);
  return a > ta || (a === ta && b >= tb);
}
