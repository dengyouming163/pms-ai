import { describe, it, expect } from 'vitest';
import { validateSessionParams, buildProxyTarget, isSessionInStores, buildGroupSendBody } from '../index.js';

/** 临时替换全局 fetch 执行用例，结束后恢复（项目测试类型 shim 极简，不引入 vi/afterEach） */
async function withStubbedFetch<T>(fetchImpl: unknown, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as any).fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    (globalThis as any).fetch = original;
  }
}

/** 构造返回 200 且带指定 json 结果的 fetch mock */
function okFetch(jsonResult: unknown) {
  return async () => ({ ok: true, status: 200, json: async () => jsonResult });
}

describe('kf-staff 发送代理纯函数', () => {
  it('validateSessionParams 校验必填参数', () => {
    expect(validateSessionParams({ sessionId: '6', content: 'hi' })).toEqual({ sessionId: '6', content: 'hi' });
    expect(validateSessionParams({})).toBe(null);
    expect(validateSessionParams({ sessionId: '6' })).toBe(null);
  });

  it('validateSessionParams 透传 title/sender', () => {
    expect(validateSessionParams({ sessionId: '6', mediaUrl: 'u', mediaType: 'image', title: '素材名', sender: '人工' }))
      .toEqual({ sessionId: '6', mediaUrl: 'u', mediaType: 'image', title: '素材名', sender: '人工' });
  });

  it('validateSessionParams 透传 miniprogram 字段（appid/pagepath/thumbMediaId/thumbImageUrl）', () => {
    const out = validateSessionParams({
      sessionId: '6', appid: 'wxa_abc', pagepath: 'pages/rooms/detail?id=1',
      thumbMediaId: 'MEDIA_1', thumbImageUrl: 'https://cdn.example.com/cover.jpg', title: '温馨大床房',
    });
    expect(out).toEqual({
      sessionId: '6', appid: 'wxa_abc', pagepath: 'pages/rooms/detail?id=1',
      thumbMediaId: 'MEDIA_1', thumbImageUrl: 'https://cdn.example.com/cover.jpg', title: '温馨大床房',
    });
  });

  it('buildProxyTarget 按类型映射 platform-server chat 路径', () => {
    expect(buildProxyTarget('text', '6')).toBe('/api/chat/send');
    expect(buildProxyTarget('media', '6')).toBe('/api/chat/send-media');
    expect(buildProxyTarget('room-card', '6')).toBe('/api/chat/session/6/send-room-card');
    expect(buildProxyTarget('package', '6')).toBe('/api/chat/session/6/send-package');
    expect(buildProxyTarget('miniprogram', '6')).toBe('/api/chat/session/6/send-miniprogram');
    expect(buildProxyTarget('guide', '6')).toBe('/api/chat/session/6/send-guide');
  });
});

describe('kf-staff isSessionInStores 归属校验', () => {
  it('platform 返回 200 且 success=true → 归属 true', async () => {
    const result = await withStubbedFetch(okFetch({ success: true }), () => isSessionInStores(6, ['store-a']));
    expect(result).toBe(true);
  });

  it('platform 返回 200 且 success=false → 归属 false', async () => {
    const result = await withStubbedFetch(okFetch({ success: false }), () => isSessionInStores(6, ['store-a']));
    expect(result).toBe(false);
  });

  it('网络异常 → 返回 null（平台故障不可确认）', async () => {
    const result = await withStubbedFetch(
      async () => { throw new Error('ECONNREFUSED'); },
      () => isSessionInStores(6, ['store-a']),
    );
    expect(result).toBe(null);
  });

  it('非 2xx → 返回 null（平台故障不可确认）', async () => {
    const result = await withStubbedFetch(
      async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }),
      () => isSessionInStores(6, ['store-a']),
    );
    expect(result).toBe(null);
  });

  it('响应无法解析 → 返回 null（平台故障不可确认）', async () => {
    const result = await withStubbedFetch(okFetch(null), () => isSessionInStores(6, ['store-a']));
    expect(result).toBe(null);
  });
});

describe('kf-staff buildGroupSendBody 群发参数', () => {
  it('buildGroupSendBody 校验群发参数并返回代理 body（wecomUserid 由后端回填）', () => {
    const body = buildGroupSendBody({ externalUserids: ['wm_x'], contentType: 'text', content: '你好' });
    expect(body).toEqual({ externalUserids: ['wm_x'], contentType: 'text', content: '你好' });
    expect(buildGroupSendBody({ externalUserids: [] })).toBe(null);
    expect(buildGroupSendBody({ externalUserids: [123] })).toBe(null); // 非字符串被过滤
    expect(buildGroupSendBody(undefined)).toBe(null);
  });
});
