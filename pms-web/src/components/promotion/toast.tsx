'use client';
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, X } from 'lucide-react';

interface ToastItem { id: number; message: string; type: 'success' | 'error'; }

let toastId = 0;
const listeners: Set<(t: ToastItem) => void> = new Set();

export function showToast(message: string, type: 'success' | 'error' = 'success') {
  const t: ToastItem = { id: ++toastId, message, type };
  listeners.forEach(fn => fn(t));
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((t: ToastItem) => {
    setToasts(prev => [...prev, t]);
    setTimeout(() => setToasts(prev => prev.filter(item => item.id !== t.id)), 2500);
  }, []);

  useEffect(() => {
    listeners.add(addToast);
    return () => { listeners.delete(addToast); };
  }, [addToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-6 right-6 z-[9999] flex flex-col gap-2">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-lg text-sm font-medium transition-all duration-300 ${
            t.type === 'success'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}
        >
          {t.type === 'success' ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <XCircle className="w-4 h-4 flex-shrink-0" />}
          <span>{t.message}</span>
          <button onClick={() => setToasts(prev => prev.filter(item => item.id !== t.id))} className="ml-2 p-0.5 hover:bg-black/5 rounded">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
