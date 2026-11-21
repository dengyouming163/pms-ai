import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ASSET_TYPES, ALL_ASSET_TYPES, GENERATABLE_TYPES } from '../asset-types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(here, '../../../../db/schema/wenlv.ts'), 'utf8');

describe('类型注册表完备性', () => {
  it('每个 JobAssetType 都有 def，且 def.type 与键一致', () => {
    for (const t of ALL_ASSET_TYPES) {
      const def = ASSET_TYPES[t];
      expect(def.type).toBe(t);
    }
    // ⛔ **不要在这里写「反向：注册表里不能有多余键」那条断言。**
    //   `ALL_ASSET_TYPES` 的定义就是 `Object.keys(ASSET_TYPES)`，所以
    //   `expect(Object.keys(ASSET_TYPES).sort()).toEqual([...ALL_ASSET_TYPES].sort())`
    //   是**同一个数组和自己比** —— 恒真，改什么都不红
    //   （已实测：往注册表塞一个多余键，原先四条断言全绿）。
    //   真正的守卫是那行类型注解 `Record<JobAssetType, AssetTypeDef>`：
    //   对象字面量多写一个键会被 TS 的 excess-property 检查拦下。运行时补不了这一条。
    //
    //   `expect(def).toBeDefined()` 同理恒真（`t` 就取自 ASSET_TYPES 的键），已删。
  });

  it('每个 writeback 的 column 都能在 drizzle schema 里找到对应列', () => {
    // 这条挡住「注册表写了 rewards.image，实际列名是 reward_image」这类静默失效
    const ENTITY_TABLE: Record<string, string> = {
      node: 'pmsBuiWenlvScenes',
      product: 'pmsBuiWenlvProducts',
      collectible: 'pmsBuiWenlvCollectibles',
      ending: 'pmsBuiWenlvScenes',
      reward: 'pmsBuiWenlvRewards',
      tier: 'pmsBuiWenlvRewardTiers',
      character: 'pmsBuiWenlvCharacters',
      npc: 'pmsBuiWenlvNpcs',
    };
    for (const t of ALL_ASSET_TYPES) {
      const wb = ASSET_TYPES[t].writeback;
      if (wb === null) continue;
      // ⛔ **这条不变量不是重复：没有它，改错 `entity` 检不出来。**
      //   下面的断言只回答「注册表声明的那个 entity 对应的表里，有没有这个列名」。
      //   而 `image` 这一列在 node / collectible / ending / reward **四张表同名** ——
      //   把 `background.writeback.entity` 从 `node` 改成 `collectible`，
      //   于是去 collectibles 表里找 `'image'`，**照样找得到，四条断言全绿**（已实测）。
      //   而 `scope` 是「这条素材按什么维度展开」，与回写目标表恒等 —— 逐条核过本表所有条目，
      //   仅 `style_bible`（writeback 为 null）例外，上面已 continue。
      expect(wb.entity, `${t}: writeback.entity 与 scope 不一致`).toBe(ASSET_TYPES[t].scope);
      const table = ENTITY_TABLE[wb.entity];
      expect(table, `${t}: 未知 entity ${wb.entity}`).toBeDefined();
      // 从 schema 源码里截出该表定义块，再找列名
      const start = SCHEMA.indexOf(`export const ${table} = pgTable`);
      expect(start, `${t}: schema 里找不到 ${table}`).toBeGreaterThan(-1);
      // ⚠️ 表的结尾**不一定是 `});`** —— 带索引回调的表（如 `pmsBuiWenlvScenes`）
      //   结尾可能是 `]);`。若按 `indexOf('});', start)` 截块，会**越过本表**
      //   一直切到下一张表（collectibles）的 `});`，于是「nodes.image 被改名」这类
      //   错误会被 collectibles 的 `'image'` 掩盖 —— 一条**假绿通道**。
      //   右边界改用「下一个顶层 `export const `」（表块内不存在顶层 export const）。
      const nextExport = SCHEMA.indexOf('\nexport const ', start + 1);
      const block = SCHEMA.slice(start, nextExport > -1 ? nextExport : SCHEMA.length);
      expect(block, `${t}: ${table} 里找不到列 ${wb.column}`).toContain(`'${snake(wb.column)}'`);
      if (wb.jsonKey) {
        // ⚠️ jsonb 子键声明在**该列挂的 `$type<X>`** 里，**不在表块内**。
        //   直接在 block 里找子键名会恒假 —— 例如 `stampAssetId` 在 **schema 里**只出现一次，
        //   位置是 `WenlvStampMeta` 的类型定义（wenlv.ts:98-101），不是表块。
        //   故：先抠出这一列挂的类型名，再去该类型定义块里找子键。
        // ⚠️ **这条只验「子键名出现在该类型块里」，不验「就是它」** —— 已实测：
        //   把 `stamp.writeback.jsonKey` 改成 `icon` / `shape` / `color` / `pattern` /
        //   `limited` 中任意一个，这里**照样全绿**（它们都在 `WenlvStampMeta` 里）。
        //   真正逐字钉死 jsonKey 的是 **Task 5** 的
        //   `expect(buildWritebackPlan('stamp', …)).toEqual({ …, jsonKey: 'stampAssetId', … })`。
        //   别把这条当成「jsonKey 已被测住了」而省掉 Task 5 那条。
        const colLine = block.split('\n').find((l) => l.includes(`'${snake(wb.column)}'`));
        expect(colLine, `${t}: 表里找不到列 ${snake(wb.column)} 的行`).toBeTruthy();
        const m = colLine!.match(/\$type<(\w+)>/);
        expect(m, `${t}: ${wb.column} 未声明 $type<...>`).toBeTruthy();
        const tn = m![1];
        const tStart = SCHEMA.indexOf(`export type ${tn} = `);
        expect(tStart, `${t}: schema 里找不到类型 ${tn}`).toBeGreaterThan(-1);
        // 右边界用 `};`：与上面表块那条同类手法，但**这里不会越界** ——
        // `WenlvStampMeta`（wenlv.ts:98-101）是扁平类型，`tStart` 之后第一个 `};`
        // 就是它自己的结尾（已实测：全 schema 的 `};` 位置里，`tStart` 之后最近的是 :101）。
        // 与表块那条的区别：这条最坏情况是**假红**（切片截短、丢键 → 失败），不是假绿。
        // ⚠️ 前提是 `$type<X>` 指向的类型块内**不要**出现更早的 `};`（如单行嵌对象
        //    `{ a: { b: string }; ... }`）—— 真出现了，这里应改成与表块相同的
        //    「取下一个顶层声明」写法。
        expect(
          SCHEMA.slice(tStart, SCHEMA.indexOf('};', tStart)),
          `${t}: 类型 ${tn} 未声明子键 ${wb.jsonKey}`,
        ).toContain(wb.jsonKey);
      }
    }
  });

  it('stamp 写 assetId、其余写 url —— 逐类型钉死，防日后改串', () => {
    expect(ASSET_TYPES.stamp.writeback).toMatchObject({ jsonKey: 'stampAssetId', value: 'assetId' });
    for (const t of ALL_ASSET_TYPES) {
      if (t === 'stamp') continue;
      const wb = ASSET_TYPES[t].writeback;
      // null = **不经 `applyWriteback` 回写**（`style_bible`，以及旁白 `narration` ——
      // 它由 `writeNarrationUrl` 单点承担），这类没有 `value` 可判，跳过。
      // ⚠️ 原先写的是 `wb === null || wb.value` 再 `.toBe('url')`：`wb` 为 null 时
      //    左边返回**布尔 `true`**，与 `'url'` 比较必然失败 —— 只是因为此前除
      //    `style_bible` 外没有 null 条目才一直没暴露。改成显式 continue。
      if (wb === null) continue;
      expect(wb.value).toBe('url');
    }
  });

  it('不可迭代的类型必须有理由文案（防静默改成 false）', () => {
    for (const t of ALL_ASSET_TYPES) {
      const def = ASSET_TYPES[t];
      if (!def.iterable) expect(def.iterationBlockReason, `${t} 不可迭代但没有理由`).toBeTruthy();
    }
  });
});

describe('character_avatar 类型登记', () => {
  it('已在注册表与 GENERATABLE_TYPES 里（漏登记的症状是「勾了却没反应」）', () => {
    expect(ASSET_TYPES.character_avatar).toBeDefined();
    expect(GENERATABLE_TYPES).toContain('character_avatar');
  });

  it('展开键是 character（**不是** product / node）', () => {
    // 归错维度的后果有前科：collectible 当年被归成 node，导致 N 节点 = N 条语义错误的 job、
    // N 次白计费。角色头像必须**每个角色一条**。
    expect(ASSET_TYPES.character_avatar.scope).toBe('character');
  });

  it('回写目标是 characters.avatar_url', () => {
    expect(ASSET_TYPES.character_avatar.writeback).toEqual({ entity: 'character', column: 'avatarUrl', value: 'url' });
  });
});

function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
