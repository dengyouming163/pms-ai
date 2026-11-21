/**
 * 回写目标的形状定义。**单独一个文件**：`asset-types.ts` 与 `writeback.ts`
 * 都要用它，放在任一方里都会让另一方产生不必要的依赖方向。
 */
export type WritebackEntity =
  | 'node' | 'product' | 'collectible' | 'ending' | 'reward' | 'tier' | 'npc' | 'character';

export type WritebackDef =
  | {
      entity: WritebackEntity;
      /** drizzle schema 里的列名（TS camelCase，如 `styleAnchorUrl`）。 */
      column: string;
      /** 目标列是 jsonb 时必填 —— 写的是它的**子键**，且必须是合并而非整列覆盖。 */
      jsonKey?: string;
      /**
       * 写 URL，还是写 `design_assets.id`。
       * 目前只有 `stamp` 是 `assetId`（见 WenlvStampMeta.stampAssetId 的注释）。
       */
      value: 'url' | 'assetId';
    }
  | null;
