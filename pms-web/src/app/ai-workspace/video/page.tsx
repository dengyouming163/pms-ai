'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { streamAIChat } from '@/lib/ai/chat-client';
import { apiGet, apiPost } from '@/lib/api-client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Mode = 'tts' | 'clone' | 'text';
type Step = 'form' | 'generate' | 'assets' | 'preview';

const MODES = [
  { key: 'tts' as Mode, label: 'AI配音+字幕', icon: '🎙️', desc: '文案 → 选素材 → AI配音 → 字幕合成' },
  { key: 'clone' as Mode, label: '声音复刻+口播', icon: '🎭', desc: 'AI克隆声音 → 口播视频' },
  { key: 'text' as Mode, label: '纯文案脚本', icon: '📝', desc: 'AI写稿 → 分镜 → 自己拍' },
];

const VIDEO_TYPES = ['民宿展示', '老板日常', '客户体验', '周边攻略', '优惠促销'];
const VOICE_TONES = [
  { key: 'warm_female', label: '温柔女声', desc: '温暖亲切，治愈系民宿' },
  { key: 'lively_male', label: '活泼男声', desc: '年轻活力，潮流民宿' },
  { key: 'calm_female', label: '知性女声', desc: '优雅沉稳，高端民宿' },
  { key: 'friendly_male', label: '亲和男声', desc: '自然随和，家庭民宿' },
];

