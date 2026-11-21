'use client';
import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { API_BASE } from '@/lib/constants';
import { AssetPicker } from './asset-picker';
import { TemplatePicker } from './template-picker';
import { showToast, ToastContainer } from './toast';

interface PlanItem { id: string; title: string; script: string; createdAt: string; }

interface TemplateItem { id: string; name: string; mediaCount: number; textCount: number; tags: string; }

function parsePlan(markdown: string) {
  const content = markdown.replace(/^标题：.+\n/, '').trim();
  const hasH2 = /^## /m.test(content); const p = hasH2 ? '## ' : '';
  const rawTitle = new RegExp(`${p}📋[^\\n]*\\n([^\\n]+)`).exec(content)?.[1]?.trim() || '';
  const title = rawTitle.replace(/^标题[：:]\s*/, '').trim();
  const script = new RegExp(`${p}🎙️[^\\n]*\\n([\\s\\S]*?)(?=${p}✅|${p}📊|$)`).exec(content)?.[1]?.trim() || '';
  return { title, script };
}

export function FastCutPanel() {
  const sp = useSearchParams();
  const planIdParam = sp.get('planId');

  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanItem | null>(null);
  const [parsed, setParsed] = useState<any>(null);

  // 模式: template=模板成片, smartmix=智能图文混剪
  const [mixMode, setMixMode] = useState<'template' | 'smartmix'>('template');

  const [selectedVoiceId, setSelectedVoiceId] = useState('longhua_v3');
  // 图文快剪/智能混剪使用 SubmitMediaProducingJob，不支持 IMS 自定义音色
  // 自定义音色仅在一键成片（BatchPanel）中启用
  const [bgmStyle, setBgmStyle] = useState('');
  // 模板
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateItem | null>(null);

  // 素材（不分步骤，统一选择）
  const [mediaList, setMediaList] = useState<string[]>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);

  // AI 填充结果预览
  const [fillResult, setFillResult] = useState<any>(null);

  // 合成
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<any[]>([]);

  useEffect(() => {
    apiGet('/api/creation-records?type=copy&limit=30').then((d: any) => {
      if (d.success) { setPlans(d.data || []); if (planIdParam) { const f = (d.data||[]).find((p:PlanItem)=>p.id===planIdParam); if(f) handleSelectPlan(f); } }
    }).catch(()=>{});
  }, []);

  const loadJobs = async () => {
    try {
      const d: any = await apiGet('/api/video/fastcut-jobs');
      if (d.success) {
        const list = d.data || [];
        const updated = await Promise.all(list.map(async (j: any) => {
          if (j.status === 'processing' && j.aliyunTaskId) {
            const statusUrl = j.type === 'smartmix' ? `/api/video/smart-mix-status/${j.id}` : `/api/video/fastcut-status/${j.id}`;
            try {
              const s: any = await apiGet(statusUrl);
              if (s.success) return { ...j, status: s.data.status, outputUrl: s.data.outputUrl || j.outputUrl };
            } catch {}
          }
          return j;
        }));
        setJobs(updated);
      }
    } catch {}
  };

  useEffect(() => { loadJobs(); const i = setInterval(loadJobs, 15000); return () => clearInterval(i); }, []);

  const handleSelectPlan = (plan: PlanItem) => {
    setSelectedPlan(plan);
    setParsed(parsePlan(plan.script));
    setFillResult(null);
  };

  const handleRemoveMedia = (idx: number) => {
    setMediaList(p => p.filter((_, i) => i !== idx));
  };

  const ready = parsed && mediaList.length > 0
    && (mixMode === 'smartmix' ? true : !!selectedTemplate);

  // AI 自动填充 ClipsParam
  const handleAIFill = async () => {
    if (!ready) return;
    setSubmitting(true);
    try {
      const rawScript = parsed.script.replace(/\n*---\n*$/, '').trim();
      const res = await apiPost('/api/video/template-fill', {
        templateId: selectedTemplate!.id,
        script: rawScript,
        groupMedia: [{ step: 1, desc: '素材', media: mediaList }],
      });
      if (res.success) {
        setFillResult(res.data);
        showToast('AI 配置已填充，可手动调整后提交', 'success');
      } else {
        showToast('填充失败: ' + res.error, 'error');
      }
    } catch { showToast('AI 填充请求失败', 'error'); }
    setSubmitting(false);
  };

  // 提交智能混剪
  const handleSmartMixSubmit = async () => {
    if (!ready) return;
    setSubmitting(true);
    try {
      const rawScript = parsed.script.replace(/\n*---\n*$/, '').trim();
      const res = await apiPost('/api/video/smart-mix', {
        script: rawScript,
        title: (selectedPlan?.title || parsed.title || '智能混剪').replace(/^[\*#\s]*标题[：:]\s*/,'').replace(/[*#]+/g,'').trim(),
        mediaUrls: mediaList,
        bgmStyle: bgmStyle || undefined,
        voiceId: selectedVoiceId,
        orientation: 'portrait',
      });
      if (res.success) { showToast('智能混剪已提交!', 'success'); loadJobs(); }
      else showToast('失败: ' + res.error, 'error');
    } catch { showToast('请求失败', 'error'); }
    setSubmitting(false);
  };

  // 提交模板成片
  const handleSubmit = async () => {
    if (!fillResult) return;
    setSubmitting(true);
    try {
      const res = await apiPost('/api/video/template-submit', {
        templateId: selectedTemplate!.id,
        clipsParam: fillResult.clipsParam,
        orientation: 'portrait',
        title: (selectedPlan?.title || parsed.title || fillResult?.clipsParam?.Text0 || '模板快剪').replace(/^[\*#\s]*标题[：:]\s*/,'').replace(/[*#]+/g,'').trim(),
      });
      if (res.success) {
        showToast('模板成片已提交!', 'success');
        loadJobs();
      } else {
        showToast('提交失败: ' + res.error, 'error');
      }
    } catch { showToast('请求失败', 'error'); }
    setSubmitting(false);
  };

  return (
    <div className="grid grid-cols-[250px_1fr_280px] gap-4 h-full">
      {/* ====== 左侧：创作方案 ====== */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm overflow-y-auto custom-scroll flex flex-col">
        <p className="text-xs font-semibold text-slate-400 mb-2">📋 方案 ({plans.filter(p => p.script).length})</p>
        <div className="space-y-1">
          {plans.filter(p => p.script).map(p => (
            <button key={p.id} onClick={() => handleSelectPlan(p)}
              className={`w-full text-left p-2.5 rounded-xl text-sm ${selectedPlan?.id === p.id ? 'bg-sky-50 border border-sky-200' : 'hover:bg-slate-50 border border-transparent'}`}>
              <p className="font-semibold text-slate-700 truncate">{p.title || '未命名'}</p>
              <p className="text-xs text-slate-400 mt-0.5">{p.script.slice(0, 50)}...</p>
            </button>
          ))}
        </div>
      </div>

      {/* ====== 中间：方案 + 模板 + 素材 ====== */}
      <div className="flex flex-col min-h-0 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        {!parsed ? (
          <div className="flex flex-col items-center justify-center flex-1 text-slate-300 gap-3">
            <div className="text-6xl">📋</div>
            <p className="text-sm font-medium">从左侧选择创作方案开始</p>
          </div>
        ) : (
          <>
            {/* 方案预览 */}
            <div className="flex-shrink-0 bg-slate-50 rounded-xl border border-slate-100 p-3 mb-4">
              <h3 className="text-xs font-bold text-slate-700 mb-1">{parsed.title || '方案'}</h3>
              <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2">{parsed.script.slice(0, 200)}...</p>
            </div>

            {/* 模式切换 */}
            <div className="flex-shrink-0 bg-white rounded-xl border border-slate-200 p-2 mb-4">
              <div className="flex gap-1">
                {(['template', 'smartmix'] as const).map(m => (
                  <button key={m} onClick={() => { setMixMode(m); setFillResult(null); }}
                    className={`flex-1 text-xs py-2 rounded-lg font-medium transition-colors ${
                      mixMode === m ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}>
                    {m === 'template' ? '📐 模板成片' : '🎬 智能混剪'}
                  </button>
                ))}
              </div>
            </div>

            {/* 模板 + 素材 */}
            <div className="flex-1 min-h-0 grid grid-rows-2 gap-4">
              {/* 选择模板 — 仅模板模式显示 */}
              {mixMode === 'template' ? (
                <div className="min-h-0 flex flex-col">
                  <h3 className="text-sm font-bold text-slate-700 mb-2 flex-shrink-0">🎬 选择模板</h3>
                  <div className="flex-1 min-h-0 overflow-y-auto custom-scroll">
                    <TemplatePicker
                      selectedId={selectedTemplate?.id || ''}
                      onSelect={tpl => { setSelectedTemplate(tpl); setFillResult(null); }}
                    />
                  </div>
                </div>
              ) : (
                <div className="bg-sky-50 rounded-xl border border-sky-100 p-4 flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-2xl mb-2">🎬</p>
                    <p className="text-xs font-semibold text-sky-700">AI 智能图文混剪</p>
                    <p className="text-[10px] text-sky-500 mt-1">AI 自动分析素材，智能匹配脚本生成混剪视频</p>
                  </div>
                </div>
              )}

              {/* 选择素材 */}
              <div className="min-h-0 flex flex-col">
                <h3 className="text-sm font-bold text-slate-700 mb-2 flex-shrink-0">📁 选择素材（{mediaList.length} 个）</h3>
                <div className="flex-1 min-h-0 overflow-y-auto custom-scroll">
                  <div className="flex flex-wrap gap-2">
                    {mediaList.map((url, i) => (
                      <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200">
                        {url.match(/\.(mp4|mov|webm|avi)/i)
                          ? <video src={url} className="w-full h-full object-cover" />
                          : <img src={url} className="w-full h-full object-cover" />}
                        <button onClick={() => handleRemoveMedia(i)}
                          className="absolute top-0 right-0 w-5 h-5 bg-red-500 text-white rounded-full text-[10px] flex items-center justify-center">×</button>
                      </div>
                    ))}
                    <button onClick={() => setAssetPickerOpen(true)}
                      className="w-16 h-16 rounded-lg border-2 border-dashed border-slate-200 flex items-center justify-center text-slate-300 hover:border-sky-300 hover:text-sky-400 transition-colors text-2xl">+</button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ====== 右侧：配置 + 提交 ====== */}
      <div className="space-y-4 overflow-y-auto custom-scroll">
        {/* 智能混剪模式 */}
        {mixMode === 'smartmix' && (
          <>
            <div className="bg-white rounded-2xl border border-sky-200 p-4 shadow-sm space-y-3">
              <p className="text-xs font-semibold text-sky-600">🎬 AI 智能图文混剪</p>
              <p className="text-[11px] text-slate-500 leading-relaxed">AI 自动分析素材语义，根据口播文案智能匹配最佳画面片段，自动添加转场和特效</p>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">🎤 口播音色</label>
                <select value={selectedVoiceId} onChange={e => setSelectedVoiceId(e.target.value)}
                  className="w-full px-2 py-1.5 border rounded-lg text-[11px]">
                  <optgroup label="🌟 推荐女声">
                    <option value="longhua_v3">龙华 - 元气女声</option>
                    <option value="longwan_v3">龙婉 - 温柔女声</option>
                    <option value="longxiaochun_v3">龙小淳 - 知性女声</option>
                    <option value="longyan_v3">龙颜 - 温暖女声</option>
                    <option value="longxing_v3">龙星 - 邻家女声</option>
                    <option value="loongbella_v3">Bella - 新闻女声</option>
                  </optgroup>
                  <optgroup label="🎙 直播带货">
                    <option value="longanxuan_v3">龙安宣 - 经典直播</option>
                    <option value="longanran">龙安然 - 活泼质感</option>
                  </optgroup>
                  <optgroup label="👨 男声">
                    <option value="zhichu">知厨 - 舌尖男声</option>
                    <option value="longfeifei_v3">龙飞飞 - 磁性男声</option>
                  </optgroup>
                  <optgroup label="🌙 有声书/旁白">
                    <option value="longshu_v3">龙书 - 新闻男声</option>
                    <option value="longjing_v3">龙静 - 沉稳女声</option>
                    <option value="longhuhu_v3">龙呼呼 - 天真童声</option>
                  </optgroup>
                </select>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">AI 自动分析素材语义，根据口播文案智能匹配最佳画面片段，自动添加转场和特效</p>
              <div className="flex flex-wrap gap-1.5 text-[10px]">
                {['AI拆条', '智能匹配', '自动转场', '特效滤镜'].map(f => (
                  <span key={f} className="px-1.5 py-0.5 bg-green-50 text-green-600 rounded-full">✅ {f}</span>
                ))}
              </div>
            </div>
            <button onClick={handleSmartMixSubmit} disabled={!ready || submitting}
              className="w-full py-3 bg-gradient-to-r from-sky-500 to-blue-500 text-white rounded-xl text-sm font-bold shadow-md disabled:opacity-50">
              {submitting ? '⏳ 提交中...' : '🎬 开始智能混剪'}
            </button>
          </>
        )}

        {/* 模板成片模式 */}
        {mixMode === 'template' && (<>
        {/* 已选模板信息 */}
        {selectedTemplate && (
          <div className="bg-white rounded-2xl border border-sky-200 p-4 shadow-sm">
            <p className="text-xs font-semibold text-sky-600 mb-1">📐 已选模板</p>
            <p className="text-sm font-bold text-slate-700">{selectedTemplate.name}</p>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded">🎬 {selectedTemplate.mediaCount} 素材位</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-violet-50 text-violet-600 rounded">📝 {selectedTemplate.textCount} 文字位</span>
            </div>
          </div>
        )}

        {/* AI 填充配置预览 */}
        {fillResult && (
          <div className="bg-white rounded-2xl border border-violet-200 p-4 shadow-sm space-y-2">
            <p className="text-xs font-semibold text-violet-600">🤖 AI 配置预览</p>
            {fillResult.textSlots.map((slot: string) => (
              <div key={slot} className="text-[11px]">
                <span className="text-slate-400 font-mono">{slot}: </span>
                <input value={fillResult.clipsParam[slot] || ''}
                  onChange={e => setFillResult({ ...fillResult, clipsParam: { ...fillResult.clipsParam, [slot]: e.target.value } })}
                  className="px-2 py-1 border rounded text-[11px] w-full mt-0.5" />
              </div>
            ))}
          </div>
        )}

        <button onClick={handleAIFill} disabled={!ready || submitting}
          className="w-full py-2.5 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl text-sm font-bold shadow-md disabled:opacity-50">
          🤖 AI 填充配置
        </button>
        <button onClick={handleSubmit} disabled={!fillResult || submitting}
          className="w-full py-3 bg-gradient-to-r from-sky-500 to-blue-500 text-white rounded-xl text-sm font-bold shadow-md disabled:opacity-50">
          {submitting ? '⏳ 提交中...' : '🎬 提交模板成片'}
        </button>
        </>)}

        {/* 合成记录 */}
        {jobs.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-400">📦 合成记录</p>
              <button onClick={loadJobs} className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-lg hover:bg-slate-200">🔄 刷新</button>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scroll">
              {jobs.map((j: any) => (
                <div key={j.id} className="p-2.5 bg-slate-50 rounded-xl text-[10px]">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`font-medium ${j.status === 'completed' ? 'text-emerald-600' : j.status === 'failed' ? 'text-red-500' : 'text-amber-600'}`}>
                      {j.status === 'completed' ? '✅' : j.status === 'failed' ? '❌' : '⏳'}
                      {' '}{(j.inputParams?.script || '模板快剪').slice(0, 26)}
                    </span>
                  </div>
                  <p className="text-[9px] text-slate-400 mb-1">{j.createdAt ? new Date(j.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</p>
                  {j.outputUrl && <a href={j.outputUrl} target="_blank" className="text-sky-500 block truncate hover:text-sky-700">📥 下载视频</a>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AssetPicker open={assetPickerOpen} onClose={() => setAssetPickerOpen(false)} type="all" multi
        onSelect={assets => { setMediaList(p => [...p, ...assets.map(a => a.url)]); }} />
      <ToastContainer />
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );
}
