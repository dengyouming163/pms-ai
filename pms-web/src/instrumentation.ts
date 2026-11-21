/**
 * Next.js instrumentation entry point.
 * - instrumentation.ts runs on the server
 * - instrumentation-client.ts runs on the client BEFORE React hydration
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'client') {
    const { onBeforeReactHydration } = await import('./instrumentation-client');
    onBeforeReactHydration();
  }
}
