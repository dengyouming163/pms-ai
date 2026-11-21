import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('0072 claims qrcode migration', () => {
  it('迁移文件存在且含 qrcode 字段', () => {
    const sql = readFileSync(join(__dirname, '../../../../drizzle/0072_wenlv_claims_qrcode.sql'), 'utf8');
    expect(sql).toContain('qrcode');
    expect(sql).toContain('pms_bui_wenlv_claims');
  });
  it('Dockerfile CMD 含 0072', () => {
    const dockerfile = readFileSync(join(__dirname, '../../../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('0072_wenlv_claims_qrcode.sql');
  });
});
