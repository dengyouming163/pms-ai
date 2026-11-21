'use client';
import { useState, useEffect } from 'react';
import { apiGet, apiPut, apiPost, apiDelete } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Check, Pencil, Trash2, RefreshCw, Eye, Sparkles, Loader2 } from 'lucide-react';

const TYPE_LABELS: Record<string, string> = {
  scenic: '周边景点', food: '美食推荐',
  transport: '交通指南', climate: '气候贴士', culture: '人文特色',
};

const TYPE_INFO: Record<string, { label: string; itemLabel: string }> = {
  scenic: { label: '🏔️ 周边景点', itemLabel: '景点' },
  food: { label: '🍜 美食推荐', itemLabel: '美食' },
  transport: { label: '🚗 交通指南', itemLabel: '交通信息' },
  climate: { label: '🌤️ 气候贴士', itemLabel: '气候信息' },
  culture: { label: '🎭 人文特色', itemLabel: '人文项目' },
};

export default function KBGuidesPage() {
  const [guides, setGuides] = useState<any[]>([]);
  const [activeType, setActiveType] = useState('scenic');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<any>({});
  const [aiInputs, setAiInputs] = useState<Record<string, string>>({});
  const [aiOptimizing, setAiOptimizing] = useState<Record<string, boolean>>({});

  const load = async () => {
    const res = await apiGet('/api/kb/guides');
    setGuides((res as any).data || []);
  };

  useEffect(() => { load(); }, []);

  const handlePublish = async (id: string) => {
    await apiPut(`/api/kb/guides/${id}/publish`, {});
    toast.success('已发布');
    load();
  };

  const handleDelete = async (id: string) => {
    await apiDelete(`/api/kb/guides/${id}`);
    toast.success('已删除');
    load();
  };

  const handleSave = async () => {
    if (!editingId) return;
    await apiPut(`/api/kb/guides/${editingId}`, editData);
    toast.success('已保存');
    setEditingId(null);
    load();
  };

  const handleAIOptimize = async (category: string) => {
    const keyword = aiInputs[category]?.trim();
    if (!keyword) return;

    setAiOptimizing(p => ({ ...p, [category]: true }));
    try {
      const res = await apiPost('/api/kb/ai-optimize', {
        category,
        keyword,
        storeContext: guides.length > 0 ? { storeName: '黔村院子' } : {},
      });
      if ((res as any).success) {
        setAiInputs(p => ({ ...p, [category]: '' }));
        toast.success(`已添加：${keyword}`);
        load();
      } else {
        toast.error((res as any).error || '添加失败');
      }
    } catch { toast.error('网络异常，请重试'); }
    finally { setAiOptimizing(p => ({ ...p, [category]: false })); }
  };

  const filtered = guides.filter((g: any) => (g.value?.guide_type || g.guide_type) === activeType);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">周边推荐管理</h1>

      {/* 分类标签 */}
      <div className="flex gap-2 flex-wrap">
        {Object.entries(TYPE_LABELS).map(([k, v]) => (
          <Button key={k} variant={activeType === k ? 'default' : 'outline'} size="sm" onClick={() => setActiveType(k)}>
            {v} ({guides.filter((g: any) => (g.value?.guide_type || g.guide_type) === k).length})
          </Button>
        ))}
      </div>

      {/* 推荐卡片列表 */}
      {filtered.length === 0 ? (
        <p className="text-gray-400 text-center py-8">该分类暂无推荐。请先在民宿档案页点击"AI 生成周边推荐"。</p>
      ) : (
        filtered.map((g: any) => {
          const v = g.value || {};
          const isEditing = editingId === g.id;
          return (
            <Card key={g.id}>
              {isEditing ? (
                <CardContent className="pt-4 space-y-3">
                  <Input value={editData.title || ''} onChange={e => setEditData({...editData, title: e.target.value})} placeholder="标题" />
                  <Textarea rows={3} value={editData.content || ''} onChange={e => setEditData({...editData, content: e.target.value})} />
                  <div className="grid grid-cols-3 gap-2">
                    <Input value={editData.metadata?.distance_text || ''} onChange={e => setEditData({...editData, metadata: {...editData.metadata, distance_text: e.target.value}})} placeholder="距离描述" />
                    <Input value={editData.metadata?.price || ''} onChange={e => setEditData({...editData, metadata: {...editData.metadata, price: e.target.value}})} placeholder="价格" />
                    <Input value={(editData.metadata?.tags || []).join(',')} onChange={e => setEditData({...editData, metadata: {...editData.metadata, tags: e.target.value.split(',')}})} placeholder="标签（逗号分隔）" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSave}><Check className="w-3 h-3 mr-1" />保存</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>取消</Button>
                  </div>
                </CardContent>
              ) : (
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-medium">{v.title}</span>
                        <Badge variant={v.status === 'published' ? 'default' : 'secondary'}>
                          {v.status === 'published' ? <Check className="w-3 h-3 mr-1" /> : <Eye className="w-3 h-3 mr-1" />}
                          {v.status === 'published' ? '已发布' : '草稿'}
                        </Badge>
                      </div>
                      <p className="text-sm text-gray-600">{v.content}</p>
                      {v.metadata && (
                        <div className="flex gap-2 mt-2 text-xs text-gray-400">
                          {v.metadata.distance_text && <span>{v.metadata.distance_text}</span>}
                          {v.metadata.price && <span>· {v.metadata.price}</span>}
                          {(v.metadata.tags || []).map((t: string, i: number) => (
                            <span key={i} className="px-1.5 py-0.5 bg-gray-100 rounded">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 ml-4">
                      <Button size="sm" variant="ghost" onClick={() => { setEditingId(g.id); setEditData(v); }}><Pencil className="w-3 h-3" /></Button>
                      {v.status !== 'published' && (
                        <Button size="sm" variant="ghost" onClick={() => handlePublish(g.id)}><Check className="w-3 h-3" /></Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => handleDelete(g.id)}><Trash2 className="w-3 h-3 text-red-400" /></Button>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })
      )}

      {/* AI 优化添加 */}
      <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-dashed border-gray-300">
        <p className="text-xs text-gray-500 mb-2">
          缺少某个{TYPE_INFO[activeType]?.itemLabel || ''}？输入名称，AI 自动生成详细信息并添加到列表
        </p>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            placeholder={`输入${TYPE_INFO[activeType]?.itemLabel || ''}名称，如"天河潭"`}
            value={aiInputs[activeType] || ''}
            onChange={e => setAiInputs(p => ({ ...p, [activeType]: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') handleAIOptimize(activeType); }}
          />
          <Button
            size="sm"
            onClick={() => handleAIOptimize(activeType)}
            disabled={!aiInputs[activeType] || aiOptimizing[activeType]}
          >
            {aiOptimizing[activeType] ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
            {aiOptimizing[activeType] ? '生成中...' : 'AI优化添加'}
          </Button>
        </div>
      </div>
    </div>
  );
}
