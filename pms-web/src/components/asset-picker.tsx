'use client';

import { useState, useEffect, useRef } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';

const CATEGORIES = [
  { key: '', label: '全部' },
  { key: 'room', label: '🏠 房间' },
  { key: 'view', label: '🌄 风景' },
  { key: 'brand', label: '🏷️ 品牌' },
  { key: 'food', label: '🍳 餐饮' },
  { key: 'template', label: '📐 模板' },
  { key: 'other', label: '📁 其他' },
];

interface AssetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (url: string) => void;
}

export function AssetPicker({ open, onOpenChange, onSelect }: AssetPickerProps) {
  const [assets, setAssets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchAssets = () => {
    setLoading(true);
    apiGet('/api/assets' + (category ? `?category=${category}` : ''))
      .then(d => setAssets(d.assets || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { if (open) fetchAssets(); }, [category, open]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files; if (!files?.length) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      try {
        const form = new FormData(); form.append('file', file);
        const token = localStorage.getItem('pms_auth_token');
        const res = await fetch('/api/upload', {
          method: 'POST', body: form,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json();
        if (data.success) {
          await apiPost('/api/assets', { url: data.url, name: file.name, assetCategory: category || 'brand', tags: [] });
        }
      } catch {}
    }
    setUploading(false); fetchAssets();
    toast.success('上传完成');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[70vw] !max-w-[70vw] h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">🖼️ 素材资源库</DialogTitle>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center justify-between flex-shrink-0 mb-4">
          <div className="flex gap-2 overflow-x-auto">
            {CATEGORIES.map(c => (
              <button key={c.key} onClick={() => setCategory(c.key)}
                className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
                  category === c.key ? 'bg-purple-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >{c.label}</button>
            ))}
          </div>
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm">
            {uploading ? '上传中...' : '📤 上传素材'}
          </Button>
          <input ref={fileRef} type="file" multiple accept="image/*,video/*" className="hidden" onChange={handleUpload} />
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto min-h-[400px]">
          {loading ? (
            <p className="text-center py-16 text-slate-400 text-sm">加载中...</p>
          ) : assets.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <div className="text-5xl mb-3">🖼️</div>
              <p className="text-sm">还没有素材，点击上传</p>
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-3">
              {assets.map(a => (
                <button key={a.id} onClick={() => { onSelect(a.url); onOpenChange(false); }}
                  className="group relative bg-white rounded-xl border border-slate-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow text-left cursor-pointer">
                  <img src={a.url} alt={a.name} className="w-full h-32 object-cover" />
                  <div className="p-2">
                    <p className="text-xs text-slate-600 truncate">{a.name}</p>
                    <p className="text-[10px] text-slate-400">{a.assetCategory}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
