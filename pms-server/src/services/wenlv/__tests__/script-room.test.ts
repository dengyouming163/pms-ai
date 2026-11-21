// script-room 投影纯函数测试（0079 全量对等）：scenes/flows → nodes/edges/endings 契约，
// 并验证结局投影可直接喂给引擎内核 selectEnding/findTriggeredEndings。
// 纯内存，不打库、不 mock db。CRUD/db 函数（listScriptRooms 等）无法在本机无 PG 环境测，
// 不在此文件覆盖（db 模块惰性 Pool，import 不连库，故仅 import 纯函数安全）。
import { describe, expect, it } from 'vitest';
import {
  projectScenesToNodes,
  projectFlowsToEdges,
  projectScenesToEndings,
  projectEndingToClient,
  toClientNpcPersona,
  reorderPlans,
} from '../script-room.js';
import type { SceneProjectionInput } from '../script-room.js';
import { applyGrants, findTriggeredEndings, markVisited, selectEnding } from '../../wenlv-engine.js';
import type { WenlvState, WenlvCondition } from '../../../db/schema/wenlv.js';

const PID = 'prod_1';

describe('projectScenesToNodes', () => {
  it('空数组 ⇒ 空节点数组', () => {
    expect(projectScenesToNodes([], PID)).toEqual([]);
  });
  it('叙事场景投影为 scene 节点，content→storyText，productId/legacyNodeType 补齐', () => {
    const [n] = projectScenesToNodes([{
      id: 's1', chapterId: 'c1', title: '前台', type: 'narrative',
      content: '递旧物包', order: 0,
    }], PID);
    expect(n.id).toBe('s1');
    expect(n.productId).toBe(PID);
    expect(n.title).toBe('前台');
    expect(n.storyText).toBe('递旧物包');
    expect(n.nodeType).toBe('scene');
    expect(n.legacyNodeType).toBe('scene');
  });
  it('NPC场景投影为 npc 节点并透传 npcId', () => {
    const [n] = projectScenesToNodes([{
      id: 's2', chapterId: 'c1', title: '私会', type: 'npc',
      npcId: 'npc1', content: '...', order: 1,
    }], PID);
    expect(n.nodeType).toBe('npc');
    expect(n.npcId).toBe('npc1');
  });
  it('puzzle/atom 场景一律投影为 scene（五型→二元）', () => {
    const nodes = projectScenesToNodes([
      { id: 's3', title: '密室', type: 'puzzle', content: '解开机关' },
      { id: 's4', title: '搜证', type: 'atom' },
    ], PID);
    expect(nodes.map((x) => x.nodeType)).toEqual(['scene', 'scene']);
  });
  it('ending 场景不进 nodes（结局走 endings 投影）', () => {
    const nodes = projectScenesToNodes([
      { id: 's5', title: '通关', type: 'ending' },
      { id: 's6', title: '走廊', type: 'narrative' },
    ], PID);
    expect(nodes.map((x) => x.id)).toEqual(['s6']);
  });
  it('0079 全玩法字段透传 + NOT NULL 列兜底', () => {
    const requires = { type: 'ref', ref: { kind: 'collected', id: 'key' } } as const;
    const chapterGoal = { type: 'reveal', description: '识破谎言' } as any;
    const [n] = projectScenesToNodes([{
      id: 's7', title: '机关', type: 'puzzle',
      venuePointId: 'vp1', requires, geo: { lat: 1, lng: 2 } as any,
      mapX: 3, mapY: 4, image: 'img.png', narrationUrl: 'a.mp3',
      grants: ['item1'], npcLineIds: ['l1', 'l2'], openingLine: '你来了',
      chapterGoal, perspectiveCharacterId: 'char1', sanDelta: -5,
      arAssetUrl: 'ar.usdz', arAssetUrls: { ios: 'x.usdz', android: null },
      arDialogue: '举起手机',
    }], PID);
    expect(n.venuePointId).toBe('vp1');
    expect(n.requires).toEqual(requires);
    expect(n.geo).toEqual({ lat: 1, lng: 2 });
    expect([n.mapX, n.mapY]).toEqual([3, 4]);
    expect(n.image).toBe('img.png');
    expect(n.narrationUrl).toBe('a.mp3');
    expect(n.grants).toEqual(['item1']);
    expect(n.npcLineIds).toEqual(['l1', 'l2']);
    expect(n.openingLine).toBe('你来了');
    expect(n.chapterGoal).toBe(chapterGoal);
    expect(n.perspectiveCharacterId).toBe('char1');
    expect(n.sanDelta).toBe(-5);
    expect(n.arAssetUrl).toBe('ar.usdz');
    expect(n.arAssetUrls).toEqual({ ios: 'x.usdz', android: null });
    expect(n.arDialogue).toBe('举起手机');
  });
  it('缺省字段兜底：storyText/npcId→null，grants/npcLineIds→[]，sanDelta→0，arAssetUrls→{}，order→0', () => {
    const [n] = projectScenesToNodes([{ id: 's8', title: '空场景', type: 'narrative' }], PID);
    expect(n.storyText).toBeNull();
    expect(n.npcId).toBeNull();
    expect(n.grants).toEqual([]);
    expect(n.npcLineIds).toEqual([]);
    expect(n.sanDelta).toBe(0);
    expect(n.arAssetUrls).toEqual({});
    expect(n.order).toBe(0);
  });
});

