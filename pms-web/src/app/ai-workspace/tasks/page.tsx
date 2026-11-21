'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api-client';

interface AITask {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  agentsInvolved: any;
  createdAt: string;
}

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<AITask[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 20;

  useEffect(() => {
    setLoading(true);
    apiGet(`/api/ai/chat/history?page=${page}&limit=${PAGE_SIZE}`).then((d: any) => {
      setTasks(d.history || []);
      setTotalPages(d.pagination?.totalPages || 1);
      setTotal(d.pagination?.total || 0);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [page]);

  // Group by session
  const sessions = tasks.reduce<Record<string, { messages: AITask[]; firstTime: string; lastTime: string; agents: string[] }>>((acc, t) => {
    const sid = t.sessionId || t.id;
    if (!acc[sid]) {
      acc[sid] = { messages: [], firstTime: t.createdAt, lastTime: t.createdAt, agents: [] };
    }
    acc[sid].messages.push(t);
    if (t.createdAt > acc[sid].lastTime) acc[sid].lastTime = t.createdAt;
    if (t.createdAt < acc[sid].firstTime) acc[sid].firstTime = t.createdAt;
    if (t.agentsInvolved && Array.isArray(t.agentsInvolved)) {
      t.agentsInvolved.forEach((a: any) => {
        if (!acc[sid].agents.includes(a.name || a)) acc[sid].agents.push(a.name || a);
      });
    }
    return acc;
  }, {});

  const sessionList = Object.entries(sessions).sort((a, b) => b[1].lastTime.localeCompare(a[1].lastTime));

  const getTitle = (msgs: AITask[]) => {
    const userMsg = msgs.find(m => m.role === 'user');
    return userMsg ? userMsg.content.slice(0, 50) + (userMsg.content.length > 50 ? '...' : '') : '对话记录';
  };

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 bg-white/80 backdrop-blur border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-slate-500 to-slate-600 flex items-center justify-center text-xl shadow-lg shadow-slate-500/20">📋</div>
          <div>
            <h1 className="text-lg font-bold text-slate-800">AI 任务记录</h1>
            <p className="text-xs text-slate-500">查看和管理所有 AI 对话与任务</p>
          </div>
        </div>
        <button onClick={() => router.back()} className="text-xs text-slate-400 hover:text-slate-600">← 返回</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scroll">
        {loading ? (
          <div className="text-center py-12 text-slate-400">加载中...</div>
        ) : sessionList.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-slate-500">暂无对话记录</p>
            <p className="text-xs text-slate-400 mt-1">开始和 AI 对话后，记录会出现在这里</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-3">
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 py-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50"
                >上一页</button>
                <span className="text-sm text-slate-500">第 {page}/{totalPages} 页 · 共 {total} 条</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50"
                >下一页</button>
              </div>
            )}
            {sessionList.map(([sid, session]) => (
              <div key={sid} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                <button
                  onClick={() => setExpandedTask(expandedTask === sid ? null : sid)}
                  className="w-full text-left px-5 py-4 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-700 text-sm truncate">{getTitle(session.messages)}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-slate-400">{session.firstTime?.slice(0, 16)}</span>
                        <span className="text-xs text-slate-300">{session.messages.length} 条消息</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {session.agents.slice(0, 2).map(a => (
                        <span key={a} className="text-xs px-2 py-0.5 bg-slate-100 rounded-full text-slate-500">{a}</span>
                      ))}
                      <span className="text-slate-300 text-sm">{expandedTask === sid ? '▾' : '▸'}</span>
                    </div>
                  </div>
                </button>
                {expandedTask === sid && (
                  <div className="border-t border-slate-100 px-5 py-3 bg-slate-50/50 max-h-60 overflow-y-auto custom-scroll">
                    {session.messages.map((m, i) => (
                      <div key={i} className={`mb-2 ${m.role === 'user' ? 'text-right' : ''}`}>
                        <div className={`inline-block max-w-[80%] px-3 py-2 rounded-xl text-sm ${m.role === 'user' ? 'bg-emerald-500 text-white' : 'bg-white text-slate-700 border border-slate-100'}`}>
                          {m.content.slice(0, 300)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar { width: 4px; } .custom-scroll::-webkit-scrollbar-track { background: transparent; } .custom-scroll::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 4px; }`}</style>
    </div>
  );
}
