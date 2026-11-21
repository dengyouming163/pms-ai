/**
 * Root page - redirected to /dashboard via next.config.ts redirects().
 * This file exists as a fallback; the actual redirect is handled at the
 * Next.js routing level, avoiding React performance measurement errors.
 */
export default function Home() {
  return null;
}
