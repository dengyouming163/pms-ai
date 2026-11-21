import { describe, it, expect } from 'vitest';
import {
  acquire, release, hold, SUCCESS_COOLDOWN_MS, _debugCooldownSize,
} from '../in-flight-guard.js';

// 无库、无线程。在飞用例不依赖时间（手动 acquire 就等价于「另一个请求正在飞」）；
// 冷却用例必须**真等**一小会儿（短 ms + setTimeout），**刻意不用** fake timers ——
// 假时钟既会把「冷却到期」退化成「实现里有没有读 Date.now()」的自证，也不检验惰性清理。
//
// ⚠️ 用例之间**不得残留占位**：模块级 Set/Map 是进程级共享的，漏了一个 release
// 会让后续用例（以及同进程的其它测试文件）莫名其妙全红。每条都自己收尾。
// 冷却**故意**没有主动清除的出口（`release` 不清它，这是要求），所以：
//   - 每条冷却用例都用**独占 key**，绝不共用；
//   - 凡断言 `_debugCooldownSize()`，一律用 before/after **相对**断言，
//     不写死绝对值（前一条留下的、无人再问津的过期条目会一直躺在表里）。
describe('in-flight 守卫（同 key 同时只允许一个在飞）', () => {
  it('首次 acquire → true', () => {
    const k = 'unit:first';
    expect(acquire(k)).toBe(true);
    release(k);
  });

  it('同 key 再 acquire → false（已有在飞）', () => {
    const k = 'unit:dup';
    expect(acquire(k)).toBe(true);
    expect(acquire(k)).toBe(false);
    release(k);
  });

  it('release 后可再次 acquire（证明不是永久锁死）', () => {
    const k = 'unit:reacquire';
    expect(acquire(k)).toBe(true);
    release(k);
    expect(acquire(k)).toBe(true);
    release(k);
  });

  it('不同 key 互不影响', () => {
    const a = 'unit:a';
    const b = 'unit:b';
    expect(acquire(a)).toBe(true);
    expect(acquire(b)).toBe(true);   // a 在飞不妨碍 b
    release(a);
    expect(acquire(a)).toBe(true);   // b 仍占着也不妨碍 a 重新占
    release(a);
    release(b);
  });

  it('被拒的 acquire 不会改动已有在飞条目：拒后再拒，释放后仍可占用', () => {
    // 钉住「不覆盖/重置已有条目」：若实现写成无条件 `Map.set(key, …)`
    // （例如把时间戳无脑刷新），这里的行为仍会一致 —— 所以本条真正的鉴别力在
    // 「连续多次拒绝后 release 一次即释放」：若实现是计数式（每次 acquire 自增），
    // 就得 release 同样多次，这条会红。
    const k = 'unit:no-clobber';
    expect(acquire(k)).toBe(true);
    expect(acquire(k)).toBe(false);
    expect(acquire(k)).toBe(false);
    release(k);
    expect(acquire(k)).toBe(true);
    release(k);
  });

  it('release 是幂等的：释放未占用的 key 不抛错，也不影响别的 key', () => {
    // 直接调用即可：它抛错的话本用例立刻失败。
    // 不写 `expect(() => …).not.toThrow()`：下面这条断言已完整覆盖「不抛」——
    // 真抛了，用例会以抛出失败而非断言失败。
    // ⚠️ 2026-09-19 更正：此注释原先给的理由（「桩没有声明 toThrow」）已不成立 ——
    //    该 matcher 自 d5a65359（Task 8）起已在桩内声明。
    release('unit:never-held');
    const k = 'unit:idem';
    expect(acquire(k)).toBe(true);
    release(k);
    release(k);                      // 重复释放
    expect(acquire(k)).toBe(true);
    release(k);
  });

  it('端点级前缀隔离：同一自然键按端点分键互不阻塞', () => {
    // 这是真实需求而不是假想：同一产品的「自举基线」与「生成批次」可以合法并行，
    // key 里不带端点名的话后者会被前者挡住。
    expect(acquire('bootstrap:p1')).toBe(true);
    expect(acquire('batch:p1')).toBe(true);
    expect(acquire('iterate:p1')).toBe(true);
    expect(acquire('bootstrap:p1')).toBe(false);
    release('bootstrap:p1');
    release('batch:p1');
    release('iterate:p1');
  });
});

