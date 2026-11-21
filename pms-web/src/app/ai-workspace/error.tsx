'use client';

import { useEffect } from 'react';

export default function AIWorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('AI workspace error:', error); }, [error]);

  return (
    <div className="h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="text-center max-w-md">
        <p className="text-5xl mb-4">⚠️</p>
        <h2 className="text-lg font-bold text-slate-800 mb-2">页面加载异常</h2>
        <p className="text-sm text-slate-500 mb-2">AI 工作台遇到了一个错误</p>
        <p className="text-xs text-slate-400 bg-slate-100 rounded-lg p-3 mb-6 font-mono">{error.message}</p>
        <button onClick={reset} className="px-6 py-2.5 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 transition-colors">重新加载</button>
      </div>
    </div>
  );
}
