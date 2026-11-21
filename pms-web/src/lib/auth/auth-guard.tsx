'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './auth-context';

const PUBLIC_PATHS = ['/login', '/voice-record'];

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // 公开页面不需要鉴权
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return <>{children}</>;
  }

  // 加载中
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <svg className="animate-spin h-8 w-8 text-emerald-600 mx-auto" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-slate-500 mt-3">加载中...</p>
        </div>
      </div>
    );
  }

  // 未登录 - 重定向到登录页
  if (!user) {
    return <RedirectToLogin router={router} />;
  }

  return <>{children}</>;
}

/** 独立组件，通过 useEffect 执行路由跳转，避免在渲染期间调用 router.push */
function RedirectToLogin({ router }: { router: ReturnType<typeof useRouter> }) {
  useEffect(() => {
    router.replace('/login');
  }, [router]);
  return null;
}
