import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { pmsBuiWenlvVenuePoints, pmsBuiWenlvScenes } from '../../db/schema/wenlv.js';

// 这条测试守的是「schema 与迁移必须同批」这个约束的一半：
// 迁移把那 6 列加进库了，schema 里却漏声明 ⇒ 读接口拿不到它们，
// 前端的四态徽标永远是「未印」而**不报错**（静默错）。
describe('铺码四态 schema 声明', () => {
  it('venue_points 声明了六个新列', () => {
    const cols = getTableColumns(pmsBuiWenlvVenuePoints);
    for (const k of ['printedAt', 'printedBy', 'placedAt', 'placedBy', 'verifiedAt', 'verifiedBy']) {
      expect(cols, `缺列 ${k}`).toHaveProperty(k);
    }
  });

  it('六个新列都可空且无默认（回填是编造现场事实）', () => {
    const cols = getTableColumns(pmsBuiWenlvVenuePoints) as Record<string, any>;
    for (const k of ['printedAt', 'printedBy', 'placedAt', 'placedBy', 'verifiedAt', 'verifiedBy']) {
      expect(cols[k].notNull, `${k} 不该是 NOT NULL`).toBe(false);
      expect(cols[k].hasDefault, `${k} 不该有默认值`).toBe(false);
    }
  });

  it('scenes 表声明了 venue_point_id 映射列', () => {
    // 索引本身在 pg 里（由迁移 0028 建），schema 不表达；这里只钉「列还在」。
    expect(getTableColumns(pmsBuiWenlvScenes)).toHaveProperty('venuePointId');
  });
});
