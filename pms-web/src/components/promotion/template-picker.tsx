'use client';
import { useState, useEffect } from 'react';
import { apiGet } from '@/lib/api-client';

interface Template {
  id: string;
  name: string;
  mediaCount: number;
  textCount: number;
  tags: string;
  orientation?: string;
}

export function TemplatePicker({ selectedId, onSelect }: {
  selectedId: string;
  onSelect: (tpl: Template) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [filterTag, setFilterTag] = useState('');
  const [orientation, setOrientation] = useState('portrait');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet('/api/video/templates').then((d: any) => {
      if (d.success) {
        // TODO: 调试阶段仅开放单个模板，后续放开
        const all = d.data || [];
        setTemplates(all.filter((t: Template) => t.id === 'IceSys_VETemplate_s102137'));
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // 提取所有标签
  const allTags = [...new Set(templates.flatMap(t => {
    try { return JSON.parse(t.tags || '[]'); } catch { return []; }
  }))] as string[];

  // 标签映射中文名
  const tagLabel: Record<string, string> = {
    '酒店': '🏨 酒店民宿', '美食': '🍜 美食餐饮', '通用': '📱 通用',
    '口播': '🎙 口播', '时尚': '✨ 时尚', '企业': '🏢 企业',
    '科技': '💻 科技', '教育': '📚 教育', '促销': '🏷 促销',
    '片头': '🎬 片头', '宣传': '📢 宣传', '社交': '💬 社交',
    '图文': '🖼 图文', '竖版': '📱 竖版', '毕业': '🎓 毕业',
  };

  const filtered = templates.filter(t => {
    if (filterTag) {
      try { if (!JSON.parse(t.tags || '[]').includes(filterTag)) return false; } catch { return false; }
    }
    if (orientation && t.orientation && t.orientation !== orientation) return false;
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  if (loading) {
    return <div className="flex items-center justify-center py-8 text-slate-400 text-sm">加载模板库...</div>;
  }

  return (
    <div className="space-y-3">
      {/* 搜索 + 横竖版 + 标签筛选 */}
      <input value={search} onChange={e => setSearch(e.target.value)}
        placeholder="🔍 搜索模板名称..."
        className="w-full px-3 py-2 border rounded-xl text-sm" />

      <div className="flex gap-1.5 flex-wrap items-center">
        {(['portrait', 'landscape'] as const).map(o => (
          <button key={o} onClick={() => setOrientation(o === orientation ? '' : o)}
            className={`text-[10px] px-2 py-0.5 rounded-full ${
              orientation === o ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'
            }`}>
            {o === 'portrait' ? '📱 竖版' : '🖥 横版'}
          </button>
        ))}
        <span className="text-[10px] text-slate-300">|</span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <button onClick={() => setFilterTag('')}
          className={`text-[10px] px-2 py-0.5 rounded-full ${!filterTag ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
          全部({templates.length})
        </button>
        {['酒店', '口播', '美食', '通用', '社交', '促销', '时尚', '图文'].map(tag => {
          if (!allTags.includes(tag)) return null;
          return (
            <button key={tag} onClick={() => setFilterTag(filterTag === tag ? '' : tag)}
              className={`text-[10px] px-2 py-0.5 rounded-full ${filterTag === tag ? 'bg-sky-600 text-white' : 'bg-sky-50 text-sky-600'}`}>
              {tagLabel[tag] || tag}
            </button>
          );
        })}
      </div>

      {/* 模板卡片列表 */}
      <div className="grid grid-cols-2 gap-2">
        {filtered.map(tpl => {
          const tags = (() => { try { return JSON.parse(tpl.tags || '[]'); } catch { return []; } })();
          return (
            <button key={tpl.id} onClick={() => onSelect(tpl)}
              className={`text-left p-3 rounded-xl border transition-all ${
                selectedId === tpl.id
                  ? 'border-sky-300 bg-sky-50 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-sky-200 hover:bg-sky-50/50'
              }`}>
              <p className="text-xs font-semibold text-slate-700 truncate">{tpl.name}</p>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded">
                  🎬 {tpl.mediaCount}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 bg-violet-50 text-violet-600 rounded">
                  📝 {tpl.textCount}
                </span>
                {tags.slice(0, 2).map((tag: string) => (
                  <span key={tag} className="text-[9px] text-slate-400">{tag}</span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
