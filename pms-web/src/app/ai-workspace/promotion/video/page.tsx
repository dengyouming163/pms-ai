'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CreationStudio, ScriptVariant } from '@/components/promotion/creation-studio';
import { VoiceSelector } from '@/components/promotion/voice-selector';

type Mode = 'creation' | 'voiceover' | 'fastcut' | 'mediakit' | 'digital';
import { FastCutPanel } from '@/components/promotion/fastcut-panel';

import { MediaKitBatchPanel } from '@/components/promotion/mediakit-batch-panel';
import { DigitalHumanPanel } from '@/components/promotion/digital-human-panel';

interface HistoryItem {
  id: string;
  mode: Mode;
  title: string;
  script: string;
  time: string;
  tags?: string;
  titles?: string[];
  audioUrl?: string;
}

interface ModeCard {
  key: Mode;
  label: string;
  icon: string;
  activeBg: string;
}

const MODES: ModeCard[] = [
  { key: 'creation', label: 'AI 创作中心', icon: '✍️', activeBg: 'bg-gradient-to-r from-sky-50 to-blue-50 border-sky-300' },
  { key: 'mediakit', label: '一键成片', icon: '🎬', activeBg: 'bg-gradient-to-r from-amber-50 to-orange-50 border-amber-300' },
  { key: 'digital', label: '数字人口播', icon: '🎭', activeBg: 'bg-gradient-to-r from-purple-50 to-violet-50 border-purple-300' },
];

const HISTORY_KEY = 'pms_video_history';

