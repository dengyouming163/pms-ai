'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

interface GlobalErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalErrorPage({ error, reset }: GlobalErrorPageProps) {
  useEffect(() => {
    console.error('全局错误:', error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body className="bg-slate-50 font-sans antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-red-50">
            <svg
              className="h-12 w-12 text-red-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-slate-800">系统异常</h1>
          <p className="max-w-md text-center text-sm text-slate-500">
            系统遇到了严重错误，暂时无法继续运行。请刷新页面尝试恢复。
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => (window.location.href = '/dashboard')}>
              返回首页
            </Button>
            <Button onClick={reset}>重试</Button>
          </div>
          <p className="mt-4 text-xs text-slate-400">智宿管家 · AI PMS</p>
        </div>
      </body>
    </html>
  );
}
