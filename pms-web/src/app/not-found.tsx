'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6">
      <div className="text-8xl font-bold text-slate-200">404</div>
      <h1 className="text-xl font-semibold text-slate-800">页面未找到</h1>
      <p className="max-w-md text-center text-sm text-slate-500">
        您访问的页面不存在或已被移除。请检查链接是否正确，或返回首页。
      </p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => window.history.back()}>
          返回上页
        </Button>
        <Link href="/dashboard">
          <Button>返回首页</Button>
        </Link>
      </div>
    </div>
  );
}
