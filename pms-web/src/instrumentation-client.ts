/**
 * Next.js instrumentation-client.ts
 * This file runs BEFORE React hydration on the client side.
 * Used to patch performance.measure to handle negative timestamps
 * that can occur in React 19 dev mode (flushInitialRenderPerformance).
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export function onBeforeReactHydration() {
  if (typeof performance === 'undefined' || !performance.measure) return;

  const origMeasure = performance.measure.bind(performance);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((performance.measure as any)._patched) return;

  const patchedMeasure = function (
    measureName: string,
    startOrOpts?: string | PerformanceMeasureOptions,
    endMark?: string
  ): PerformanceMeasure {
    try {
      return origMeasure(measureName, startOrOpts as PerformanceMeasureOptions, endMark);
    } catch {
      // Negative timestamp or other error — try with safe values
      try {
        if (typeof startOrOpts === 'object' && startOrOpts !== null) {
          const opts = startOrOpts as Record<string, unknown>;
          const start = typeof opts.start === 'number' ? opts.start : 0;
          const end = typeof opts.end === 'number' ? Math.max(opts.end as number, start) : start;
          return origMeasure(measureName, { ...startOrOpts, start, end } as PerformanceMeasureOptions);
        }
        const now = performance.now();
        return origMeasure(measureName, { start: now, end: now });
      } catch {
        // Last resort: return a dummy measure
        return {} as PerformanceMeasure;
      }
    }
  } as unknown as typeof performance.measure;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (patchedMeasure as any)._patched = true;
  performance.measure = patchedMeasure;
}
