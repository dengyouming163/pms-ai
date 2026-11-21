import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('0069 rewards merchandise migration', () => {
  it('迁移文件存在且含数据迁移', () => {
    const sql = readFileSync(join(__dirname, '../../../../drizzle/0069_wenlv_rewards_merchandise_type.sql'), 'utf8');
    expect(sql).toContain("SET type = 'merchandise'");
    expect(sql).toContain("type = 'merchant_rights'");
  });
  it('Dockerfile CMD 含 0069', () => {
    const dockerfile = readFileSync(join(__dirname, '../../../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('0069_wenlv_rewards_merchandise_type.sql');
  });
});
