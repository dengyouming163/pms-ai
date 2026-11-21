'use client';
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { AssetPicker } from './asset-picker';
import { showToast, ToastContainer } from './toast';
import { SUBTITLE_PRESETS } from '@/lib/subtitle-presets';

interface PlanItem { id: string; title: string; script: string; createdAt: string; }
interface VoiceItem { id: string; name: string; aliyunVoiceId: string; status: string; isDefault?: boolean; source?: string; }
interface BatchJob { id: string; status: string; outputUrls?: string[]; createdAt: string; script?: string; }

interface ParsedShot {
  index: number;
  label: string;
  script: string;
  duration: number;
  cameraHint: string;
  media: string[];
}

interface ParsedPlan {
  title: string;
  shots: ParsedShot[];
  fullScript: string;
}

function parsePlan(markdown: string): ParsedPlan {
  const content = markdown.replace(/^标题[：:].+/, '').trim();

  // 提取标题
  const titleMatch = content.match(/标题[：:]\s*(.+)/);
  let title = titleMatch?.[1]?.trim() || '未命名方案';

  const shots: ParsedShot[] = [];

  // 优先解析 AI 生成的结构化 JSON
  const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      if (data.shots?.length > 0) {
        data.shots.forEach((s: any) => shots.push({
          index: s.index, label: s.label || '', duration: s.duration || 5,
          cameraHint: s.cameraHint || '', script: s.script || '', media: [],
        }));
      }
      if (data.title) title = data.title;
    } catch {}
  }

  // 兜底：正则解析分镜脚本（兼容 **粗体** 标记）
  if (shots.length === 0) {
    const shotRegex = /###\s*镜(\d+)\s*\|\s*([^|]+?)\s*\|\s*⏱(\d+)秒\s*\n\*{0,2}镜头[：:]\*{0,2}\s*([\s\S]+?)\n\*{0,2}口播[：:]\*{0,2}\s*([\s\S]+?)(?=\n###|\n##|\n---|\n\*{0,2}📍|\n\*{0,2}🏷|\n\*{0,2}⏰|\n*$)/g;
    let match;
    while ((match = shotRegex.exec(content)) !== null) {
      shots.push({
        index: parseInt(match[1]), label: match[2].trim(), duration: parseInt(match[3]),
        cameraHint: match[4].trim(), script: match[5].trim(), media: [],
      });
    }
  }

  const fullScript = shots.map(s => s.script).join('<break time="500ms"/> ');
  return { title, shots, fullScript };
}

