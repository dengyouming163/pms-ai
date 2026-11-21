// vitest 类型桩（避免全量引入 vitest 及其依赖的 @vitest/* 类型，见 git 历史）
// 覆盖现有测试用到的 API；新增测试若用到 vi/beforeEach/模拟匹配器/afterAll/describe.skipIf/beforeAll/toBeTruthy/toBeDefined/toHaveLength/toBeCloseTo，在此补充。
// 2026-09-19：Task 8 按上面这条约定追加了 toThrow / toBeLessThan（纯追加，未动既有成员）。
// 2026-09-20：S4 片② Task5（NEW-08）按同一约定追加 toBeCloseTo（纯追加，未动既有成员）。
// 2026-09-20：S4 片④ Task5（PL-asset-library-04 的 oss 半）按同一约定追加 toBeGreaterThanOrEqual（纯追加，未动既有成员）。
// 2026-09-21：文旅信标 Task5 按同一约定追加 toBeUndefined（纯追加，未动既有成员）。
// 2026-10-04：seed 二元化 tsc 归零片按同一约定追加 toBeFalsy / toContainEqual /
//   toBeLessThanOrEqual、expect(...).resolves 链、vi.hoisted / vi.importActual（纯追加，未动既有成员）。
//
// ⚠️ 仓内多处注释**复述了本文件的成员表**（「桩未声明 X」），因此会随本文件变化而过期。
//    已按提交 88519ea6 与本次提交两轮统一更正：凡复述成员表的地方改为
//    「是否可用**以 src/types/vitest.d.ts 为准**」，不再在别处复述。
//    **新增 matcher 时请只改本文件**；若发现别处仍有「桩未声明 X」的措辞，按同一原则改。
declare module 'vitest' {
  // describe 可链式：describe.skipIf(cond)(name, fn)（DB 冒烟按 RUN_DB 门控用）
  interface DescribeFn {
    (name: string, fn: () => void): void;
    skipIf(condition: boolean): DescribeFn;
    skip: DescribeFn;
  }
  export const describe: DescribeFn;
  // it 可链式：it.each(cases)(name, fn) —— 表驱动用例用
  interface ItFn {
    (name: string, fn: () => void | Promise<void>): void;
    each(cases: readonly unknown[][]): (name: string, fn: (...args: any[]) => void | Promise<void>) => void;
  }
  export const it: ItFn;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  interface Matchers<T> {
    toBe(expected: T): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toHaveLength(n: number): void;
    toBeGreaterThan(n: number | bigint): void;
    toBeGreaterThanOrEqual(n: number | bigint): void;
    toBeLessThan(n: number | bigint): void;
    toBeLessThanOrEqual(n: number | bigint): void;
    toEqual(expected: any): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: any): void;
    toMatch(expected: string | RegExp): void;
    toHaveBeenCalledTimes(n: number): void;
    toHaveBeenCalledWith(...args: any[]): void;
    toHaveBeenCalled(): void;
    toMatchObject(expected: object | any[]): void;
    toBeNull(): void;
    toHaveProperty(key: string | string[], value?: any): void;
    toThrow(expected?: string | RegExp): void;
    toBeCloseTo(expected: number, numDigits?: number): void;
    toBeInstanceOf(expected: any): void;
    // Promise 断言链：await expect(p).resolves / rejects 后接普通 matcher，可继续 .not。
    // 仓内现有用法：resolves.not.toThrow()、rejects.toThrow()。
    resolves: Matchers<any> & { not: Matchers<any> };
    rejects: Matchers<any> & { not: Matchers<any> };
  }
  export function expect<T>(actual: T, message?: string): Matchers<T> & { not: Matchers<T> };
  export namespace expect {
    function objectContaining(obj: Record<string, unknown>): any;
  }
  // spyOn 返回的 spy 句柄：本仓只用到「替换实现 + 读 calls + 还原」三件事。
  interface SpyInstance {
    mockImplementation(fn: (...args: any[]) => any): SpyInstance;
    mockClear(): void;
    mockRestore(): void;
    mock: { calls: any[][] };
  }
  export const vi: {
    fn: (impl?: (...args: any[]) => any) => any;
    mock: (modulePath: string, factory?: () => unknown) => void;
    // 提升：factory 返回值在 vi.mock factory 之前可用（mock factory 需引用同模块 mock 时用）
    hoisted: <T>(factory: () => T) => T;
    // 导入真实模块（部分 mock 时与 mock factory 配合用）
    importActual: <T = any>(modulePath: string) => Promise<T>;
    clearAllMocks: () => void;
    spyOn: (obj: any, method: string) => SpyInstance;
    stubEnv: (name: string, value: string) => void;
    unstubAllEnvs: () => void;
    unstubAllGlobals: () => void;
    stubGlobal: (name: string, value: any) => void;
    // 轮询等待条件成立（fire-and-forget 的异步写入只能这样等落地）。纯追加。
    waitFor: (
      fn: () => void | Promise<void>,
      options?: { timeout?: number; interval?: number },
    ) => Promise<void>;
  };
}
