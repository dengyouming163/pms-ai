import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkTicket } from '../wenlv-ticket-client.js';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';

afterEach(() => vi.unstubAllGlobals());

describe('wenlv-ticket-client', () => {
  it('带 X-Internal-Token 头调用 BFF 并解析 valid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { valid: true, ticketId: 't1' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const r = await checkTicket('P1', 'U1');
    expect(r.valid).toBe(true);
    expect(r.ticketId).toBe('t1');
    const [url, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string | undefined> }];
    expect(opts.headers['X-Internal-Token']).toBe(INTERNAL_SERVICE_TOKEN);
    expect(url).toContain('contentProductId=P1');
    expect(url).toContain('miniUserId=U1');
  });

  it('URL 参数做 encodeURIComponent 编码（中文/空格/&）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { valid: true } }) });
    vi.stubGlobal('fetch', fetchMock);
    const pid = '贵州 黄果树&A';
    const uid = 'u 1&2';
    await checkTicket(pid, uid);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(`contentProductId=${encodeURIComponent(pid)}`);
    expect(url).toContain(`miniUserId=${encodeURIComponent(uid)}`);
    expect(url).not.toContain('黄果树&A');
  });

  it('非 2xx（res.ok=false）即使 body 含 success 也 fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ success: true, data: { valid: true } }) }));
    expect((await checkTicket('P1', 'U1')).valid).toBe(false);
  });

  it('BFF 返回 success:false 时 fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false, error: 'x' }) }));
    expect((await checkTicket('P1', 'U1')).valid).toBe(false);
  });

  it('success:true 但 data.valid=false 时 fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { valid: false } }) }));
    expect((await checkTicket('P1', 'U1')).valid).toBe(false);
  });

  it('res.json() 解析失败（非 JSON body）时 fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('not json'); } }));
    expect((await checkTicket('P1', 'U1')).valid).toBe(false);
  });

  it('网络异常时 fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect((await checkTicket('P1', 'U1')).valid).toBe(false);
  });
});