describe('projectFlowsToEdges', () => {
  it('choice flow：choiceText→label，结构化 condition/grants/sanDelta/sortOrder 透传', () => {
    const condition = { type: 'ref', ref: { kind: 'visited', id: 's1' } } as const;
    const { edges } = projectFlowsToEdges([
      { id: 'f1', fromSceneId: 's1', toSceneId: 's2', type: 'choice', choiceText: '去看看',
        condition, grants: ['item'], sanDelta: 2, sortOrder: 1 },
    ]);
    expect(edges[0]).toMatchObject({
      id: 'f1', fromNodeId: 's1', toNodeId: 's2', edgeType: 'choice', label: '去看看',
      condition, grants: ['item'], sanDelta: 2, sortOrder: 1,
    });
  });
  it('auto / puzzle_pass / puzzle_fail 四型透传，未知类型回落 auto', () => {
    const { edges } = projectFlowsToEdges([
      { id: 'f2', fromSceneId: 's2', toSceneId: 's3', type: 'auto' },
      { id: 'f3', fromSceneId: 's3', toSceneId: 's4', type: 'puzzle_pass' },
      { id: 'f4', fromSceneId: 's3', toSceneId: 's5', type: 'puzzle_fail' },
      { id: 'f5', fromSceneId: 's5', toSceneId: 's6', type: 'weird' },
    ]);
    expect(edges.map((e) => e.edgeType)).toEqual(['auto', 'puzzle_pass', 'puzzle_fail', 'auto']);
  });
  it('缺省兜底：label/condition→null，grants→[]，sanDelta/sortOrder→0', () => {
    const { edges } = projectFlowsToEdges([{ id: 'f6', fromSceneId: 'a', toSceneId: 'b' }]);
    expect(edges[0].label).toBeNull();
    expect(edges[0].condition).toBeNull();
    expect(edges[0].grants).toEqual([]);
    expect(edges[0].sanDelta).toBe(0);
    expect(edges[0].sortOrder).toBe(0);
  });
});

describe('projectScenesToEndings', () => {
  const scenes: SceneProjectionInput[] = [
    { id: 'n1', title: '普通节点', type: 'narrative', content: '路过' },
    { id: 'e_good', title: '真相大白', type: 'ending', content: '你赢了', image: 'good.png',
      rewardId: 'r1', priority: 10,
      triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'key' } } },
    { id: 'e_bad', title: '迷雾重重', type: 'ending', content: '你输了', image: 'bad.png',
      rewardId: 'r2', priority: 5,
      triggerCondition: { type: 'ref', ref: { kind: 'visited', id: 'place' } } },
  ];

  it('只取 ending 场景；content→text，image/rewardId/priority/triggerCondition 透传', () => {
    const endings = projectScenesToEndings(scenes);
    expect(endings.map((e) => e.id)).toEqual(['e_good', 'e_bad']);
    expect(endings[0]).toMatchObject({
      id: 'e_good', title: '真相大白', text: '你赢了', image: 'good.png',
      rewardId: 'r1', priority: 10,
    });
  });
  it('投影结局直接喂引擎：仅集齐证物 ⇒ 触发且选中高优先 e_good', () => {
    const endings = projectScenesToEndings(scenes);
    let state: WenlvState = { visited: {}, collected: { key: true }, completed: {} };
    expect(findTriggeredEndings(
      endings as { id: string; triggerCondition: WenlvCondition }[],
      state,
    )).toEqual(['e_good']);
    expect(selectEnding(endings, state).endingId).toBe('e_good');
  });
  it('两个结局条件同时满足（引擎条件单调）⇒ selectEnding 取 priority 最大者', () => {
    const endings = projectScenesToEndings(scenes);
    let state: WenlvState = { visited: {}, collected: { key: true }, completed: {} };
    state = markVisited(state, 'place');
    const { endingId, satisfiedIds } = selectEnding(endings, state);
    expect(endingId).toBe('e_good');
    expect(new Set(satisfiedIds)).toEqual(new Set(['e_good', 'e_bad']));
  });
  it('走边产出(grants)→applyGrants→结局触发 的引擎闭环全部吃投影字段', () => {
    const endings = projectScenesToEndings(scenes);
    const { edges } = projectFlowsToEdges([
      { id: 'f', fromSceneId: 'n1', toSceneId: 'n2', type: 'auto', grants: ['key'] },
    ]);
    let state: WenlvState = { visited: {}, collected: {}, completed: {} };
    state = applyGrants(edges[0].grants, state);
    expect(selectEnding(endings, state).endingId).toBe('e_good');
  });
});