export default function VideoPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('tts');
  const [step, setStep] = useState<Step>('form');
  const [videoType, setVideoType] = useState('民宿展示');
  const [desc, setDesc] = useState('');
  const [voice, setVoice] = useState('warm_female');
  const [voiceSample, setVoiceSample] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState({ script: '', shots: '', music: '', tags: '' });
  const [assets, setAssets] = useState<any[]>([]);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedVideos, setSavedVideos] = useState<any[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadAssets(); loadHistory(); }, []);

  const loadAssets = () => { setLoadingAssets(true); apiGet('/api/assets').then((d: any) => setAssets(d.assets || [])).catch(()=>{}).finally(() => setLoadingAssets(false)); };

  const loadHistory = () => {
    apiGet('/api/assets?category=xhs_note').then((d: any) => {
      setSavedVideos(((d.assets || []) as any[]).filter((n: any) => {
        try { const v = typeof n.value === 'string' ? JSON.parse(n.value) : n.value; return v.type === 'video'; } catch { return false; }
      }));
    }).catch(() => {});
  };

  const handleGenerate = async () => {
    setStep('generate');
    const prompt = `帮我生成一个${videoType}短视频脚本。
口播时长: 30-60秒
${desc ? `补充描述: ${desc}` : ''}

格式要求:
【口播脚本】完整配音文案，口语化，每句不超过15字（方便做字幕）
【分镜指导】3-5个镜头切换建议
【推荐BGM】1-2首
【话题标签】5-8个`;

    setGenerating(true);
    let fullText = '';
    try {
      await streamAIChat(prompt, [], {
        onToken: (t) => { fullText += t; setResult(parseVideo(fullText)); },
        onDone: (s) => { setResult(parseVideo(s)); setGenerating(false); setStep('assets'); },
        onError: (e) => { setGenerating(false); setResult({...result, script:'❌ 生成失败: '+e}); setStep('form'); },
      });
    } catch (e: any) { setGenerating(false); setResult({...result, script:'❌ '+e.message}); setStep('form'); }
  };

  const parseVideo = (text: string) => {
    const scriptMatch = text.match(/【口播脚本】\s*([\s\S]*?)(?=【分镜|【推荐|【话题|$)/);
    const shotsMatch = text.match(/【分镜[指导]*】\s*([\s\S]*?)(?=【推荐|【话题|$)/);
    const musicMatch = text.match(/【推荐BGM】\s*([\s\S]*?)(?=【话题|$)/);
    const tagsMatch = text.match(/【话题标签】\s*([\s\S]*?)$/);
    return { script: scriptMatch?.[1]?.trim() || text, shots: shotsMatch?.[1]?.trim() || '', music: musicMatch?.[1]?.trim() || '', tags: tagsMatch?.[1]?.trim() || '' };
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files; if (!files?.length) return;
    for (const file of Array.from(files)) {
      const form = new FormData(); form.append('file', file);
      const token = localStorage.getItem('pms_auth_token');
      const res = await fetch('/api/upload', { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const data = await res.json();
      if (data.success) { await apiPost('/api/assets', { url: data.url, name: file.name, assetCategory: 'room', tags: [] }); setSelectedAssets(prev => [...prev, data.url]); }
    }
    loadAssets();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(`${result.script}\n\n📸 分镜:\n${result.shots}\n\n🎵 BGM: ${result.music}\n\n🏷️ ${result.tags}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const handleSave = async () => {
    await apiPost('/api/assets', { url: '', name: result.script.slice(0, 30), assetCategory: 'xhs_note', tags: [], value: JSON.stringify({ type: 'video', mode, script: result.script, shots: result.shots, tags: result.tags, videoType, createdAt: new Date().toISOString() }) });
    loadHistory();
  };

  const handleTTS = () => {
    if (!result.script) return;
    const synth = window.speechSynthesis;
    if (!synth) { toast.error('您的浏览器不支持语音合成。请使用 Chrome 或 Edge 浏览器。'); return; }
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(result.script);
    utter.lang = 'zh-CN';
    utter.rate = 0.95;
    // 根据音色选择匹配语音
    const voices = synth.getVoices();
    const voiceMap: Record<string, string> = {
      warm_female: 'zh-CN-XiaoxiaoNeural', lively_male: 'zh-CN-YunyangNeural',
      calm_female: 'zh-CN-XiaoyiNeural', friendly_male: 'zh-CN-YunxiNeural',
    };
    const targetVoice = voices.find(v => v.name === voiceMap[voice]) || voices.find(v => v.lang.startsWith('zh-CN')) || voices[0];
    if (targetVoice) utter.voice = targetVoice;
    synth.speak(utter);
    // 后端持久化记录
    apiPost('/api/video/tts', { text: result.script, voice: voice, mode: 'tts' }).catch(() => {});
  };
  const handleClone = () => {
    if (!result.script) return;
    const synth = window.speechSynthesis;
    if (!synth) { toast.error('您的浏览器不支持语音合成。'); return; }
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(result.script);
    utter.lang = 'zh-CN';
    utter.rate = 0.93;
    const voices = synth.getVoices();
    const maleVoice = voices.find(v => v.lang.startsWith('zh-CN') && v.name.includes('Yun')) || voices.find(v => v.lang.startsWith('zh-CN')) || voices[0];
    if (maleVoice) utter.voice = maleVoice;
    synth.speak(utter);
    apiPost('/api/video/clone', { text: result.script, sample_url: voiceSample, mode: 'clone' }).catch(() => {});
  };

  // ========== 生成中 ==========
  if (step === 'generate') return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-sky-50 flex items-center justify-center flex-col">
      <div className="text-6xl mb-6 animate-bounce">✍️</div>
      <p className="text-lg text-slate-600 mb-2">AI 正在创作脚本...</p>
      <p className="text-sm text-slate-400">{videoType} · {MODES.find(m=>m.key===mode)?.label}</p>
      {result.script && <div className="mt-8 max-w-2xl w-full bg-white rounded-2xl p-6 border mx-4"><div className="text-xs text-slate-400 mb-3">实时预览</div><div className="text-sm text-slate-600 whitespace-pre-wrap line-clamp-8">{result.script}</div></div>}
    </div>
  );

  // ========== 选素材 ==========
  if (step === 'assets') return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-sky-50 flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 bg-white/80 border-b border-sky-100 flex-shrink-0">
        <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-500 flex items-center justify-center text-xl shadow-lg">🎬</div><div><h1 className="text-lg font-bold">选择素材</h1><p className="text-xs text-slate-500">脚本已生成，选择配图后进入预览</p></div></div>
        <button onClick={()=>router.back()} className="text-sm text-slate-400">返回</button>
      </div>
      <div className="flex flex-1 gap-4 p-4 min-h-0">
        <div className="w-96 flex-shrink-0 bg-white rounded-2xl border p-5 shadow-sm overflow-y-auto">
          <h3 className="font-semibold text-sm mb-3">📝 脚本预览</h3>
          <div className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{result.script}</div>
          <div className="mt-4 pt-4 border-t"><p className="text-xs text-slate-500 mb-1">📸 分镜</p><p className="text-sm text-slate-600 whitespace-pre-wrap">{result.shots}</p></div>
        </div>
        <div className="flex-1 flex flex-col bg-white rounded-2xl border p-5 shadow-sm min-h-0">
          <div className="flex items-center justify-between mb-3"><h3 className="font-semibold text-sm">🖼️ 选择素材</h3><div className="flex gap-2"><Button size="sm" onClick={loadAssets} variant="outline" className="text-xs">刷新</Button><Button size="sm" onClick={()=>fileRef.current?.click()} className="text-xs bg-sky-500 text-white">上传素材</Button><input ref={fileRef} type="file" multiple accept="image/*,video/*" className="hidden" onChange={handleUpload} /></div></div>
          <div className="flex-1 overflow-y-auto custom-scroll">{loadingAssets ? <div className="text-center py-8 text-slate-400">加载中...</div> : <div className="grid grid-cols-4 gap-2">{assets.map(a=>(<button key={a.id} onClick={()=>setSelectedAssets(prev=>prev.includes(a.url)?prev.filter(u=>u!==a.url):[...prev,a.url].slice(0,9))} className={`relative rounded-xl overflow-hidden border-2 ${selectedAssets.includes(a.url)?'border-sky-500 shadow-md':'border-transparent hover:border-slate-200'}`}><img src={a.url} alt={a.name} className="w-full h-24 object-cover"/>{selectedAssets.includes(a.url)&&<div className="absolute top-1 right-1 w-5 h-5 bg-sky-500 rounded-full flex items-center justify-center text-white text-xs">✓</div>}</button>))}</div>}</div>
          <div className="mt-3 pt-3 border-t flex items-center justify-between"><span className="text-sm text-slate-500">已选 {selectedAssets.length} 个</span><Button onClick={()=>setStep('preview')} className="bg-gradient-to-r from-sky-500 to-blue-500 text-white">预览 →</Button></div>
        </div>
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );

  // ========== 预览 ==========
  if (step === 'preview') return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-sky-50 flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 bg-white/80 border-b border-sky-100 flex-shrink-0">
        <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-500 flex items-center justify-center text-xl shadow-lg">🎬</div><div><h1 className="text-lg font-bold">视频预览</h1><p className="text-xs text-slate-500">{MODES.find(m=>m.key===mode)?.label}</p></div></div>
        <div className="flex gap-2"><Button onClick={()=>setStep('assets')} variant="ghost" className="text-sm">← 返回选素材</Button><button onClick={()=>router.back()} className="text-sm text-slate-400">返回</button></div>
      </div>
      <div className="flex flex-1 gap-4 p-4 min-h-0">
        <div className="flex-[6] flex flex-col gap-3 overflow-y-auto custom-scroll">
          <div className="bg-white rounded-2xl border p-5 shadow-sm"><h4 className="text-xs font-semibold text-slate-500 mb-2">🎙️ 口播脚本</h4><textarea value={result.script} onChange={e=>setResult({...result,script:e.target.value})} className="w-full h-40 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-sky-500/20" /></div>
          <div className="bg-white rounded-2xl border p-5 shadow-sm"><h4 className="text-xs font-semibold text-slate-500 mb-2">📸 分镜指导</h4><textarea value={result.shots} onChange={e=>setResult({...result,shots:e.target.value})} className="w-full h-24 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-sky-500/20" /></div>
          <div className="grid grid-cols-2 gap-3"><div className="bg-white rounded-2xl border p-5 shadow-sm"><h4 className="text-xs font-semibold text-slate-500 mb-2">🎵 BGM</h4><textarea value={result.music} onChange={e=>setResult({...result,music:e.target.value})} className="w-full h-20 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-sky-500/20" /></div><div className="bg-white rounded-2xl border p-5 shadow-sm"><h4 className="text-xs font-semibold text-slate-500 mb-2">🏷️ 标签</h4><textarea value={result.tags} onChange={e=>setResult({...result,tags:e.target.value})} className="w-full h-20 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-sky-500/20" /></div></div>
        </div>
        <div className="flex-[4] flex flex-col gap-3">
          {selectedAssets.length > 0 ? <div className="bg-white rounded-2xl border p-4 shadow-sm flex-1 overflow-y-auto custom-scroll"><h4 className="text-xs font-semibold text-slate-500 mb-2">📷 素材 ({selectedAssets.length}张)</h4><div className="grid grid-cols-2 gap-2">{selectedAssets.map((url,i)=><img key={i} src={url} className="w-full h-28 object-cover rounded-xl"/>)}</div></div> : <div className="bg-white rounded-2xl border p-4 shadow-sm flex-1 flex items-center justify-center text-slate-400 text-sm">未选择素材</div>}
          <Button onClick={handleCopy} className="w-full py-3 bg-gradient-to-r from-sky-500 to-blue-500 text-white text-base rounded-2xl">{copied?'✅ 已复制':'📋 复制脚本'}</Button>
          {mode==='tts'&&<Button onClick={handleTTS} variant="outline" className="w-full py-2.5 text-sm rounded-xl border-sky-300 text-sky-600">🎙️ AI配音播放（浏览器语音合成）</Button>}
          {mode==='clone'&&<Button onClick={handleClone} variant="outline" className="w-full py-2.5 text-sm rounded-xl border-purple-300 text-purple-600">🎭 声音复刻播放（浏览器语音合成）</Button>}
          <div className="flex gap-2"><Button onClick={handleSave} variant="outline" className="flex-1 py-2 text-sm rounded-xl">💾 保存</Button><Button onClick={()=>{setStep('form');setResult({script:'',shots:'',music:'',tags:''});setSelectedAssets([]);}} variant="ghost" className="flex-1 py-2 text-sm text-slate-400 rounded-xl">🔄 重做</Button></div>
        </div>
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );

  // ========== 表单主页 ==========
  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-sky-50 flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 bg-white/80 border-b border-sky-100 flex-shrink-0">
        <div className="flex items-center gap-3"><div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-sky-500 to-blue-500 flex items-center justify-center text-xl shadow-lg">🎬</div><div><h1 className="text-lg font-bold text-slate-800">短视频创作</h1><p className="text-xs text-slate-500">{MODES.find(m=>m.key===mode)?.label}</p></div></div>
        <button onClick={()=>router.back()} className="text-sm text-slate-400 hover:text-slate-600">返回</button>
      </div>
      <div className="flex flex-1 gap-4 p-4 min-h-0">
        <div className="w-80 flex-shrink-0 flex flex-col gap-3 overflow-y-auto custom-scroll">
          <div className="bg-white rounded-2xl border p-4 shadow-sm"><h3 className="text-sm font-semibold text-slate-700 mb-3">选择模式</h3><div className="space-y-2">{MODES.map(m=>(<button key={m.key} onClick={()=>setMode(m.key)} className={`w-full text-left p-3 rounded-xl border transition-all ${mode===m.key?'border-sky-400 bg-sky-50':'border-slate-100 hover:border-sky-200'}`}><div className="flex items-center gap-2 mb-0.5"><span className="text-lg">{m.icon}</span><span className="text-sm font-semibold">{m.label}</span></div><p className="text-xs text-slate-400">{m.desc}</p></button>))}</div></div>
          <div className="bg-white rounded-2xl border p-4 shadow-sm flex flex-col gap-3">
            <div><label className="text-xs font-semibold text-slate-500 mb-1.5 block">视频类型</label><div className="flex flex-wrap gap-2">{VIDEO_TYPES.map(t=><button key={t} onClick={()=>setVideoType(t)} className={`px-3 py-1.5 rounded-full text-xs ${videoType===t?'bg-sky-500 text-white':'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{t}</button>)}</div></div>
            {mode==='tts'&&<div><label className="text-xs font-semibold text-slate-500 mb-1.5 block">AI音色</label><div className="space-y-1.5">{VOICE_TONES.map(v=><button key={v.key} onClick={()=>setVoice(v.key)} className={`w-full text-left p-2.5 rounded-xl border text-xs transition-all ${voice===v.key?'border-sky-400 bg-sky-50':'border-slate-100 hover:border-sky-200'}`}><span className="font-medium text-slate-700">{v.label}</span><span className="text-slate-400 ml-1.5">{v.desc}</span></button>)}</div></div>}
            {mode==='clone'&&<div className="bg-amber-50 rounded-xl p-3 border border-amber-200"><p className="text-xs text-amber-700 font-semibold mb-2">🔊 声音样本（API预留）</p><Input value={voiceSample} onChange={e=>setVoiceSample(e.target.value)} placeholder="声音样本URL" className="text-xs mb-2" /><p className="text-[10px] text-amber-500">录30秒语音 → AI克隆 → 所有视频用你的声音</p></div>}
            <div><label className="text-xs font-semibold text-slate-500 mb-1.5 block">补充描述</label><Input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="如：展示浴缸看山景" className="text-sm" /></div>
            <Button onClick={handleGenerate} disabled={generating} className="w-full py-3 bg-gradient-to-r from-sky-500 to-blue-500 text-white text-base rounded-2xl">{generating?'⏳...':'🎬 开始创作'}</Button>
          </div>
          {savedVideos.length>0&&<div className="bg-white rounded-2xl border p-4 shadow-sm"><h3 className="text-sm font-semibold text-slate-600 mb-2">📋 历史记录</h3><div className="space-y-1 max-h-40 overflow-y-auto custom-scroll">{savedVideos.slice(0,5).map((v,i)=>(<button key={i} onClick={()=>{try{const d=typeof v.value==='string'?JSON.parse(v.value):v.value;setResult({script:d.script||'',shots:d.shots||'',music:'',tags:d.tags||''});setMode(d.mode||'tts');setStep('preview');}catch{}}} className="w-full text-left px-3 py-2 rounded-lg hover:bg-sky-50 text-xs text-slate-500 truncate">{v.key?.slice(0,40)}</button>))}</div></div>}
        </div>
        <div className="flex-1 flex items-center justify-center text-slate-400"><div className="text-center"><div className="text-6xl mb-4">🎬</div><p className="text-lg">选择模式和类型后开始创作</p></div></div>
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );
}
