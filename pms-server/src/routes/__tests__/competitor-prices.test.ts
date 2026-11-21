import { describe, it, expect } from 'vitest';
import route from '../competitor-prices.js';

/** 只覆盖「损坏入参被拒」这条**不需要库**的路径。
 *  正常新建/爬取要走 db，不在本文件覆盖（裸跑无库，会把环境性失败混进来）。
 *  这里测的是**路由接线**，不是纯函数 —— src/lib/__tests__/text-integrity.test.ts 测的是后者。
 *  两处都要：纯函数绿只证明谓词对，证明不了它真被接到这个端点上。 */
describe('POST /api/competitor-prices —— 编码损坏的入参必须被拒（DB-free）', () => {
  const FFFD = String.fromCharCode(0xfffd);

  const post = (body: unknown) => route.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('酒店名含 U+FFFD → 400，文案点名该字段', async () => {
    const res = await post({ hotelName: `杭州${FFFD}酒店`, platform: '携程' });
    expect(res.status).toBe(400);
    const json = await res.json() as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('酒店名称');
  });

  it('竞品 platform 列的实际损坏形状 → 400', async () => {
    const res = await post({ hotelName: '亚朵', platform: `${String.fromCharCode(0x042f)}${FFFD}${FFFD}` });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('平台');
  });

  it('只填名称与平台（其余空串）不含损坏字符 → 不该被这条闸拒', async () => {
    // 判据取「不是 400」而不是「是 200」：这条路径接着会走 db，无库时必然失败。
    // 本用例只证明**闸没有误伤正当录入**，不证明新建成功。
    const res = await post({ hotelName: '亚朵', platform: '美团', platformHotelId: '', platformUrl: '', competitorRoomType: '' });
    expect(res.status).not.toBe(400);
  });
});
