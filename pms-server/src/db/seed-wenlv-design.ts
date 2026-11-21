/**
 * 内置设计系统模板 seed（幂等：固定 id + upsert，且只更新 isBuiltin=true 的行）
 * 运行：cd pms-server && npx tsx --env-file=.env src/db/seed-wenlv-design.ts
 * 安全红线：只连 .env 指向的本机 dev 库，禁止指向远程/共享/生产库。
 *
 * 为什么必须是 upsert 而非 onConflictDoNothing：
 *   生产上三套模板早已 seed 过，`onConflictDoNothing` 对已存在行是 **no-op** ——
 *   新增的 surface / primarySoft / accentText 永远写不进去（命令打印「seeded」并退出 0，
 *   但数据库一行没变，属**静默失败**）。改 upsert 后重跑即可把新值推下去。
 *   `setWhere: isBuiltin = true` 是护栏：运营可能改过自建模板，seed 不得覆盖它们。
 */
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { pmsBuiWenlvDesignTemplates } from './schema/index.js';
import { BUILTIN_WENLV_TEMPLATES, assertDesignTokensCompliant } from './wenlv-design-builtin.js';

async function main() {
  // 准入门槛与写入**分离**：先一次性校验完所有模板再动库。
  // 否则断言在循环内时，第 2 套不合格会让第 1 套已经写进去 —— 库停在半新半旧状态。
  for (const t of BUILTIN_WENLV_TEMPLATES) {
    assertDesignTokensCompliant(t.id, t.tokens);
  }

  const notWritten: string[] = [];
  for (const t of BUILTIN_WENLV_TEMPLATES) {
    // `returning()` 自证受影响行数：`setWhere: isBuiltin = true` 不匹配时 PostgreSQL 既不报错也不更新，
    // 「命令没抛错」≠「数据写了」，只看后者会把静默 no-op 当成成功。
    const updated = await db.insert(pmsBuiWenlvDesignTemplates)
      .values({ id: t.id, name: t.name, styleTag: t.styleTag, tokens: t.tokens, isBuiltin: true })
      .onConflictDoUpdate({
        target: pmsBuiWenlvDesignTemplates.id,
        set: { tokens: t.tokens, name: t.name, styleTag: t.styleTag, updatedAt: new Date() },
        // 只更新内置模板：运营自建的模板 tokens 不该被 seed 覆盖
        setWhere: eq(pmsBuiWenlvDesignTemplates.isBuiltin, true),
      })
      .returning({ id: pmsBuiWenlvDesignTemplates.id });

    if (updated.length === 0) {
      notWritten.push(t.id);
      console.warn(
        `⚠️ ${t.id}（${t.name}）一行都没写进去：该 id 已存在行，但其 is_builtin 不是 true` +
        `（seed 不覆盖自建/运营模板），或该行不满足 setWhere 条件。请人工确认该 id 的归属。`,
      );
    } else {
      console.log('seeded 模板:', t.id, t.name);
    }
  }

  // 有不成立的模板就整体判失败：不打印「✅ 完成」，并以非 0 退出码让调用方看见
  if (notWritten.length > 0) {
    throw new Error(
      `以下内置模板一行都没写进去：${notWritten.join(', ')} —— seed 未完整生效，不能视为成功`,
    );
  }
  console.log('✅ 内置设计模板 seed 完成');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('❌ 内置设计模板 seed 失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