describe('projectEndingToClient（结局 C 端脱敏）', () => {
  it('只保留六字段且彻底剥除 triggerCondition', () => {
    const [internal] = projectScenesToEndings([{
      id: 'e1', title: '终局', type: 'ending', content: '全文', image: 'i.png',
      rewardId: 'r1', priority: 3,
      triggerCondition: { type: 'ref', ref: { kind: 'visited', id: 'x' } },
    }]);
    const dto = projectEndingToClient(internal);
    expect(dto).toEqual({
      id: 'e1', title: '终局', text: '全文', image: 'i.png', rewardId: 'r1', priority: 3,
    });
    expect(Object.keys(dto).sort()).toEqual(['id', 'image', 'priority', 'rewardId', 'text', 'title']);
    expect(dto).not.toHaveProperty('triggerCondition');
  });
});

describe('toClientNpcPersona（人格卡 C 端白名单）', () => {
  it('六键透传，数组剔除非字符串，夹带的 memory/answer/未知键一律剥离', () => {
    const p = toClientNpcPersona({
      personality: ['冷静', 1, null],
      tone: '低沉',
      catchphrases: ['嗯'],
      backstory: '一段往事',
      clues: ['线索甲'],
      taboos: ['莫提前事'],
      memory: '跨章运行时印象（绝不能下发）',
      answer: '42',
      relationships: [],
      extra: 123,
    });
    expect(p).toEqual({
      personality: ['冷静'],
      tone: '低沉',
      catchphrases: ['嗯'],
      backstory: '一段往事',
      clues: ['线索甲'],
      taboos: ['莫提前事'],
    });
    expect(p).not.toHaveProperty('memory');
    expect(p).not.toHaveProperty('answer');
    expect(p).not.toHaveProperty('relationships');
  });
  it('仅部分有效键 ⇒ 只保留有效键', () => {
    expect(toClientNpcPersona({ tone: '短促', personality: null })).toEqual({ tone: '短促' });
  });
  it('空对象 / null / 非对象 / 全无效值 ⇒ null（调用方据此不下发 persona 键）', () => {
    expect(toClientNpcPersona({})).toBeNull();
    expect(toClientNpcPersona(null)).toBeNull();
    expect(toClientNpcPersona('npc')).toBeNull();
    expect(toClientNpcPersona({ personality: null, tone: 5, clues: 'x' })).toBeNull();
  });
});

// ===== reorderPlans 纯函数：批量重排 order =====
describe('reorderPlans', () => {
  it('空数组返回空', () => {
    expect(reorderPlans([])).toEqual([]);
  });
  it('单元素 order 归零', () => {
    expect(reorderPlans([{ id: 'a', order: 5 }])).toEqual([{ id: 'a', order: 0 }]);
  });
  it('多元素按新顺序重排 order 为 0,1,2...', () => {
    const input = [
      { id: 'c', order: 2 },
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ];
    expect(reorderPlans(input)).toEqual([
      { id: 'c', order: 0 },
      { id: 'a', order: 1 },
      { id: 'b', order: 2 },
    ]);
  });
});
