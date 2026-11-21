'use client';

import { useState, useEffect, useRef } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Image as ImageIcon, Upload, Download, Trash2, Loader2 } from 'lucide-react';

const CATEGORIES = [
  { key: '', label: '全部' },
  { key: 'room', label: '🏠 房间照片' },
  { key: 'view', label: '🌄 周边风景' },
  { key: 'brand', label: '🏷️ 品牌素材' },
  { key: 'food', label: '🍳 餐饮美食' },
  { key: 'template', label: '📐 模板素材' },
  { key: 'other', label: '📁 其他' },
];

export default function AssetsPage() {
  const [assets, setAssets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchAssets = () => {
    const params = new URLSearchParams({ scope: 'all' });
    if (category) params.set('category', category);
    apiGet(`/api/assets?${params.toString()}`).then(d => setAssets(d.assets || [])).finally(() => setLoading(false));
  };
  useEffect(() => { setLoading(true); fetchAssets(); }, [category]);

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
          await apiPost('/api/assets', { url: data.url, name: file.name, assetCategory: category || 'room', tags: [] });
        }
      } catch {}
    }
    setUploading(false); fetchAssets();
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const token = localStorage.getItem('pms_auth_token');
      const params = new URLSearchParams({ scope: 'all' });
      if (category) params.set('category', category);
      const res = await fetch(`/api/assets/export?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `素材_${category || '全部'}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert('打包下载失败，请重试');
    }
    setExporting(false);
  };

  const handleDelete = async (id: string) => {
    const token = localStorage.getItem('pms_auth_token');
    await fetch(`/api/assets/${id}`, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    fetchAssets();
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center text-xl shadow-sm shadow-emerald-500/20">
            <ImageIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">素材资源</h1>
            <p className="text-sm text-slate-500">管理民宿图片、视频素材</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            {exporting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
            {exporting ? '打包中...' : '打包下载'}
          </Button>
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
            {uploading ? '上传中...' : '上传素材'}
          </Button>
        </div>
        <input ref={fileRef} type="file" multiple accept="image/*,video/*" className="hidden" onChange={handleUpload} />
      </div>

      {/* 分类筛选 */}
      <div className="flex gap-2 flex-wrap">
        {CATEGORIES.map(c => (
          <Button key={c.key} size="sm" variant={category === c.key ? 'default' : 'outline'} onClick={() => setCategory(c.key)}>
            {c.label}
          </Button>
        ))}
      </div>

      {/* 素材网格 */}
      <Card>
        <CardContent className="p-4">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />加载中...
            </div>
          ) : assets.length === 0 ? (
            <div className="text-center py-16 text-slate-400">
              <div className="text-5xl mb-3">🖼️</div>
              <p className="text-sm">还没有素材，点击上传</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {assets.map(a => (
                <div key={a.id} className="group relative bg-white rounded-xl border border-slate-100 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                  <img src={a.url} alt={a.name} className="w-full h-32 object-cover" />
                  <div className="p-2">
                    <p className="text-xs text-slate-600 truncate">{a.name}</p>
                    <p className="text-[10px] text-slate-400">{a.assetCategory}</p>
                  </div>
                  <button
                    onClick={() => handleDelete(a.id)}
                    className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="删除"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
