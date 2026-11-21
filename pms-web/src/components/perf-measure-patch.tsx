'use client';

import { useEffect } from 'react';

/**
 * Safety net: re-apply performance.measure patch if the
 * instrumentation-client.ts patch didn't take effect (e.g., in production builds).
 * Also installs global error handlers to suppress negative timestamp errors.
 */
export function PerfMeasurePatch() {
  useEffect(() => {
    if (typeof performance !== 'undefined' && performance.measure) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(performance.measure as any)._patched) {
        const origMeasure = performance.measure.bind(performance);

        const patched = function (
          name: string,
          startOrOpts?: string | PerformanceMeasureOptions,
          endMark?: string
        ) {
          try {
            return origMeasure(name, startOrOpts as PerformanceMeasureOptions, endMark);
          } catch {
            try {
              if (typeof startOrOpts === 'object' && startOrOpts !== null) {
                const opts = startOrOpts as Record<string, unknown>;
                const start = typeof opts.start === 'number' ? opts.start : 0;
                const end = typeof opts.end === 'number' ? Math.max(opts.end as number, start) : start;
                return origMeasure(name, { ...startOrOpts, start, end } as PerformanceMeasureOptions);
              }
              const now = performance.now();
              return origMeasure(name, { start: now, end: now });
            } catch {
              return {} as PerformanceMeasure;
            }
          }
        } as unknown as typeof performance.measure;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (patched as any)._patched = true;
        performance.measure = patched;
      }
    }

    // Global error handlers to suppress negative timestamp errors in console
    const errorHandler = (event: ErrorEvent) => {
      if (event.message?.includes('negative time stamp')) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      if (event.reason?.message?.includes('negative time stamp')) {
        event.preventDefault();
      }
    };

    window.addEventListener('error', errorHandler, true);
    window.addEventListener('unhandledrejection', rejectionHandler);

    return () => {
      window.removeEventListener('error', errorHandler, true);
      window.removeEventListener('unhandledrejection', rejectionHandler);
    };
  }, []);

  return null;
}
