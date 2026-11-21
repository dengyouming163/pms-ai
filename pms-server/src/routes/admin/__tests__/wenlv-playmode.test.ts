// 无库契约测试：只验 zod schema 收不收 playMode，以及一个**必须不成立**的默认值注入。
import { describe, it, expect } from 'vitest';
import { productHeadSchema, productHeadPatchSchema } from '../wenlv.js';

const base = {
  name: '测试剧本',
  venueId: 'v-1',
};

describe('productHeadSchema 接受 playMode', () => {
  it('不传 → undefined（不注入默认值）', () => {
    const r = productHeadSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data!.playMode).toBeUndefined();
  });

  it('传 group → group', () => {
    const r = productHeadSchema.safeParse({ ...base, playMode: 'group' });
    expect(r.success).toBe(true);
    expect(r.data!.playMode).toBe('group');
  });

  it('传 solo → solo', () => {
    const r = productHeadSchema.safeParse({ ...base, playMode: 'solo' });
    expect(r.data!.playMode).toBe('solo');
  });

  it('传 both → both（第三个值：既非 solo 也非 group）', () => {
    // 🔴 这条是 `both` **唯一**的判据。没有它，把枚举改回 `['solo', 'group']`
    //    时上面四条**全绿**（group/solo 照收、'duo' 照样拒）⇒ 值域被收窄无人察觉。
    const r = productHeadSchema.safeParse({ ...base, playMode: 'both' });
    expect(r.success).toBe(true);
    expect(r.data!.playMode).toBe('both');
  });

  it('传非法值 → 400 级失败', () => {
    expect(productHeadSchema.safeParse({ ...base, playMode: 'duo' }).success).toBe(false);
  });
});

describe('🔴 productHeadPatchSchema 不得凭空注入 playMode', () => {
  // 这条是本任务的核心。productHeadPatchSchema = productHeadSchema.omit(...).partial().extend(...)。
  //
  // 若 playMode 写成 `z.enum([...]).default('solo')`，`.partial()` 会保留这个 default，
  // 于是**每一次不传 playMode 的 PATCH 都会被注入 'solo'**，而 PATCH 是
  // `set({ ...parsed.data })` 直接展开 —— 结果就是：改一次剧本标题，
  // 这个多人剧本被静默改成单人，且没有任何报错。
  //
  // 正解是与既有的 `mode` 一致，用 `.optional()`，**不带 `.default()`**。
  it('空 body 的 patch 结果里不含 playMode 键', () => {
    const r = productHeadPatchSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(r.data!, 'playMode')).toBe(false);
  });

  it('patch 里显式传 group 正常收下', () => {
    const r = productHeadPatchSchema.safeParse({ playMode: 'group' });
    expect(r.data!.playMode).toBe('group');
  });
});
