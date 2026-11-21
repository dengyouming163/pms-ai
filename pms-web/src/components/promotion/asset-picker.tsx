'use client';
import { useState, useEffect, useRef } from 'react';
import { Search, X, Upload, Trash2, Check, Loader2, Image, Music, Video } from 'lucide-react';

interface Asset {
  id: string; url: string; name: string; assetCategory: string; tags?: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (assets: Asset[]) => void;
  type?: 'image' | 'audio' | 'video' | 'all';
  multi?: boolean;
}

const API_BASE = '';

export function AssetPicker({ open, onClose, onSelect, type = 'all', multi = true }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState<'all' | 'image' | 'audio' | 'video'>(type === 'all' ? 'all' : type);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadAssets = () => {
    setLoading(true);
    const token = localStorage.getItem('pms_auth_token') || '';
    const storeId = localStorage.getItem('currentStoreId') || '';
    fetch(`${API_BASE}/api/assets`, { headers: { Authorization: `Bearer ${token}`, 'X-Store-Id': storeId } })
      .then(r => r.json()).then(d => setAssets(d.assets || [])).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { if (open) loadAssets(); }, [open]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    const token = localStorage.getItem('pms_auth_token') || '';
    const storeId = localStorage.getItem('currentStoreId') || '';
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData(); fd.append('file', file);
        const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}`, 'X-Store-Id': storeId } });
        const d = await res.json();
        if (d.success) {
          const cat = file.type.startsWith('video') ? 'video' : file.type.startsWith('audio') ? 'audio' : 'image';
          await fetch(`${API_BASE}/api/assets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Store-Id': storeId },
            body: JSON.stringify({ url: d.url, name: file.name, assetCategory: cat, tags: [] }),
          });
        }
      } catch {}
    }
    setUploading(false);
    loadAssets();
  };

  const handleDelete = async (id: string) => {
    const token = localStorage.getItem('pms_auth_token') || '';
    await fetch(`${API_BASE}/api/assets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    loadAssets();
  };

  const filtered = assets.filter(a => {
    if (tab === 'image') return !a.name?.match(/\.(mp3|wav|m4a|ogg|flac|mp4|mov|webm|avi)/i);
    if (tab === 'video') return a.name?.match(/\.(mp4|mov|webm|avi)/i);
    if (tab === 'audio') return a.name?.match(/\.(mp3|wav|m4a|ogg|flac)/i);
    return true;
  }).filter(a => !search || a.name?.toLowerCase().includes(search.toLowerCase()));

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else { if (!multi) next.clear(); next.add(id); }
    setSelected(next);
  };

  const handleConfirm = () => {
    const chosen = assets.filter(a => selected.has(a.id));
    onSelect(chosen);
    setSelected(new Set());
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-3xl w-[720px] h-[80vh] shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-bold text-slate-800">素材库</h3>
            <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
              {[
                { key: 'all' as const, label: '全部', icon: <Image className="w-3 h-3" /> },
                { key: 'image' as const, label: '图片', icon: <Image className="w-3 h-3" /> },
                { key: 'video' as const, label: '视频', icon: <Video className="w-3 h-3" /> },
              { key: 'audio' as const, label: '音频', icon: <Music className="w-3 h-3" /> },
              ].map(t => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === t.key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="搜索素材..."
                className="pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm w-48 focus:outline-none focus:ring-2 focus:ring-sky-500/20" />
            </div>
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex items-center gap-1.5 px-3 py-2 bg-sky-50 text-sky-700 rounded-xl text-xs font-medium hover:bg-sky-100 disabled:opacity-50">
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} 上传
            </button>
            <input ref={fileRef} type="file" multiple accept={tab === 'audio' ? 'audio/*' : tab === 'video' ? 'video/*' : tab === 'image' ? 'image/*' : 'image/*,audio/*,video/*'} className="hidden" onChange={handleUpload} />
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X className="w-5 h-5" /></button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 custom-scroll">
          {loading ? (
            <div className="flex items-center justify-center h-full text-slate-400"><Loader2 className="w-8 h-8 animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <Image className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">{search ? '未找到匹配素材' : '素材库为空，点击上传添加'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {filtered.map(a => {
                const isSelected = selected.has(a.id);
                const isAudio = a.name?.match(/\.(mp3|wav|m4a|ogg|flac)/i);
                const isVideo = a.name?.match(/\.(mp4|mov|webm|avi)/i);
                return (
                  <div key={a.id}
                    onClick={() => toggleSelect(a.id)}
                    className={`relative group rounded-xl overflow-hidden border-2 cursor-pointer transition-all ${
                      isSelected ? 'border-sky-500 shadow-md ring-2 ring-sky-200' : 'border-slate-200 hover:border-sky-300'
                    }`}>
                    {isVideo ? (
                      <div className="h-28 bg-slate-100 flex items-center justify-center">
                        <Video className="w-8 h-8 text-slate-300" />
                      </div>
                    ) : isAudio ? (
                      <div className="h-28 bg-slate-100 flex items-center justify-center">
                        <Music className="w-8 h-8 text-slate-300" />
                      </div>
                    ) : (
                      <img src={a.url} alt={a.name} className="w-full h-28 object-cover" />
                    )}
                    {isSelected && (
                      <div className="absolute top-2 right-2 w-6 h-6 bg-sky-500 rounded-full flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-white" />
                      </div>
                    )}
                    <button onClick={e => { e.stopPropagation(); handleDelete(a.id); }}
                      className="absolute top-2 left-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                      <Trash2 className="w-3 h-3" />
                    </button>
                    <div className="p-1.5">
                      <p className="text-[10px] text-slate-500 truncate">{a.name}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {selected.size > 0 && (
          <div className="flex-shrink-0 p-4 border-t border-slate-100 flex items-center justify-between">
            <span className="text-sm text-slate-500">已选 {selected.size} 个</span>
            <div className="flex gap-2">
              <button onClick={() => setSelected(new Set())} className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-50 rounded-xl">清空</button>
              <button onClick={handleConfirm} className="px-6 py-2 bg-sky-500 text-white rounded-xl text-sm font-medium hover:bg-sky-600">确定</button>
            </div>
          </div>
        )}
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );
}
