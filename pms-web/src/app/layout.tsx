import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth/auth-context';
import { AuthGuard } from '@/lib/auth/auth-guard';
import { AiStoreProvider } from '@/lib/context/ai-store-context';
import { AppLayout } from '@/components/layout/app-layout';
import { PerfMeasurePatch } from '@/components/perf-measure-patch';
import { DevInspector } from '@/components/dev-inspector';
import { ModeProvider } from '@/lib/context/mode-context';
import { Toaster } from '@/components/ui/sonner';

export const metadata: Metadata = {
  title: { default: '智宿管家·AI PMS', template: '%s | 智宿管家' },
  description: '智宿管家·AI PMS 商家管理后台 - 酒店民宿智能化管理平台',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        <Toaster position="top-center" richColors duration={3000} />
        <PerfMeasurePatch />
        <DevInspector />
        <AuthProvider>
          <AuthGuard>
            <AppLayout><AiStoreProvider><ModeProvider>{children}</ModeProvider></AiStoreProvider></AppLayout>
          </AuthGuard>
        </AuthProvider>
      </body>
    </html>
  );
}
