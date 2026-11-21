import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('0070 merch_redeems migration', () => {
  it('SQL 含状态机字段', () => {
    const sql = readFileSync(join(__dirname, '../../../../drizzle/0070_wenlv_merch_redeems.sql'), 'utf8');
    expect(sql).toContain('pms_bui_wenlv_merch_redeems');
    expect(sql).toContain('shipment_no');
    expect(sql).toContain('receiver_address');
  });
  it('Dockerfile 含 0070', () => {
    const dockerfile = readFileSync(join(__dirname, '../../../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('0070_wenlv_merch_redeems.sql');
  });
});
