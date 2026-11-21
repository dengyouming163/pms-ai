import { describe, it, expect, vi } from 'vitest';
import { effectiveAmountFen, effectiveProductAmountFen } from '../wechat-pay.js';

// ============================================================
// wechat-pay.ts 纯函数单测：effectiveAmountFen（测试模式金额开关）
// WXPAY_TEST_AMOUNT_FEN 正整数 → 强制所有支付金额为该分值；
// 0 / 空 / 未配置 / 非数字 → 用真实金额
// ============================================================

const KEY = 'WXPAY_TEST_AMOUNT_FEN';

/** 设置测试金额开关后执行，随后清理，避免用例间相互污染 */
function withAmountFen(value: string | undefined, fn: () => void) {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    fn();
  } finally {
    delete process.env[KEY];
  }
}

// ⚠️ 本文件全部用例假定 NODE_ENV !== 'production'（vitest 默认给 'test'）。
//    若在 production 下跑，下面 6 条会失败 —— 那是**正确**信号，不是要 skip 掉的东西。
describe('effectiveAmountFen', () => {
  it('配置=1 → 强制返回 1 分钱（小额联调）', () => {
    withAmountFen('1', () => expect(effectiveAmountFen(8800)).toBe(1));
  });
  it('配置=其他正整数 → 强制返回该分值', () => {
    withAmountFen('5', () => expect(effectiveAmountFen(100)).toBe(5));
  });
  it('配置为空字符串 → 返回真实金额', () => {
    withAmountFen('', () => expect(effectiveAmountFen(8800)).toBe(8800));
  });
  it('未配置 → 返回真实金额', () => {
    withAmountFen(undefined, () => expect(effectiveAmountFen(8800)).toBe(8800));
  });
  it('配置=0 → 返回真实金额', () => {
    withAmountFen('0', () => expect(effectiveAmountFen(8800)).toBe(8800));
  });
  it('配置为非数字 → 返回真实金额', () => {
    withAmountFen('abc', () => expect(effectiveAmountFen(8800)).toBe(8800));
  });
});

/** 临时代理 NODE_ENV 后执行 —— 与 withAmountFen 同一套纪律（务必 finally 还原，
 *  否则会把 'production' 泄漏给同 worker 的其它测试文件）。 */
function withNodeEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

describe('测试金额开关在生产不生效', () => {
  it('NODE_ENV=production 且开关为正整数 → 仍走真实金额', () => {
    withNodeEnv('production', () => {
      withAmountFen('1', () => expect(effectiveAmountFen(8800)).toBe(8800));
    });
  });

  it('NODE_ENV=production 且开关为空 → 真实金额（生产现状）', () => {
    withNodeEnv('production', () => {
      withAmountFen('', () => expect(effectiveAmountFen(8800)).toBe(8800));
    });
  });

  it('NODE_ENV=test 且开关为正整数 → 仍生效（保住联调通路）', () => {
    withNodeEnv('test', () => {
      withAmountFen('1', () => expect(effectiveAmountFen(8800)).toBe(1));
    });
  });
});

describe('effectiveProductAmountFen 同样受生产闸约束', () => {
  const PKEY = 'PRODUCT_PAY_TEST_AMOUNT_FEN';
  it('NODE_ENV=production → 真实金额', () => {
    withNodeEnv('production', () => {
      process.env[PKEY] = '1';
      try { expect(effectiveProductAmountFen(12800)).toBe(12800); }
      finally { delete process.env[PKEY]; }
    });
  });

  it('NODE_ENV=production 且开关为正整数 → 告警点名 PRODUCT_PAY_TEST_AMOUNT_FEN', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withNodeEnv('production', () => {
        process.env[PKEY] = '1';
        try { effectiveProductAmountFen(12800); }
        finally { delete process.env[PKEY]; }
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain(PKEY);
    } finally { spy.mockRestore(); }
  });
});

describe('生产闸出声告警（防静默忽略 / 防每单刷噪音）', () => {
  it('NODE_ENV=production 且开关为正整数 → 必须出声告警（防静默忽略）', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withNodeEnv('production', () => {
        withAmountFen('1', () => effectiveAmountFen(8800));
      });
      expect(spy).toHaveBeenCalledTimes(1);
      // 告警必须点名是哪个 env，否则生产日志里认不出是哪一个开关
      expect(String(spy.mock.calls[0]?.[0])).toContain('WXPAY_TEST_AMOUNT_FEN');
    } finally { spy.mockRestore(); }
  });

  it('NODE_ENV=production 且开关为空（生产现状）→ 不得出声（防每单刷噪音）', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withNodeEnv('production', () => {
        withAmountFen('', () => effectiveAmountFen(8800));
      });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
