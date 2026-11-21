'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { OfflineBanner } from '@/components/layout/offline-banner';
import { StoreProvider } from '@/lib/context/store-context';
import { QuickActionProvider } from '@/lib/context/quick-action-context';
import { SidebarProvider, useSidebar } from '@/lib/context/sidebar-context';

const FULLSCREEN_PATHS = ['/login', '/ai-workspace'];

function LayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isFullscreen = FULLSCREEN_PATHS.some(p => pathname.startsWith(p));
  const { open, close } = useSidebar();

  if (isFullscreen) {
    return (
      <>
        <OfflineBanner />
        {children}
      </>
    );
  }

  return (
    <StoreProvider>
      <QuickActionProvider>
        <div className="min-h-screen bg-slate-100">
          <OfflineBanner />
          <Sidebar />
          <Header />
          {/* Mobile overlay */}
          {open && (
            <div
              className="fixed inset-0 bg-black/40 z-30 lg:hidden"
              onClick={close}
            />
          )}
          <main className="lg:ml-60 mt-16 p-5 min-h-[calc(100vh-64px)]">
            {children}
          </main>
        </div>
      </QuickActionProvider>
    </StoreProvider>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <LayoutInner>{children}</LayoutInner>
    </SidebarProvider>
  );
}
