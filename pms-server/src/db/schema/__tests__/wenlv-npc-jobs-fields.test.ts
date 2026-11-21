import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('0068 migration registration', () => {
  it('Dockerfile CMD 清单含 0068', () => {
    const dockerfile = readFileSync(join(__dirname, '../../../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('0068_wenlv_npc_jobs_general_fields.sql');
  });
  it('迁移文件存在', () => {
    const sql = readFileSync(join(__dirname, '../../../../drizzle/0068_wenlv_npc_jobs_general_fields.sql'), 'utf8');
    expect(sql).toContain('target_type');
    expect(sql).toContain('target_id');
    expect(sql).toContain('stage');
  });
});
