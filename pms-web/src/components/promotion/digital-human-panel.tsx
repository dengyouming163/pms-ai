'use client';
import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { API_BASE } from '@/lib/constants';
import { AssetPicker } from './asset-picker';
import { showToast, ToastContainer } from './toast';
import { SUBTITLE_PRESETS } from '@/lib/subtitle-presets';

interface PlanItem { id: string; title: string; script: string; createdAt: string; }
interface ParsedPlan { title: string; script: string; tags: string[]; }
interface VideoTask {
  id: string; status: string; type: string; outputUrl?: string;
  pipeline?: any; inputParams?: any; createdAt: string;
}

function parsePlan(markdown: string): ParsedPlan {
  let title = ''; let script = '';
  const tags = [...new Set((markdown.match(/#\S+/g) || []).map(t => t.replace(/^#/, '').trim()).filter(Boolean))];

  // 1. 优先从 JSON 结构化数据中提取
  const jsonMatch = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      title = data.title || data.shortTitle || '';
      // 拼接所有镜头的口播为完整文案
      script = (data.shots || []).map((s:any) => s.script).join('<break time="500ms"/> ');
    } catch {}
  }

  // 2. 兜底：正则提取旧格式
  if (!script) {
    const content = markdown.replace(/^标题[：:].+/, '').trim();
    const hasH2 = /^## /m.test(content);
    const p = hasH2 ? '## ' : '';
    const rawTitle = new RegExp(`${p}📋[^\\n]*\\n([^\\n]+)`).exec(content)?.[1]?.trim() || '';
    if (!title) title = rawTitle.replace(/^标题[：:]\s*/, '').replace(/\*\*/g, '').trim();
    script = new RegExp(`${p}🎙️[^\\n]*\\n([\\s\\S]*?)(?=${p}✅|${p}📊|$)`).exec(content)?.[1]?.trim() || '';

    // 3. 再兜底：分镜格式拼接
    if (!script) {
      const shots: string[] = [];
      const shotRegex = /口播[：:]\s*\*{0,2}([\s\S]+?)(?=\n\*{0,2}镜头|\n###|\n---|\n📍|\n🏷|\n⏰|$)/g;
      let m;
      while ((m = shotRegex.exec(content)) !== null) {
        shots.push(m[1].trim());
      }
      script = shots.join('<break time="500ms"/> ');
    }
  }

  if (!title) title = '未命名方案';
  return { title, script, tags };
}

const SYSTEM_VOICES: Array<{ group: string; voices: Array<{ id: string; name: string }> }> = [
  { group: '女声', voices: [
    { id: 'longxiaochun_v3', name: '龙小淳 - 知性女声' },
    { id: 'longwan_v3', name: '龙婉 - 温柔女声' },
    { id: 'longhua_v3', name: '龙华 - 元气女声' },
    { id: 'longxing_v3', name: '龙星 - 邻家女声' },
  ]},
  { group: '男声', voices: [
    { id: 'longzhinuo_v3', name: '龙之诺 - 沉稳男声' },
    { id: 'longzhilun_v3', name: '龙之伦 - 磁性男声' },
  ]},
];

export function DigitalHumanPanel() {
  // 方案
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanItem | null>(null);
  const [parsed, setParsed] = useState<ParsedPlan | null>(null);

  // 视频
  const [videoUrl, setVideoUrl] = useState('');
  const [videoUploading, setVideoUploading] = useState(false);

  // 音频（TTS 合成）
  const [audioUrl, setAudioUrl] = useState('');
  const [ttsLoading, setTtsLoading] = useState(false);

  // 音色（TTS模式）
  const [voices, setVoices] = useState<any[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [scriptText, setScriptText] = useState('');
  const [speechRate, setSpeechRate] = useState(1.0);

  // 字幕
  const [addSubtitle, setAddSubtitle] = useState(false);
  const [subPreset, setSubPreset] = useState('clean-white');
  const [subFontSize, setSubFontSize] = useState(48);

  // 提交 & 任务
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<VideoTask[]>([]);

  // 素材库
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetPickerType, setAssetPickerType] = useState<'video' | 'audio'>('video');

  // 加载方案
  useEffect(() => {
    apiGet('/api/creation-records?type=copy&limit=30').then((d: any) => {
      if (d.success) setPlans(d.data || []);
    }).catch(() => {});
  }, []);

  // 加载音色（仅 TTS 兼容：系统音色 + 百炼克隆。IMS 自定义音色不支持 TTS）
  useEffect(() => {
    apiGet('/api/voice/list').then((d: any) => {
      const ttsVoices = (d.data || []).filter((v: any) =>
        v.status === 'ready' && v.source !== 'ims' && /^(long|zhi|loong|qwen-tts|cosyvoice)/i.test(v.aliyunVoiceId || '')
      );
      setVoices(ttsVoices);
      if (ttsVoices.length > 0) {
        const def = ttsVoices.find((v: any) => v.isDefault) || ttsVoices[0];
        setSelectedVoiceId(def.aliyunVoiceId);
      }
    }).catch(() => {});
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const d = await apiGet('/api/video/tasks?type=digital_human&limit=20');
      if (d.success) {
        const list = d.data || [];
        const updated = await Promise.all(list.map(async (j: VideoTask) => {
          if (j.status === 'processing') {
            try {
              const s = await apiGet(`/api/video/tasks/${j.id}`);
              if (s.success) return { ...j, ...s.data };
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
    setScriptText(p.script);
  };

  // 视频格式校验在服务端完成（浏览器端因 OSS 跨域限制无法做 HEAD 预检）

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setVideoUploading(true);
    const fd = new FormData(); fd.append('file', file);
    const token = localStorage.getItem('pms_auth_token') || '';
    try {
      const r = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: fd, headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const d = await r.json();
      if (d.success) { setVideoUrl(d.url); }
    } catch {}
    setVideoUploading(false);
    e.target.value = '';
  };

    // 步骤1：TTS 合成音频
  const handleTTS = async () => {
    if (!scriptText || !selectedVoiceId) { showToast('请填写文案和选择音色', 'error'); return; }
    setTtsLoading(true);
    try {
      const d = await apiPost('/api/video/digital-human/tts', { script: scriptText, voiceId: selectedVoiceId, speechRate });
      if (d.success && d.data.audioUrl) {
        setAudioUrl(d.data.audioUrl);
        showToast('✅ 音频合成完成', 'success');
      } else showToast('合成失败: ' + (d.error || '未知'), 'error');
    } catch { showToast('请求失败', 'error'); }
    setTtsLoading(false);
  };

  // 步骤2：提交口型同步
  const handleSubmit = async () => {
    if (!videoUrl) { showToast('请上传口播视频', 'error'); return; }
    if (!audioUrl) { showToast('请先合成音频', 'error'); return; }
    setSubmitting(true);
    try {
      const d = await apiPost('/api/video/digital-human', {
        videoUrl, audioUrl, addSubtitle, script: scriptText,
        subtitleConfig: addSubtitle ? { fontSize: subFontSize } : undefined,
        title: parsed?.title || '',
      });
      if (d.success) { loadJobs(); showToast('已提交!', 'success'); }
      else showToast('失败: ' + (d.error || '未知'), 'error');
    } catch { showToast('请求失败', 'error'); }
    setSubmitting(false);
  };

  return (
    <div className="grid grid-cols-[200px_1fr_260px] gap-4 h-full">
      {/* 左栏：方案列表 */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm overflow-y-auto custom-scroll">
        <p className="text-xs font-semibold text-slate-400 mb-2">📋 创作方案 ({plans.filter(p => p.script).length})</p>
        <div className="space-y-1">
          {plans.filter(p => p.script).map(p => (
            <button key={p.id} onClick={() => handleSelectPlan(p)}
              className={`w-full text-left p-2.5 rounded-xl transition-all text-xs ${selectedPlan?.id === p.id ? 'bg-purple-50 border border-purple-200' : 'hover:bg-slate-50 border border-transparent'}`}>
              <p className="font-medium text-slate-700 truncate">{p.title || '未命名'}</p>
              <p className="text-[10px] text-slate-400 mt-0.5">{p.script.slice(0, 40)}...</p>
            </button>
          ))}
          {plans.length === 0 && <p className="text-xs text-slate-400 text-center py-8">暂无方案</p>}
        </div>
      </div>

      {/* 中栏：视频 + 文案 */}
      <div className="overflow-y-auto custom-scroll space-y-4 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        {/* 视频上传 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
          <h3 className="text-sm font-bold text-slate-700 mb-3">📹 口播视频</h3>
          <p className="text-[11px] text-slate-400 mb-3">上传人物正面出镜的近景视频（mp4, 640-2048px, 2-120s, ≤300MB）</p>

          {videoUrl ? (
            <div className="relative rounded-xl overflow-hidden border border-purple-200 mb-2">
              <video src={videoUrl} className="w-full max-h-64 object-contain bg-black" controls />
              <button onClick={() => setVideoUrl('')}
                className="absolute top-2 right-2 w-6 h-6 bg-red-500 text-white rounded-full text-xs flex items-center justify-center">×</button>
            </div>
          ) : (
            <label className="block w-full py-10 border-2 border-dashed border-slate-200 rounded-xl text-center cursor-pointer hover:border-purple-300 hover:bg-purple-50/50 transition-colors mb-2">
              <input type="file" accept="video/*" className="hidden" onChange={handleVideoUpload} />
              <p className="text-2xl mb-1">📹</p>
              <p className="text-xs text-slate-500">{videoUploading ? '上传中...' : '点击上传视频'}</p>
            </label>
          )}

          <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)}
            placeholder="或粘贴视频 URL..." className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs" />

        </div>

        {/* 口播文案 */}
        {!parsed ? (
          <div className="text-center text-slate-400 text-sm py-8">从左侧选择方案，或直接粘贴口播文案</div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h3 className="text-sm font-bold text-slate-700 mb-2">📋 {parsed.title || '方案详情'}</h3>
            <div className="text-xs text-slate-500 space-y-1">
              <div className="flex items-start gap-1"><span className="flex-shrink-0">🎙️</span><span className="text-slate-500">{parsed.script.slice(0, 80)}...</span></div>
              <textarea value={scriptText} onChange={e => setScriptText(e.target.value)}
                className="w-full p-3 border border-slate-200 rounded-xl text-xs h-24 resize-none mt-2 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                placeholder="口播文案（可编辑）" />
              {parsed.tags.length > 0 && <div className="flex items-start gap-1"><span>🏷️</span><span>{parsed.tags.join(' · ')}</span></div>}
            </div>
          </div>
        )}
      </div>

      {/* 右栏：配置 */}
      <div className="space-y-4 overflow-y-auto custom-scroll">
        {/* 音频模式 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-3">
          <h3 className="text-xs font-semibold text-slate-400">🔊 音频</h3>
          <div>
            <label className="text-[10px] text-slate-400 block mb-1">🎤 音色</label>
            <select value={selectedVoiceId} onChange={e => setSelectedVoiceId(e.target.value)}
              className="w-full px-3 py-2 border rounded-xl text-sm">
              <option value="">选择音色</option>
              {voices.length > 0 && (
                <optgroup label="🎤 我的音色">
                  {voices.map((v: any) => <option key={v.id} value={v.aliyunVoiceId}>{v.name}{v.isDefault ? ' · 默认' : ''}</option>)}
                </optgroup>
              )}
              {SYSTEM_VOICES.map(g => (
                <optgroup key={g.group} label={g.group}>
                  {g.voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </optgroup>
              ))}
            </select>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-[10px] text-slate-400 flex-shrink-0">语速 {speechRate.toFixed(1)}x</label>
              <input type="range" min="0.8" max="1.2" step="0.05" value={speechRate}
                onChange={e => setSpeechRate(Number(e.target.value))}
                className="flex-1 accent-purple-500 h-4" />
            </div>
          </div>
          <button onClick={handleTTS} disabled={ttsLoading || !scriptText || !selectedVoiceId}
            className="w-full py-2.5 bg-gradient-to-r from-purple-500 to-violet-500 text-white rounded-xl text-xs font-bold shadow-md disabled:opacity-50">
            {ttsLoading ? '⏳ 合成中...' : '🎙️ 合成音频'}
          </button>
          {audioUrl && <audio controls src={audioUrl} className="w-full h-8 mt-2" />}
        </div>

        {/* 字幕 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-400">🎨 字幕</label>
            <button onClick={() => setAddSubtitle(!addSubtitle)}
              className={`text-[11px] px-3 py-1 rounded-lg ${addSubtitle ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-400'}`}>
              {addSubtitle ? '开' : '关'}
            </button>
          </div>
          {addSubtitle && (
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">字号: {subFontSize}px</label>
              <input type="range" min="32" max="72" step="2" value={subFontSize}
                onChange={e => setSubFontSize(Number(e.target.value))} className="w-full accent-purple-500" />
            </div>
          )}
        </div>

        {/* 提交 */}
        <button onClick={handleSubmit} disabled={submitting || !videoUrl}
          className="w-full py-3 bg-gradient-to-r from-purple-500 to-violet-500 text-white rounded-xl text-sm font-bold shadow-md disabled:opacity-50 hover:shadow-lg">
          {submitting ? '⏳ 提交中...' : '🎭 生成数字人视频'}
        </button>

        {parsed && (
          <div className="text-[10px] text-slate-400 px-1 space-y-0.5">
            <div>视频: {videoUrl ? '✅' : '❌'}</div>
            <div>音频: {audioUrl ? '✅' : '❌'}</div>
          </div>
        )}

        {/* 任务记录 */}
        {jobs.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-400">📦 合成记录</p>
              <button onClick={loadJobs} className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-lg hover:bg-slate-200">🔄</button>
            </div>
            <div className="space-y-1.5 max-h-96 overflow-y-auto custom-scroll">
              {jobs.map(j => {
                const pipeline = j.pipeline || {};
                const stageLabel = pipeline.stage === 'videoretalk' ? '口型同步中' :
                  pipeline.stage === 'subtitle' ? '字幕合成中' :
                  j.status === 'completed' ? '已完成' : j.status === 'failed' ? '失败' : '处理中';
                return (
                  <div key={j.id} className="p-2.5 bg-slate-50 rounded-xl text-[10px]">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`font-medium ${j.status === 'completed' ? 'text-emerald-600' : j.status === 'failed' ? 'text-red-500' : 'text-amber-600'}`}>
                        {j.status === 'completed' ? '✅' : j.status === 'failed' ? '❌' : '⏳'} {stageLabel}
                      </span>
                    </div>
                    {(j.inputParams?.title) && <p className="text-[9px] text-slate-600 font-medium truncate mb-0.5">{j.inputParams.title}</p>}
                    <p className="text-[9px] text-slate-400 mb-1">
                      {j.createdAt ? new Date(j.createdAt).toLocaleString('zh-CN', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''}
                    </p>
                    {j.outputUrl && <a href={j.outputUrl} target="_blank" className="text-sky-500 block truncate hover:text-sky-700">📥 下载</a>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <AssetPicker open={assetPickerOpen} onClose={() => setAssetPickerOpen(false)}
        type={assetPickerType} multi={false}
        onSelect={(assets) => {
          if (assets.length > 0) {
            if (assetPickerType === 'video') { setVideoUrl(assets[0].url); }
            else setAudioUrl(assets[0].url);
          }
          setAssetPickerOpen(false);
        }} />
      <ToastContainer />
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );
}
