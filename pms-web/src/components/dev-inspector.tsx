'use client';

import { useEffect, useState } from 'react';

/**
 * Lazy-loaded React Dev Inspector - only in DEV mode, only on client.
 * Avoids hydration mismatch by deferring render to useEffect.
 */
export function DevInspector() {
  const [show, setShow] = useState(false);
  const [Inspector, setInspector] = useState<React.ComponentType | null>(null);

  useEffect(() => {
    if (process.env.COZE_PROJECT_ENV === 'DEV') {
      import('react-dev-inspector').then((mod) => {
        setInspector(() => mod.Inspector);
        setShow(true);
      }).catch(() => {
        // react-dev-inspector not available, skip
      });
    }
  }, []);

  if (!show || !Inspector) return null;

  return <Inspector />;
}