async function loadHistoryAPI(type?: string): Promise<HistoryItem[]> {
  try {
    const token = localStorage.getItem('pms_auth_token') || '';
    const storeId = localStorage.getItem('currentStoreId') || '';
    const url = '/api/creation-records?limit=50' + (type ? `&type=${type}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Store-Id': storeId } });
    const data = await res.json();
    if (data.success) {
      let items = data.data || [];
      return items
        .filter((item: any) => item.script || item.title)
        .map((item: any) => ({
          ...item,
          script: (item.script || '').replace(/^> /gm, ''),
          titles: (item.titles || []).map((t: string) => t.replace(/^> /, '')),
        }));
    }
  } catch {}
  return [];
}

async function saveHistoryAPI(item: { type: string; title: string; script: string; tags?: string; titles?: string[]; audioUrl?: string }) {
  try {
    const token = localStorage.getItem('pms_auth_token') || '';
    const storeId = localStorage.getItem('currentStoreId') || '';
    await fetch('/api/creation-records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Store-Id': storeId },
      body: JSON.stringify(item),
    });
  } catch {}
}

export default function VideoPlatformPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('creation');
  const [scriptForFlow, setScriptForFlow] = useState<ScriptVariant | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [ttsAudioUrl, setTtsAudioUrl] = useState('');
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsSpeed, setTtsSpeed] = useState(1.0);
  const [ttsVolume, setTtsVolume] = useState(50);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [voiceScript, setVoiceScript] = useState('');

  // 快剪状态
  const [fcAudioItem, setFcAudioItem] = useState<HistoryItem | null>(null);
  const [fcImages, setFcImages] = useState<string[]>([]);
  const [fcGenerating, setFcGenerating] = useState(false);
  const [fcResult, setFcResult] = useState('');
  const [fcUploading, setFcUploading] = useState(false);
  const [fcUploadMsg, setFcUploadMsg] = useState('');
  const [fcOrientation, setFcOrientation] = useState('portrait');
  const [fcSubtitles, setFcSubtitles] = useState(true);
  const fcFileRef = useRef<HTMLInputElement>(null);

  // @deprecated — 已迁移到 DigitalHumanPanel 组件
  // 数字人状态
  const [dhAudioItem, setDhAudioItem] = useState<HistoryItem | null>(null);
  const [dhVideoUrl, setDhVideoUrl] = useState('');
  const [dhGenerating, setDhGenerating] = useState(false);
  const [dhResult, setDhResult] = useState('');
  const [dhUploading, setDhUploading] = useState(false);
  const dhFileRef = useRef<HTMLInputElement>(null);

  const audioHistory = history.filter(h => h.audioUrl);

  useEffect(() => { loadHistoryAPI().then(setHistory); }, []);

  const addToHistory = async (m: Mode, script: ScriptVariant, audioUrl?: string) => {
    const type = audioUrl ? 'video' : 'copy';
    const item: HistoryItem = {
      id: Date.now().toString(36), mode: m,
      title: script.titles?.[0] || script.script.slice(0, 30),
      script: script.script,
      time: new Date().toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      tags: script.tags, titles: script.titles,
      audioUrl: audioUrl && !audioUrl.startsWith('blob:') ? audioUrl : (audioUrl ? '已配音' : undefined),
    };
    await saveHistoryAPI({ type, title: item.title, script: item.script, tags: item.tags, titles: item.titles, audioUrl: item.audioUrl });
    const updated = [item, ...history];
    setHistory(updated);
    return item;
  };

  const handleFlow = (target: string, script: ScriptVariant) => {
    setScriptForFlow(script);
    setVoiceScript(script.script);
    addToHistory('creation', script);
    if (target === 'voiceover') setMode('voiceover');
    else if (target === 'fastcut') setMode('fastcut');
    else if (target === 'digital') setMode('digital');
    else if (target === 'xhs') {
      const token = localStorage.getItem('pms_auth_token');
      fetch(`${API_BASE}/api/xhs/drafts`, {
        method: 'POST',
        headers: token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: script.titles?.[0] || '', content: script.script, tags: script.tags?.split(/[#\s]+/).filter(Boolean) || [] }),
      }).then(() => toast.success('已转存到小红书草稿箱')).catch(() => toast.error('转存失败'));
    }
  };

  const API_BASE = '';

  const handleTTS = async () => {
    const text = voiceScript || scriptForFlow?.script || '';
    if (!text || ttsLoading) return;
    if (!selectedVoiceId) { toast.warning('请先在声音中台创建一个音色'); return; }
    setTtsLoading(true);
    const token = localStorage.getItem('pms_auth_token');
    const storeId = localStorage.getItem('currentStoreId') || '';
    try {
      const res = await fetch(`${API_BASE}/api/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Store-Id': storeId },
        body: JSON.stringify({ voiceId: selectedVoiceId, text, speechRate: ttsSpeed, volume: ttsVolume }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setTtsAudioUrl(url);
        new Audio(url).play();
        const s: ScriptVariant = { script: text, shots: '', titles: [scriptForFlow?.titles?.[0] || text.slice(0, 20)], music: '', tags: scriptForFlow?.tags || '' };
        const item = await addToHistory('voiceover', s, url);
        setDhAudioItem(item); setFcAudioItem(item);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error('语音合成失败: ' + (err.error || '未知错误'));
      }
    } catch { toast.error('语音合成失败，请检查网络'); }
    setTtsLoading(false);
  };

  const handleLoadFromHistory = (item: HistoryItem) => {
    try {
      setScriptForFlow({ script: item.script || '', shots: '', titles: item.titles?.length ? item.titles : [item.title || ''], music: '', tags: item.tags || '' });
      setVoiceScript(item.script || '');
      if (item.audioUrl && item.audioUrl.startsWith('http')) setTtsAudioUrl(item.audioUrl);
      const validModes = MODES.map(m => m.key);
      setMode(validModes.includes(item.mode) ? item.mode : 'creation');
    } catch {}
  };

  // ====== 快剪提交 ======
  const handleFastCutSubmit = async () => {
    if (!fcAudioItem?.audioUrl || fcImages.length === 0) return;
    setFcGenerating(true);
    const token = localStorage.getItem('pms_auth_token');
    try {
      const res = await fetch(`${API_BASE}/api/video/fastcut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ images: fcImages, audioUrl: fcAudioItem.audioUrl, subtitles: [], outputKey: `fastcut_${Date.now()}.mp4` }),
      });
      const data = await res.json();
      if (data.success) {
        const taskId = data.data?.id || '';
        setFcResult(taskId);
        setFcGenerating(false);
        const outputUrl = data.data?.outputUrl || '';
        await saveHistoryAPI({ type: 'video', title: `快剪视频 ${new Date().toLocaleDateString()}`, script: fcAudioItem?.script || '', audioUrl: outputUrl || taskId });
        loadHistoryAPI().then(setHistory);
      } else { toast.error('提交失败: ' + (data.error || '未知错误')); setFcGenerating(false); }
    } catch { toast.error('请求失败'); setFcGenerating(false); }
  };

  // @deprecated — 已迁移到 DigitalHumanPanel 组件
  // ====== 数字人提交 ======
  const handleDigitalSubmit = async () => {
    if (!dhAudioItem?.audioUrl || !dhVideoUrl) return;
    setDhGenerating(true);
    const token = localStorage.getItem('pms_auth_token');
    try {
      const res = await fetch(`${API_BASE}/api/video/digital-human`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text: dhAudioItem.script, voiceId: '', faceImageUrl: dhVideoUrl }),
      });
      const data = await res.json();
      if (data.success) {
        const taskId = data.data?.id || '';
        setDhResult(taskId);
        setDhGenerating(false);
        const outputUrl = data.data?.outputUrl || '';
        await saveHistoryAPI({ type: 'video', title: `数字人视频 ${new Date().toLocaleDateString()}`, script: dhAudioItem?.script || '', audioUrl: outputUrl || taskId });
        loadHistoryAPI().then(setHistory);
      } else {
        toast.error('提交失败: ' + (data.message || data.note || '未知错误'));
        setDhGenerating(false);
      }
    } catch { toast.error('请求失败'); setDhGenerating(false); }
  };

  const activeMode = MODES.find(m => m.key === mode)!;

  // ====== 通用步骤卡片组件 ======
  const StepCard = ({ num, title, children, hint }: { num: number; title: string; children: React.ReactNode; hint?: string }) => (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-6 h-6 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center text-xs font-bold">{num}</span>
        <h3 className="font-semibold text-sm text-slate-700">{title}</h3>
        {hint && <span className="text-[10px] text-slate-400">{hint}</span>}
      </div>
      {children}
    </div>
  );

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-sky-50 flex flex-col">
      {/* 顶部导航 */}
      <div className="flex items-center justify-between px-6 py-3 bg-white/90 backdrop-blur border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-blue-500 flex items-center justify-center text-xl shadow-md">🎬</div>
          <div><h1 className="text-base font-bold text-slate-800">视频创作</h1><p className="text-xs text-slate-400">{activeMode.label}</p></div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/ai-workspace/promotion/voice')} className="text-xs px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100">🔊 我的声音</button>
          <button onClick={() => router.back()} className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">← 返回</button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ====== 左侧：模式导航 ====== */}
        <div className="w-[140px] flex-shrink-0 border-r border-slate-200 bg-white/60 flex flex-col p-3 gap-1.5">
          {MODES.map(m => (
            <button key={m.key} onClick={() => setMode(m.key)}
              className={`flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl transition-all duration-150 border ${mode === m.key ? `${m.activeBg} shadow-sm` : 'border-transparent hover:bg-slate-50'}`}>
              <span className="text-2xl">{m.icon}</span>
              <span className={`text-xs font-semibold ${mode === m.key ? 'text-slate-800' : 'text-slate-500'}`}>{m.label}</span>
            </button>
          ))}
          <div className="mt-auto pt-3 border-t border-slate-100">
            <button onClick={() => router.push('/ai-workspace/promotion/voice')} className="w-full text-center px-2 py-2 rounded-lg hover:bg-violet-50 text-[11px] text-slate-500 transition-colors">🔊 音色管理</button>
          </div>
        </div>

        {/* ====== 中间：工作区 ====== */}
        <div className="flex-1 overflow-hidden p-4 w-full">
          {/* ✍️ 创作中心 */}
          {mode === 'creation' && <CreationStudio onFlow={handleFlow} />}

          {/* 📝 口播配音 */}
          {mode === 'voiceover' && (
            <div className="h-full flex flex-col">
              {/* 文案编辑 */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-3 flex-shrink-0">
                  <h3 className="text-base font-bold text-slate-700">📝 口播文案</h3>
                  {scriptForFlow?.script && <span className="text-xs text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full">从创作中心流转</span>}
                </div>
                <textarea value={voiceScript} onChange={e => setVoiceScript(e.target.value)}
                  placeholder="粘贴或编辑口播文案，每句不超过15字..."
                  className="flex-1 w-full p-5 border border-slate-200 rounded-3xl text-base leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/20 shadow-sm" />
              </div>
              {/* 音色 + 合成 */}
              <div className="flex-shrink-0 mt-4 bg-white rounded-3xl border border-slate-200 p-5 shadow-sm">
                <div className="flex items-center gap-4 mb-4">
                  <div className="flex-1"><VoiceSelector selectedId={selectedVoiceId} onSelect={setSelectedVoiceId} /></div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      <span>语速</span>
                      <select value={ttsSpeed} onChange={e => setTtsSpeed(Number(e.target.value))} className="px-2 py-1 border rounded-lg text-[11px]">
                        {[0.7,0.8,0.9,1.0,1.1,1.2,1.3].map(v => <option key={v} value={v}>{v}x</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      <span>音量</span>
                      <select value={ttsVolume} onChange={e => setTtsVolume(Number(e.target.value))} className="px-2 py-1 border rounded-lg text-[11px]">
                        {[30,40,50,60,70,80].map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <button onClick={handleTTS} disabled={!voiceScript || ttsLoading} className="px-6 py-3 bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-2xl text-sm font-bold shadow-md hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50 transition-all min-w-[120px]">{ttsLoading ? '⏳ 合成中...' : '🎙️ 合成'}</button>
                  </div>
                </div>
                {ttsAudioUrl && (
                  <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-200">
                    <p className="text-xs font-semibold text-emerald-700 mb-2">✅ 语音已生成</p>
                    <audio controls src={ttsAudioUrl} className="w-full h-10" />
                  </div>
                )}
                {!scriptForFlow?.script && !voiceScript && <p className="text-xs text-slate-400 text-center py-4">💡 先在「AI 创作中心」生成脚本，或直接粘贴口播文案</p>}
              </div>
            </div>
          )}
          {/* 🎬 一键成片 */}
          {mode === 'mediakit' && <MediaKitBatchPanel />}

          {/* 🎞️ 图文快剪 V2 */}
          {mode === 'fastcut' && <FastCutPanel />}

          {/* 🎭 数字人口播 */}
          {mode === 'digital' && <DigitalHumanPanel />}
        </div>

        {/* ====== 右侧：创作记录（仅AI创作中心） ====== */}
        {mode === 'creation' && (
        <div className="w-[280px] flex-shrink-0 border-l border-slate-200 bg-white/60 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-600">📋 创作记录</span>
              <span className="text-[10px] text-slate-400">{history.length} 条</span>
            </div>
            <div className="flex gap-1">
              <button onClick={() => loadHistoryAPI().then(setHistory)} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200">全部</button>
              <button onClick={() => loadHistoryAPI('copy').then(setHistory)} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-500 hover:bg-blue-100">✍️ 文案</button>
              <button onClick={() => loadHistoryAPI('video').then(setHistory)} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-500 hover:bg-emerald-100">🎬 视频</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto custom-scroll p-2 space-y-1.5">
            {history.length === 0 ? (
              <div className="text-center py-12"><p className="text-3xl mb-2">📋</p><p className="text-xs text-slate-400">创作记录将显示在这里</p></div>
            ) : history.filter(h => h.script || h.title).map(item => (
              <button key={item.id} onClick={() => handleLoadFromHistory(item)}
                className="w-full text-left p-3 rounded-xl hover:bg-slate-50 transition-colors border border-transparent hover:border-slate-100 group">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs">{MODES.find(m => m.key === item.mode)?.icon || '📋'}</span>
                  <span className="text-[11px] text-slate-400">{item.time || ''}</span>
                  <span className={`text-[10px] px-1 rounded ${item.audioUrl ? 'bg-emerald-50 text-emerald-500' : 'bg-blue-50 text-blue-500'}`}>{item.audioUrl ? '🎵 配音' : '✍️ 文案'}</span>
                </div>
                <p className="text-xs text-slate-500 font-medium truncate group-hover:text-sky-600">{item.title || '未命名'}</p>
                {item.script ? <p className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">{item.script}</p> : <p className="text-[11px] text-slate-300 mt-0.5 italic">无文案内容</p>}
                {item.audioUrl && item.audioUrl.startsWith('http') && item.audioUrl.match(/\.(mp4|mov|webm)/i) ? (
                  <a href={item.audioUrl} download className="text-[10px] text-sky-500 hover:text-sky-700 mt-1 block">⬇ 下载视频</a>
                ) : item.audioUrl && item.audioUrl.startsWith('http') ? (
                  <audio controls src={item.audioUrl} className="w-full h-6 mt-1 opacity-50 hover:opacity-100 transition-opacity" />
                ) : item.audioUrl && item.audioUrl.length < 100 ? (
                  <p className="text-[10px] text-slate-400 mt-1">任务: {item.audioUrl}</p>
                ) : null}
              </button>
            ))}
          </div>
          {history.length > 0 && (
            <div className="px-3 py-2 border-t border-slate-100">
              <button onClick={() => { setHistory([]); }} className="w-full text-center text-xs text-slate-400 hover:text-red-500 py-1">清空记录</button>
            </div>
          )}
        </div>
        )}
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );
}
