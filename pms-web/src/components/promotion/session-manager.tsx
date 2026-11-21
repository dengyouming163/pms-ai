'use client';
import { useState } from 'react';
import { Search, Plus, Trash2, MessageSquare } from 'lucide-react';

export interface SessionInfo {
  id: string;
  title: string;
  scene: string;
  style: string;
  duration: number;
  platform: string;
  messageCount: number;
  updatedAt: string;
}

interface Props {
  currentId: string | null;
  sessions: SessionInfo[];
  onSelect: (session: SessionInfo) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  open: boolean;
  onClose: () => void;
}

export function SessionManager({ currentId, sessions, onSelect, onCreate, onDelete, open, onClose }: Props) {
  const [search, setSearch] = useState('');

  const filtered = sessions.filter((s) =>
    !search || s.title.toLowerCase().includes(search.toLowerCase())
  );

  if (!open) return null;

  return (
    <div
      className="absolute top-full left-0 mt-2 w-80 bg-white rounded-2xl border border-slate-200 shadow-xl z-50 overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {/* 搜索栏 */}
      <div className="p-3 border-b border-slate-100">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话..."
            className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20"
          />
        </div>
      </div>

      {/* 会话列表 */}
      <div className="max-h-64 overflow-y-auto custom-scroll">
        {filtered.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-400">
            {search ? '无匹配会话' : '暂无历史会话'}
          </div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              onClick={() => { onSelect(s); onClose(); }}
              className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 flex items-center gap-3 cursor-pointer ${
                s.id === currentId ? 'bg-sky-50' : ''
              }`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') { onSelect(s); onClose(); } }}
            >
              <MessageSquare
                className={`w-4 h-4 flex-shrink-0 ${s.id === currentId ? 'text-sky-500' : 'text-slate-300'}`}
              />
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm font-medium truncate ${s.id === currentId ? 'text-sky-700' : 'text-slate-700'}`}
                >
                  {s.title || '新对话'}
                </p>
                <p className="text-[11px] text-slate-400">
                  {s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('zh-CN') : ''} · {s.messageCount} 条对话
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm('确定删除此会话？')) onDelete(s.id);
                }}
                className="p-1.5 hover:bg-red-50 rounded-lg text-slate-300 hover:text-red-500 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* 新建按钮 */}
      <div className="p-2 border-t border-slate-100">
        <button
          onClick={() => { onCreate(); onClose(); }}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-sky-600 hover:bg-sky-50 rounded-xl transition-colors"
        >
          <Plus className="w-4 h-4" /> 新建会话
        </button>
      </div>
    </div>
  );
}