export function BatchPanel() {
  const sp = useSearchParams();
  const planIdParam = sp.get('planId');

  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanItem | null>(null);
  const [parsed, setParsed] = useState<ParsedPlan | null>(null);
  const [voices, setVoices] = useState<VoiceItem[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [shots, setShots] = useState<ParsedShot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetTargetStep, setAssetTargetStep] = useState(0);
  const [bgmStyle, setBgmStyle] = useState('');
  const [orientation, setOrientation] = useState('portrait');
  const [showSubtitle, setShowSubtitle] = useState(true);
  // SpeechRate 在 SubmitBatchMediaProducingJob 中不生效，已移除
  const [subtitleConfig, setSubtitleConfig] = useState({ font: 'Alibaba PuHuiTi', fontSize: 48, fontColor: '#FFFFFF', outlineColor: '#000000' });
  const [subPreset, setSubPreset] = useState('');

  useEffect(() => {
    apiGet('/api/creation-records?type=copy&limit=30').then((d: any) => {
      if (d.success) {
        setPlans(d.data || []);
        if (planIdParam) {
          const found = (d.data || []).find((p: PlanItem) => p.id === planIdParam);
          if (found) handleSelectPlan(found);
        }
      }
    }).catch(() => {});
  }, [planIdParam]);

  useEffect(() => {
    apiGet('/api/voice/list').then((d: any) => {
      setVoices((d.data || []).filter((v: VoiceItem) => v.status === 'ready' && v.source === 'ims'));
    }).catch(() => {});
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const d = await apiGet('/api/video/batch-jobs');
      if (d.success) {
        const list = d.data || [];
        // 对处理中的任务查询阿里云最新状态
        const updated = await Promise.all(list.map(async (j: BatchJob) => {
          if (j.status === 'processing') {
            try {
              const s = await apiGet(`/api/video/batch-status/${j.id}`);
              if (s.success) return { ...j, status: s.data.status, outputUrls: s.data.outputUrls || j.outputUrls };
            } catch {}
          }
          return j;
        }));
        setJobs(updated);
      }
    } catch {}
  }, []);
  useEffect(() => { loadJobs(); const i = setInterval(loadJobs, 10000); return () => clearInterval(i); }, [loadJobs]);

  const handleSelectPlan = (plan: PlanItem) => {
    setSelectedPlan(plan);
    const p = parsePlan(plan.script);
    setParsed(p);
    setShots(p.shots.map(s => ({ ...s, media: [] as string[] })));
  };

  const handleAssetSelect = (assets: Array<{ url: string }>) => {
    const urls = assets.map(a => a.url);
    setShots(prev => prev.map(s => s.index === assetTargetStep
      ? { ...s, media: [...(s.media || []), ...urls] }
      : s
    ));
  };

  const handleSubmit = async () => {
    if (!parsed || !selectedVoiceId || shots.some(s => !s.media || s.media.length === 0)) {
      showToast('请完善所有镜头的素材', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const d = await apiPost('/api/video/batch-submit', {
        voiceId: selectedVoiceId,
        shots: shots.map(s => ({
          index: s.index,
          media: s.media,
          script: s.script,
          duration: s.duration,
          label: s.label,
        })),
        bgmStyle,
        orientation,
        showSubtitle,
        subtitleConfig,
      });
      if (d.success) { loadJobs(); showToast('已提交!', 'success'); }
      else showToast('提交失败: ' + (d.error || '未知错误'), 'error');
    } catch { showToast('请求失败', 'error'); }
    setSubmitting(false);
  };

  return (
    <div className="grid grid-cols-[200px_1fr_260px] gap-4 h-full">
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm overflow-y-auto custom-scroll flex flex-col">
        <p className="text-xs font-semibold text-slate-400 mb-2 flex-shrink-0">📋 创作方案 ({plans.filter(p => p.script).length})</p>
        <div className="space-y-1">
          {plans.filter(p => p.script).map(p => (
            <button key={p.id} onClick={() => handleSelectPlan(p)}
              className={`w-full text-left p-2.5 rounded-xl text-sm ${selectedPlan?.id === p.id ? 'bg-amber-50 border border-amber-200' : 'hover:bg-slate-50 border border-transparent'}`}>
              <p className="font-semibold text-slate-700 truncate">{p.title || '未命名'}</p>
              <p className="text-xs text-slate-400 mt-0.5">{p.script.slice(0, 50)}...</p>
            </button>
          ))}
          {plans.length === 0 && <p className="text-xs text-slate-400 text-center py-8">暂无方案，请先在创作中心生成并保存</p>}
        </div>
      </div>

      <div className="overflow-y-auto custom-scroll space-y-4 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        {!parsed ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-300 gap-3 py-12">
            <div className="text-6xl">🎬</div>
            <p className="text-sm font-medium">从左侧选择创作方案开始</p>
            <p className="text-xs text-slate-300">AI 会自动解析分镜脚本</p>
          </div>
        ) : parsed.shots.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3 py-12">
            <div className="text-5xl">⚠️</div>
            <p className="text-sm font-medium text-slate-500">无法解析此方案</p>
            <p className="text-xs text-slate-400">该方案为旧版格式，请在 AI 创作中心重新生成</p>
            <button onClick={() => window.open('/ai-workspace/promotion', '_blank')}
              className="mt-2 px-4 py-2 bg-sky-50 text-sky-600 rounded-xl text-xs font-medium hover:bg-sky-100">
              → 去 AI 创作中心
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-700">🎬 {parsed.title}</h3>
              <span className="text-xs text-slate-400">{parsed.shots.length} 镜 · {parsed.shots.reduce((s:number, sh:any) => s + (sh.duration||5), 0)}秒</span>
            </div>

            {shots.map((shot) => (
              <div key={shot.index} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-bold text-violet-600 bg-violet-50 px-2 py-1 rounded-lg">镜{shot.index}</span>
                  <span className="text-sm font-medium text-slate-700">{shot.label}</span>
                  <span className="text-[10px] text-slate-400">{shot.cameraHint?.slice(0, 30)}...</span>
                  <div className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-400">
                    <span>⏱</span>
                    <input type="number" value={shot.duration} min={2} max={15}
                      onChange={e => setShots(prev => prev.map(s => s.index === shot.index ? { ...s, duration: Number(e.target.value) } : s))}
                      className="w-12 px-1.5 py-0.5 border rounded text-center text-xs" />
                    <span>秒</span>
                  </div>
                </div>

                {/* 口播文案 */}
                <div className="mb-3">
                  <textarea value={shot.script}
                    onChange={e => setShots(prev => prev.map(s => s.index === shot.index ? { ...s, script: e.target.value } : s))}
                    className="w-full p-2 border border-slate-200 rounded-lg text-xs h-14 resize-none focus:outline-none focus:ring-1 focus:ring-violet-300" />
                </div>

                {/* 素材 */}
                {shot.media && shot.media.length > 0 && (
                  <div className="flex gap-2 mb-2 flex-wrap">
                    {shot.media.map((url: string, j: number) => (
                      <div key={j} className="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-200">
                        {url.match(/\.(mp4|mov|webm)/i)
                          ? <video src={url} className="w-full h-full object-cover" />
                          : <img src={url} className="w-full h-full object-cover" />}
                        <button onClick={() => setShots(prev => prev.map(s => s.index === shot.index ? { ...s, media: s.media.filter((_:string, k:number) => k !== j) } : s))}
                          className="absolute top-0 right-0 w-4 h-4 bg-red-500 text-white rounded-full text-[8px] flex items-center justify-center">×</button>
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={() => { setAssetTargetStep(shot.index); setAssetPickerOpen(true); }}
                  className="text-[11px] px-3 py-1.5 bg-violet-50 border border-violet-200 text-violet-700 rounded-lg hover:bg-violet-100">
                  + 素材
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="space-y-4 overflow-y-auto custom-scroll">
        {/* 音色选择 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-2">🎤 音色</label>
            <select value={selectedVoiceId} onChange={e => setSelectedVoiceId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm">
              <option value="">请选择音色</option>
              {voices.length > 0 && (
                <optgroup label="🎤 我的音色">
                  {voices.map((v: any) => (
                    <option key={v.id} value={v.aliyunVoiceId}>{v.name}{v.isDefault ? ' · 默认' : ''}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="🌟 系统音色">
                <option value="longhua_v3">龙华 - 元气女声</option>
                <option value="longxiaochun_v3">龙小淳 - 知性女声</option>
                <option value="longwan_v3">龙婉 - 温柔女声</option>
                <option value="loongbella_v3">Bella - 新闻女声</option>
              </optgroup>
              <optgroup label="👨 男声">
                <option value="longzhinuo_v3">龙之诺 - 沉稳男声</option>
                <option value="longzhilun_v3">龙之伦 - 磁性男声</option>
                <option value="longzhifeng_v3">龙之峰 - 阳光男声</option>
              </optgroup>
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-2">🎵 BGM</label>
            <select value={bgmStyle} onChange={e => setBgmStyle(e.target.value)}
              className="w-full px-2 py-1.5 border rounded-lg text-[11px]">
              <option value="">无</option>
              <option value="bgm-relaxing">轻松</option>
              <option value="bgm-dynamic">动感</option>
              <option value="bgm-beauty">时尚</option>
              <option value="bgm-chinese-style">中国风</option>
              <option value="bgm-romantic">浪漫</option>
              <option value="bgm-upbeat">欢快</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-2">📱 方向</label>
            <select value={orientation} onChange={e => setOrientation(e.target.value)}
              className="w-full px-2 py-1.5 border rounded-lg text-[11px]">
              <option value="portrait">竖屏 9:16</option>
              <option value="landscape">横屏 16:9</option>
            </select>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-400">🎨 字幕</label>
            <button onClick={() => setShowSubtitle(!showSubtitle)}
              className={`text-[11px] px-3 py-1 rounded-lg ${showSubtitle ? 'bg-violet-50 text-violet-600' : 'bg-slate-100 text-slate-400'}`}>
              {showSubtitle ? '开' : '关'}
            </button>
          </div>
          {showSubtitle && (
            <div className="space-y-2 pt-2 border-t border-slate-100">
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">预设风格</label>
                <select value={subPreset} onChange={e => {
                  setSubPreset(e.target.value);
                  if (!e.target.value) return;
                  const preset: any = SUBTITLE_PRESETS.find((p: any) => p.key === e.target.value);
                  if (preset) setSubtitleConfig(p => ({ ...p, font: preset.config?.Font || p.font, fontColor: preset.config?.FontColor || p.fontColor, outlineColor: preset.config?.OutlineColour || p.outlineColor }));
                }} className="w-full px-2 py-1 border rounded-lg text-[10px]">
                  <option value="">自定义</option>
                  {SUBTITLE_PRESETS.map((p: any) => (
                    <option key={p.key} value={p.key}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">字号: {subtitleConfig.fontSize}px</label>
                <input type="range" min="32" max="72" step="2" value={subtitleConfig.fontSize}
                  onChange={e => setSubtitleConfig(p => ({ ...p, fontSize: Number(e.target.value) }))}
                  className="w-full accent-violet-500" />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">颜色</label>
                <div className="flex gap-1.5">
                  {['#FFFFFF', '#FFD700', '#FF6B6B', '#00D2FF', '#FF8C00'].map(c => (
                    <button key={c} onClick={() => setSubtitleConfig(p => ({ ...p, fontColor: c }))}
                      className={`w-6 h-6 rounded-full border-2 ${subtitleConfig.fontColor === c ? 'border-violet-500 scale-110' : 'border-slate-200'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-slate-400 block mb-1">字体</label>
                <select value={subtitleConfig.font} onChange={e => setSubtitleConfig(p => ({ ...p, font: e.target.value }))}
                  className="w-full px-2 py-1 border rounded-lg text-[10px]">
                  <option value="Alibaba PuHuiTi">阿里普惠体（默认）</option>
                  <option value="SimSun">宋体</option>
                  <option value="KaiTi">楷体</option>
                  <option value="Microsoft YaHei">微软雅黑</option>
                </select>
              </div>
            </div>
          )}
        </div>

        <button onClick={handleSubmit} disabled={!parsed || !selectedVoiceId || shots.some(s => !s.media || s.media.length === 0) || submitting}
          className="w-full py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl text-sm font-bold shadow-md disabled:opacity-50">
          {submitting ? '⏳ 提交中...' : '🎞️ 开始合成'}
        </button>

        {jobs.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-400">📦 合成记录</p>
              <button onClick={loadJobs} className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-lg hover:bg-slate-200">🔄 刷新</button>
            </div>
            <div className="space-y-1.5 max-h-96 overflow-y-auto custom-scroll">
              {jobs.map(j => (
                <div key={j.id} className="p-2.5 bg-slate-50 rounded-xl text-[10px]">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`font-medium ${j.status === 'completed' ? 'text-emerald-600' : j.status === 'failed' ? 'text-red-500' : 'text-amber-600'}`}>
                      {j.status === 'completed' ? '✅' : j.status === 'failed' ? '❌' : '⏳'} {j.script?.slice(0, 26) || '一键成片'}
                    </span>
                  </div>
                  <p className="text-[9px] text-slate-400 mb-1">
                    {j.createdAt ? new Date(j.createdAt).toLocaleString('zh-CN', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''}
                  </p>
                  {j.outputUrls?.map((u, k) => <a key={k} href={u} target="_blank" className="text-sky-500 block truncate hover:text-sky-700">📥 视频{k + 1}</a>)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <AssetPicker
        open={assetPickerOpen}
        onClose={() => setAssetPickerOpen(false)}
        type="all" multi={true}
        onSelect={handleAssetSelect}
      />
      <ToastContainer />
    </div>
  );
}