// 成功后冷却：在飞集合只能挡**真正重叠**的并发，而本仓真实触发形态（同一个浏览器双击）
// 的两次请求是一前一后的（间隔 100–300ms > 一次 INSERT 的窗口）—— 那一段空窗只由冷却覆盖。
describe('成功后冷却（hold）', () => {
  it('常量就是 3000（改它要连带改模块注释里那段「为什么是 3s」）', () => {
    expect(SUCCESS_COOLDOWN_MS).toBe(3000);
  });

  it('hold 后 acquire → false，且冷却不会被 acquire 的拒绝刷新/计数（不是计数式）', () => {
    // ⚠️ 用例名**刻意不提「并没有在飞条目」**：本条的两条断言在「hold 顺手也往 inflight 里塞」
    //    的实现下**照样绿**，证明不了「冷却独立于在飞」。真要证明那件事得读 inflight 的内部
    //    状态，而本模块刻意只开了冷却表的只读窗口（见 `_debugCooldownSize`）。
    //    「冷却独立于在飞」由 `release 不清冷却` 那两条**反面**钉住（release 只动 inflight、
    //    冷却仍在 ⇒ 两个集合不共享条目），不靠本条。
    const k = 'unit:cooldown-hold';
    hold(k);                              // 用默认 SUCCESS_COOLDOWN_MS
    expect(acquire(k)).toBe(false);       // 冷却在挡（是不是也在飞，本条不主张）
    expect(acquire(k)).toBe(false);       // 再拒一次也不改冷却（不是计数式）
    // 没有收尾动作：冷却就是要留着的，本条用独占 key 即可（见文件头「不得残留占位」一节）。
  });

  it('冷却到期后 acquire → true（真等，不用 fake timers）', async () => {
    const k = 'unit:cooldown-expiry';
    hold(k, 30);
    expect(acquire(k)).toBe(false);       // 冷却中
    await new Promise(r => setTimeout(r, 60));
    expect(acquire(k)).toBe(true);        // 到期即放行
    release(k);                           // 收尾：还给后面的用例一个干净的 key
  });

  it('release 不**清**冷却（顺序一：release 先于 hold，/batch 与 /retry 的形状）', () => {
    // acquire → release → hold → 再 acquire 必须仍是 false。
    const k = 'unit:cooldown-survives-release-1';
    expect(acquire(k)).toBe(true);
    release(k);
    hold(k, 1000);
    expect(acquire(k)).toBe(false);
  });

  it('release 不**清**冷却（顺序二：hold 在 try 内、`finally` 的 release 后跑 —— /iterate 与 /bootstrap 的真实形状）', () => {
    // ⚠️ 这条才是**有鉴别力**的那条：顺序一里 `release` 跑在 `hold` **之前**，一个
    // 「release 顺手清冷却」的错误实现照样能让顺序一绿（删的时候还没有条目可删）。
    // 而 /iterate、/bootstrap 的端点写法是把 `hold(key)` 放在 `try` 内、`return` 之前，
    // 于是 `finally { release(key) }` 在 hold **之后**执行 —— 那种实现会把刚设好的冷却
    // 原样抹掉，等于冷却从未存在。这里逐个动作复刻该顺序。
    const k = 'unit:cooldown-survives-release-2';
    expect(acquire(k)).toBe(true);
    hold(k, 1000);                     // 成功路径：设冷却
    release(k);                        // finally：释放
    expect(acquire(k)).toBe(false);    // 冷却必须还在
  });

  it('冷却按 key 隔离：hold(a) 不影响 acquire(b)', () => {
    const a = 'unit:cooldown-iso-a';
    const b = 'unit:cooldown-iso-b';
    hold(a);
    expect(acquire(a)).toBe(false);
    expect(acquire(b)).toBe(true);        // 不同 key 的冷却互不牵连
    release(b);
  });

  it('过期条目被**惰性**清理：只在该 key 被 acquire 时删掉，没有定时器', async () => {
    const k = 'unit:cooldown-lazy';
    const before = _debugCooldownSize();
    hold(k, 30);
    expect(_debugCooldownSize()).toBe(before + 1);
    await new Promise(r => setTimeout(r, 60));
    // 已到期但**没人访问过它**：条目仍在 —— 「惰性」正是这个意思（有 setInterval 的实现
    // 会在这里被删掉，从而红在这一行；这是刻意的：本仓不用定时器）。
    expect(_debugCooldownSize()).toBe(before + 1);
    expect(acquire(k)).toBe(true);        // 顺手清理
    expect(_debugCooldownSize()).toBe(before);
    release(k);
  });
});
