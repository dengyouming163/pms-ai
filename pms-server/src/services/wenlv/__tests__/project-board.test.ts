// project-board 纯函数测试：deriveSteps 六步判据各分支。
// 纯内存，不打库、不 mock db。buildProjectBoard 的 DB 聚合不测（由路由层契约覆盖）。
import { describe, it, expect } from 'vitest';
import { deriveSteps } from '../project-board.js';

/** 全零基线：空产品 ⇒ venue/profile/content/deploy 全 todo，publish 无待办 ⇒ done，ops 双零。 */
const EMPTY = {
  venueId: null, venueExists: false, venueStatus: null,
  hasProfile: false, linkedMerchants: 0,
  nodeCount: 0, atomNodeCount: 0,
  publishTodoCount: 0,
  activeTeams: 0, completedTotal: 0,
};

describe('deriveSteps', () => {
  it('空产品：①②③⑤ 全 todo，④ todoCount=0 ⇒ done，⑥ 双零', () => {
    expect(deriveSteps(EMPTY)).toEqual({
      venue: 'todo',
      profile: 'todo',
      content: 'todo',
      publish: { state: 'done', todoCount: 0 },
      deploy: 'todo',
      ops: { activeTeams: 0, completedTotal: 0 },
    });
  });

  it('① 建场：绑 venueId 且场地存在 ⇒ done', () => {
    const steps = deriveSteps({ ...EMPTY, venueId: 'V1', venueExists: true, venueStatus: 'surveying' });
    expect(steps.venue).toBe('done');
  });

  it('① 建场：绑了 venueId 但场地不存在 ⇒ todo', () => {
    const steps = deriveSteps({ ...EMPTY, venueId: 'V1', venueExists: false });
    expect(steps.venue).toBe('todo');
  });

  it('② 档案商户：有档案但无关联商户 ⇒ partial', () => {
    const steps = deriveSteps({ ...EMPTY, hasProfile: true, linkedMerchants: 0 });
    expect(steps.profile).toBe('partial');
  });

  it('② 档案商户：档案 + 关联商户 ≥1 ⇒ done', () => {
    const steps = deriveSteps({ ...EMPTY, hasProfile: true, linkedMerchants: 2 });
    expect(steps.profile).toBe('done');
  });

  it('③ 剧本内容：节点≥1 但无任何 atoms 节点 ⇒ partial', () => {
    const steps = deriveSteps({ ...EMPTY, nodeCount: 3, atomNodeCount: 0 });
    expect(steps.content).toBe('partial');
  });

  it('③ 剧本内容：节点≥1 且含 atoms 节点≥1 ⇒ done', () => {
    const steps = deriveSteps({ ...EMPTY, nodeCount: 3, atomNodeCount: 1 });
    expect(steps.content).toBe('done');
  });

  it('④ 发布就绪：todoCount>0 ⇒ partial 且回吐 todoCount', () => {
    const steps = deriveSteps({ ...EMPTY, publishTodoCount: 5 });
    expect(steps.publish).toEqual({ state: 'partial', todoCount: 5 });
  });

  it('⑤ 布房履约：venue.status=live ⇒ done；其他状态（含未绑场地）⇒ todo', () => {
    expect(deriveSteps({ ...EMPTY, venueId: 'V1', venueExists: true, venueStatus: 'live' }).deploy).toBe('done');
    expect(deriveSteps({ ...EMPTY, venueId: 'V1', venueExists: true, venueStatus: 'pilot' }).deploy).toBe('todo');
    expect(deriveSteps(EMPTY).deploy).toBe('todo');
  });

  it('⑥ 营业数据：纯计数透传（活跃队伍 / 累计通关）', () => {
    const steps = deriveSteps({ ...EMPTY, activeTeams: 4, completedTotal: 128 });
    expect(steps.ops).toEqual({ activeTeams: 4, completedTotal: 128 });
  });
});
