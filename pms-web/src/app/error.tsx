'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('页面渲染错误:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-red-50">
        <svg
          className="h-10 w-10 text-red-500"
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
      <h1 className="text-xl font-semibold text-slate-800">页面加载异常</h1>
      <p className="max-w-md text-center text-sm text-slate-500">
        很抱歉，页面渲染时出现了错误。请尝试刷新页面，或返回首页。
      </p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => (window.location.href = '/dashboard')}>
          返回首页
        </Button>
        <Button onClick={reset}>重试</Button>
      </div>
    </div>
  );
}
