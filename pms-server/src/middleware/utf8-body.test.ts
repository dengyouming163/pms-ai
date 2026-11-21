import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { utf8BodyMiddleware } from './utf8-body.js';

// 本文件测的是**接在 app 上的那一层**，所以自拼 app 而不用现成 router ——
// 与 `mini-auth.test.ts` 同理：没有 `app.use` 这一跳就测不到本文件的主题。

const ascii = (s: string) => Array.from(s, (ch) => ch.charCodeAt(0));
/** 「验收」的 **GBK** 字节。这正是 Windows 控制台中文被当成 UTF-8 送出去时的形状。 */
const GBK_YANSHOU = [0xd1, 0xe9, 0xca, 0xd5];

/** 一条 JSON 请求体，其中 name 字段是 GBK 字节 ⇒ 整体**不是**合法 UTF-8。 */
const gbkJson = () =>
  new Uint8Array([...ascii('{"name":"'), ...GBK_YANSHOU, ...ascii('"}')]);

/** 一段**任意二进制**（含 0xFF 0xFE），用来代表上传文件的内容。 */
const binaryBody = () => new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xd1, 0xe9]);

function buildApp(useGuard: boolean) {
  const calls: string[] = [];
  const app = new Hono();
  if (useGuard) app.use('*', utf8BodyMiddleware);
  app.post('/x', async (c) => {
    calls.push('handler');
    const ct = c.req.header('content-type') ?? '';
    if (!ct.includes('json')) return c.json({ success: true, parsed: false });
    // 与生产同形（`routes/auth.ts` 也是 `.catch(() => ({}))`）：空体不该让这条用例
    // 变成在测「JSON.parse 对空串怎么反应」，那不是本文件的主题。
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    // 回**码点**而不是字符串：失败时能一眼看出是 U+FFFD(fffd) 还是真的汉字。
    return c.json({
      success: true,
      parsed: true,
      name: body.name,
      codepoints: Array.from(body.name ?? '', (ch) => ch.codePointAt(0)!.toString(16)),
    });
  });
  return { app, calls };
}

const post = (
  app: Hono,
  body: Uint8Array,
  contentType: string,
) =>
  app.request('/x', {
    method: 'POST',
    headers: { 'content-type': contentType },
    // Hono/undici 的 RequestInit.body 类型不收泛型 Uint8Array<ArrayBufferLike>；
    // Buffer 是 Uint8Array 子类，Buffer.from 逐字节拷贝，运行时与原 Uint8Array 等价。
    body: Buffer.from(body),
  });

describe('非 UTF-8 字节必须被拦在建库之前', () => {
  it('阴性对照：同一条请求体在**没有闸**时会被静默损坏（证明这份夹具真的复现了缺陷）', async () => {
    const { app, calls } = buildApp(false);
    const res = await post(app, gbkJson(), 'application/json');

    // 没有闸时它是 **200** —— 缺陷之所以是缺陷，正因为它不报错。
    expect(res.status).toBe(200);
    const json = await res.json();
    // 下游拿到的是坏值：汉字变成了 U+FFFD。这条用例若变红，说明夹具不再复现缺陷，
    // 上面那条「有闸 → 400」也就失去了判别力。
    expect(json.codepoints).not.toContain('9a8c');
    expect(json.codepoints).toContain('fffd');
    expect(calls).toEqual(['handler']);
  });

  it('有闸时 → 400，且**下游 handler 完全没被调用**（拦在入库之前）', async () => {
    const { app, calls } = buildApp(true);
    const res = await post(app, gbkJson(), 'application/json');

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('UTF-8');
    expect(calls).toEqual([]);
  });

  it('请求体声明了 charset=gbk 时，报错文案点名该字符集（诊断信息，不是拒绝依据）', async () => {
    const { app } = buildApp(true);
    const res = await post(app, gbkJson(), 'application/json; charset=gbk');

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('gbk');
  });
});

describe('不能误伤既有流量', () => {
  it('合法 UTF-8 中文 → 放行，且下游拿到的值逐码点原样（证明读字节没有读坏 body）', async () => {
    const { app, calls } = buildApp(true);
    const res = await post(
      app,
      new TextEncoder().encode('{"name":"验收·采风员"}'),
      'application/json',
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe('验收·采风员');
    expect(json.codepoints).toEqual(['9a8c', '6536', 'b7', '91c7', '98ce', '5458']);
    expect(calls).toEqual(['handler']);
  });

  it('emoji（代理对）不被拆坏', async () => {
    const { app } = buildApp(true);
    const res = await post(app, new TextEncoder().encode('{"name":"场地🏔️A"}'), 'application/json');

    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('场地🏔️A');
  });

  it('multipart/form-data 里的任意二进制 → **不检查**、放行（否则正常上传全被打成 400）', async () => {
    const { app, calls } = buildApp(true);
    const res = await post(app, binaryBody(), 'multipart/form-data; boundary=----x');

    expect(res.status).toBe(200);
    expect(calls).toEqual(['handler']);
  });

  it('text/plain 的任意二进制 → 不检查、放行', async () => {
    const { app } = buildApp(true);
    const res = await post(app, binaryBody(), 'text/plain');

    expect(res.status).toBe(200);
  });

  it('声明 charset=ISO-8859-1 但体是纯 ASCII → 放行（charset 不作拒绝依据）', async () => {
    const { app } = buildApp(true);
    const res = await post(
      app,
      new TextEncoder().encode('{"name":"ascii-only"}'),
      'application/json; charset=ISO-8859-1',
    );

    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('ascii-only');
  });

  it('空体 POST → 与无闸时行为一致（不放行也不拦）', async () => {
    const guarded = buildApp(true);
    const unguarded = buildApp(false);
    const a = await post(guarded.app, new Uint8Array(0), 'application/json');
    const b = await post(unguarded.app, new Uint8Array(0), 'application/json');

    // 判据不写死状态码，而是要求**加了闸也不改变既有行为**。
    expect(a.status).toBe(b.status);
    expect(guarded.calls).toEqual(['handler']); // 到达下游 ⇒ 确实没被此闸拦下
  });
});
