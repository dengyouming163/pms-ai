'use client';
import { useState, useEffect } from 'react';
import { apiGet } from '@/lib/api-client';

interface VoiceProfile {
  id: string;
  name: string;
  status: string;
  aliyunVoiceId?: string;
}

interface Props {
  selectedId: string;
  onSelect: (id: string) => void;
}

export function VoiceSelector({ selectedId, onSelect }: Props) {
  const [voices, setVoices] = useState<VoiceProfile[]>([]);

  useEffect(() => {
    apiGet('/api/voice/list').then((d: any) => setVoices(d.data || [])).catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {voices.filter(v => v.status === 'ready').map(v => (
        <button
          key={v.id}
          onClick={() => onSelect(v.id)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
            selectedId === v.id ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          🎤 {v.name}
        </button>
      ))}
      {voices.filter(v => v.status === 'ready').length === 0 && (
        <span className="text-xs text-slate-400">暂无可用音色，请先在"我的声音"中添加</span>
      )}
    </div>
  );
}
