import { describe, it, expect } from 'vitest';
import { clientSupportsBinaryNodes, legacyWireNodeType, BINARY_NODE_CLIENT_VERSION } from '../client-version.js';

describe('clientSupportsBinaryNodes', () => {
  it('无版本头视为旧版', () => {
    expect(clientSupportsBinaryNodes(undefined)).toBe(false);
    expect(clientSupportsBinaryNodes(null)).toBe(false);
  });

  it('1.0.x 为旧版，1.1.0 及以上为新版', () => {
    expect(clientSupportsBinaryNodes('1.0.1')).toBe(false);
    expect(clientSupportsBinaryNodes('1.1.0')).toBe(true);
    expect(clientSupportsBinaryNodes('2.0.0')).toBe(true);
  });

  it('阈值常量存在', () => expect(BINARY_NODE_CLIENT_VERSION).toBe('1.1.0'));

  it('空串/带空白/非三段式按旧版保守处理', () => {
    expect(clientSupportsBinaryNodes('')).toBe(false);
    expect(clientSupportsBinaryNodes(' 1.1.0 ')).toBe(true); // trim 后可解析
    expect(clientSupportsBinaryNodes('1.1')).toBe(false);
    expect(clientSupportsBinaryNodes('v1.1.0')).toBe(false);
  });

  it('按数值比较版本号，后缀不影响主.次判定', () => {
    expect(clientSupportsBinaryNodes('1.0.99')).toBe(false);
    expect(clientSupportsBinaryNodes('1.10.0')).toBe(true);  // 防字符串比较退化（'1.10' < '1.1'）
    expect(clientSupportsBinaryNodes('1.1.0-beta')).toBe(true);
  });
});

describe('legacyWireNodeType（旧版线格式保真投影）', () => {
  it('v1: 影子行逐字回吐历史值，与真实 nodeType/puzzle 无关', () => {
    // 落平后真实 scene + 挂 puzzle，但旧版必须收到 'npc'（TONGGU 形态）
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'v1:npc', puzzle: {} })).toBe('npc');
    // 历史 scene 即使挂 puzzle 也仍是 scene（9 个存量形态，不能翻成 puzzle）
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'v1:scene', puzzle: {} })).toBe('scene');
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'v1:puzzle', puzzle: null })).toBe('puzzle');
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'v1:choice' })).toBe('choice');
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'v1:ending' })).toBe('ending');
  });

  it('无影子（二元新生行）：真实 npc 报 npc，其余按 puzzle 有无派生', () => {
    expect(legacyWireNodeType({ nodeType: 'npc', legacyNodeType: 'scene' })).toBe('npc');
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'scene', puzzle: {} })).toBe('puzzle');
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'scene' })).toBe('scene');
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: null, puzzle: {} })).toBe('puzzle');
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: undefined })).toBe('scene');
  });

  it('脏影子值（未知前缀/未知后缀）回退到二元派生，不吐脏字符串', () => {
    expect(legacyWireNodeType({ nodeType: 'scene', legacyNodeType: 'v2:npc', puzzle: {} })).toBe('puzzle');
    expect(legacyWireNodeType({ nodeType: 'npc', legacyNodeType: 'v9:xxx' })).toBe('npc');
  });
});
