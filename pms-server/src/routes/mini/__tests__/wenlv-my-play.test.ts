// /api/mini/wenlv/my-play 的未登录面。**不需要 DB**：鉴权在取数之前 ⇒ 这条路径不碰库。
// 这条判据要挡的是「用 getMiniUser 而不是 parseMiniToken」——前者在无用户时 throw，
// 于是未登录会返 500 而不是 401（C 端会按「服务器故障」处理并重试，而不是去登录）。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect } from 'vitest';
import route from '../wenlv-my-play.js';

describe('GET /api/mini/wenlv/my-play 鉴权', () => {
  it('无 Authorization ⇒ 401（不是 500）', async () => {
    const res = await route.request('/');
    expect(res.status).toBe(401);
    expect((await res.json()).success).toBe(false);
  });

  it('令牌无效 ⇒ 401', async () => {
    const res = await route.request('/', { headers: { Authorization: 'Bearer not-a-token' } }); // 🔴 必须 ASCII：header 值是 ByteString，非 ASCII 在构造 Request 时就抛 TypeError（写成中文串这条用例构造上不可执行）
    expect(res.status).toBe(401);
  });
});
