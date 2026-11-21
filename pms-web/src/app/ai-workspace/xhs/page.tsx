'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { streamAIChat } from '@/lib/ai/chat-client';
import { apiGet, apiPost } from '@/lib/api-client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Scene = { key: string; label: string; icon: string; prompt: string };
type Step = 'scene' | 'generate' | 'assets' | 'preview';
type Tab = 'write' | 'calendar' | 'analytics' | 'drafts';

const SCENES: Scene[] = [
  { key: 'new_room', label: '新房上线', icon: '🏠', prompt: '我家民宿有新房型上线了，帮我写一篇小红书种草笔记。描述房型特色、适合人群、周边环境，让人想马上订房。' },
  { key: 'season', label: '季节推广', icon: '🌸', prompt: '现在是夏天，帮我写一篇小红书季节推广笔记。结合夏季的景色和民宿体验（清晨鸟鸣、傍晚凉风、星空露台），突出夏天的美好。' },
  { key: 'promo', label: '特价促销', icon: '💰', prompt: '我家民宿在做促销活动，帮我写一篇小红书笔记推广。突出性价比和限时优惠，让人有紧迫感。' },
  { key: 'review', label: '客户好评', icon: '⭐', prompt: '有客户给了好评，帮我写一篇小红书笔记（以老板视角分享客户的真实好评和感动瞬间）。温暖真实。' },
  { key: 'travel', label: '周边游攻略', icon: '🗺️', prompt: '帮我写一篇民宿周边游玩攻略的小红书笔记。介绍周边3-5个打卡点，以"住我家民宿，周边这样玩"为角度。' },
  { key: 'custom', label: '自由发挥', icon: '✍️', prompt: '' },
];

const STYLES = ['温馨治愈', '高级冷淡', '活泼可爱', '文艺诗意', '真实接地气'];
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

interface TabCard { key: Tab; label: string; icon: string; desc: string; activeBg: string; }
const TABS: TabCard[] = [
  { key: 'write', label: '写笔记', icon: '✍️', desc: '选场景→AI生成→配图→发布', activeBg: 'bg-gradient-to-r from-rose-50 to-pink-50 border-rose-300' },
  { key: 'calendar', label: '内容周历', icon: '📅', desc: 'AI策划7天话题日历', activeBg: 'bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-300' },
  { key: 'analytics', label: '数据分析', icon: '📊', desc: '笔记表现追踪·转化分析', activeBg: 'bg-gradient-to-r from-blue-50 to-sky-50 border-blue-300' },
  { key: 'drafts', label: '草稿管理', icon: '📋', desc: '保存·发布检查·发布记录', activeBg: 'bg-gradient-to-r from-amber-50 to-orange-50 border-amber-300' },
];

// 智能推荐生成：基于时间、日期、季节
function getSmartXhsSuggestions(): Array<{ label: string; prompt: string; icon: string; sceneKey: string }> {
  const now = new Date();
  const hour = now.getHours(); const day = now.getDay(); const month = now.getMonth() + 1;
  const all: Array<{ label: string; prompt: string; icon: string; sceneKey: string }> = [];

  if (hour < 10) {
    all.push({ label: '民宿早餐图鉴', prompt: '写一篇民宿早餐种草笔记——丰盛的九宫格早餐、手冲咖啡、阳光洒进餐厅。让人看了就想来吃。', icon: '🍳', sceneKey: 'new_room' });
  } else if (hour < 18) {
    all.push({ label: '周边游玩攻略', prompt: '住我家民宿，周边这样玩！帮我写一篇3天2晚的周边游玩攻略笔记，附带交通、门票、美食推荐。', icon: '🗺️', sceneKey: 'travel' });
  } else {
    all.push({ label: '夜间氛围感', prompt: '夜幕降临，民宿亮起暖灯——星空、烛光、浴缸、红酒。帮我写一篇夜间氛围感种草笔记，让人想立刻订房。', icon: '✨', sceneKey: 'new_room' });
  }

  if (day === 0 || day === 6) {
    all.push({ label: '周末说走就走', prompt: '周末不知道去哪？这家民宿人均200住进风景里！写一篇周末出行种草笔记，突出性价比。', icon: '🚗', sceneKey: 'promo' });
  } else if (day === 4 || day === 5) {
    all.push({ label: '周五种草预告', prompt: '周五晚上发一篇种草笔记——预告周末还剩几间房，看了就想下单。营造紧迫感。', icon: '📢', sceneKey: 'promo' });
  }

  if (month >= 6 && month <= 8) {
    all.push({ label: '夏日避暑民宿', prompt: '城市38度，山里22度。写一篇夏日避暑民宿种草笔记——山泉泳池、竹林清风、冰镇西瓜。', icon: '🌿', sceneKey: 'season' });
  } else if (month >= 3 && month <= 5) {
    all.push({ label: '春日赏花季', prompt: '民宿周围的花都开了！樱花/油菜花/桃花，写一篇春日赏花+民宿体验种草笔记。', icon: '🌸', sceneKey: 'season' });
  } else if (month >= 9 && month <= 11) {
    all.push({ label: '秋日红叶季', prompt: '漫山红叶，正是住民宿最好的季节。写一篇秋日观景民宿种草笔记，突出自然景观。', icon: '🍂', sceneKey: 'season' });
  } else {
    all.push({ label: '冬日围炉煮茶', prompt: '外面很冷，民宿很暖。围炉煮茶看雪景——写一篇冬日温暖民宿种草笔记。', icon: '🔥', sceneKey: 'season' });
  }

  all.push({ label: '客户真实好评', prompt: '写一篇以客户好评和感动瞬间为主题的笔记——"客人说住过就忘不了"。温暖真实。', icon: '⭐', sceneKey: 'review' });
  return all.slice(0, 6);
}

const HISTORY_KEY = 'pms_xhs_history';
function loadHistory(): any[] { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(items: any[]) { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 30))); }

export default function XHSPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('write');
  const [noteHistory, setNoteHistory] = useState<any[]>([]);
  const smartSuggestions = getSmartXhsSuggestions();
  useEffect(() => { setNoteHistory(loadHistory()); }, []);

  const handleQuickWrite = (sceneKey: string, prompt: string) => {
    const s = SCENES.find(s => s.key === sceneKey) || SCENES[0];
    setScene(s);
    if (s.key === 'custom') setCustomPrompt(prompt);
    setStep('generate');
    setGenerating(true);
    const storeCtx = `\n【民宿信息】\n名称: ${storeInfo.name}\n地址: ${storeInfo.address}\n特色: ${storeInfo.features}\n房型: ${storeInfo.roomTypes}\n`;
    const fullPrompt = `写一篇小红书民宿种草笔记。${storeCtx}\n${prompt}\n风格: ${style}\n字数: 500字\n\n【标题】20字以内，带emoji\n【备选标题】再生成3个不同风格的备选标题\n【正文】分3-4段，有画面感，埋"周边游""民宿推荐"等搜索词\n【标签】5-8个话题标签`;
    let fullText = '';
    streamAIChat(fullPrompt, [], {
      onToken: (t) => { fullText += t; const r = parseNote(fullText); setResult(r); },
      onDone: (s) => { const r = parseNote(s); setResult(r); setEditableTitle(r.title); setEditableBody(r.body); setEditableTags(r.tags); setGenerating(false); setStep('assets'); loadAssets(); addToHistory(r.title); },
      onError: () => { setGenerating(false); setStep('scene'); },
    });
  };

  // ====== 写笔记 状态 ======
  const [step, setStep] = useState<Step>('scene');
  const [scene, setScene] = useState<Scene>(SCENES[0]);
  const [customPrompt, setCustomPrompt] = useState('');
  const [style, setStyle] = useState('温馨治愈');
  const [keywords, setKeywords] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState({ title: '', body: '', tags: '' });
  const [editableTitle, setEditableTitle] = useState('');
  const [editableBody, setEditableBody] = useState('');
  const [editableTags, setEditableTags] = useState('');
  const [assets, setAssets] = useState<any[]>([]);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [copied, setCopied] = useState(false);
  const [storeInfo, setStoreInfo] = useState({ name: '', address: '', features: '', roomTypes: '' });
  const [altTitles, setAltTitles] = useState<string[]>([]);
  const [savedNotes, setSavedNotes] = useState<any[]>([]);
  const [publishCheck, setPublishCheck] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ====== 日历/分析/草稿 状态 ======
  const [weekData, setWeekData] = useState<any[]>([]);
  const [weekStart, setWeekStart] = useState(''); const [weekEnd, setWeekEnd] = useState('');
  const [calLoading, setCalLoading] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [posts, setPosts] = useState<any[]>([]);
  const [alLoading, setAlLoading] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);

  // ====== 初始化 ======
  useEffect(() => {
    apiGet('/api/stores').then((d: any) => {
      const stores = d || [];
      if (stores.length > 0) {
        const s = stores[0];
        apiGet('/api/stores?type=roomTypes&storeId=' + s.id).then((rt: any) => {
          const names = (rt || []).map((r: any) => r.name).join('、');
          setStoreInfo({ name: s.name || '我的民宿', address: s.address || '', features: s.facilities?.join('、') || '免费WiFi、停车场', roomTypes: names || '大床房、双床房' });
        }).catch(() => {});
      }
    }).catch(() => {});
    apiGet('/api/assets?category=xhs_note').then((d: any) => setSavedNotes(d.assets || [])).catch(() => {});
    loadAssets();
  }, []);

  useEffect(() => {
    if (tab === 'calendar') loadCalendar();
    if (tab === 'analytics') loadAnalytics();
    if (tab === 'drafts') loadDrafts();
  }, [tab]);

  const loadAssets = () => { setLoadingAssets(true); apiGet('/api/assets').then((d: any) => setAssets(d.assets || [])).finally(() => setLoadingAssets(false)); };

  const addToHistory = (title: string) => {
    const item = { id: Date.now().toString(36), title: title || '笔记', time: new Date().toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) };
    const updated = [item, ...noteHistory];
    setNoteHistory(updated); saveHistory(updated);
  };

  // ====== 日历 ======
  const loadCalendar = (offset = 0) => {
    setCalLoading(true);
    const d = new Date(); d.setDate(d.getDate() + offset * 7);
    const monday = new Date(d); monday.setDate(d.getDate() - d.getDay() + 1);
    const ws = monday.toISOString().split('T')[0];
    apiGet(`/api/content/calendar?week=${ws}`).then((d: any) => { setWeekData(d.data || []); setWeekStart(d.weekStart || ''); setWeekEnd(d.weekEnd || ''); }).catch(() => {}).finally(() => setCalLoading(false));
  };
  const loadAnalytics = () => { setAlLoading(true); apiGet('/api/xhs/analytics').then((d: any) => setAnalytics(d.data || null)).catch(() => {}); apiGet('/api/xhs/posts').then((d: any) => setPosts(d.data || [])).catch(() => {}).finally(() => setAlLoading(false)); };
  const loadDrafts = () => { setDraftsLoading(true); apiGet('/api/xhs/drafts').then((d: any) => setDrafts(d.data || [])).catch(() => {}).finally(() => setDraftsLoading(false)); };
  const handleCalendarGenerate = async () => {
    setCalLoading(true); const token = localStorage.getItem('pms_auth_token');
    await fetch('/api/content/calendar/generate', { method: 'POST', headers: token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekStart: weekStart || new Date().toISOString().split('T')[0] }) });
    loadCalendar();
  };

  // ====== 写笔记逻辑 ======
  const handleGenerate = async () => {
    setStep('generate');
    const prompt = scene.key === 'custom' ? customPrompt : scene.prompt;
    if (!prompt && scene.key === 'custom') return;
    const storeCtx = `\n【民宿信息】\n名称: ${storeInfo.name}\n地址: ${storeInfo.address}\n特色: ${storeInfo.features}\n房型: ${storeInfo.roomTypes}\n`;
    const fullPrompt = `写一篇小红书民宿种草笔记。${storeCtx}\n${prompt}\n风格: ${style}\n${keywords ? `关键词: ${keywords}` : ''}\n字数: 500字\n\n【标题】20字以内，带emoji\n【备选标题】再生成3个不同风格的备选标题\n【正文】分3-4段，有画面感，埋"周边游""民宿推荐"等搜索词\n【标签】5-8个话题标签`;
    setGenerating(true); let fullText = '';
    try {
      await streamAIChat(fullPrompt, [], {
        onToken: (t) => { fullText += t; const r = parseNote(fullText); setResult(r); },
        onDone: (s) => { const r = parseNote(s); setResult(r); setEditableTitle(r.title); setEditableBody(r.body); setEditableTags(r.tags); setGenerating(false); setStep('assets'); loadAssets(); addToHistory(r.title); },
        onError: () => { setGenerating(false); },
      });
    } catch { setGenerating(false); }
  };
  const parseNote = (text: string) => {
    const titleMatch = text.match(/【标题】\s*(.+?)(?:\n|【|$)/);
    const altMatch = text.match(/【备选标题】\s*([\s\S]*?)(?=【正文】|$)/);
    const bodyMatch = text.match(/【正文】\s*([\s\S]*?)(?=【标签】|$)/);
    const tagsMatch = text.match(/【标签】\s*([\s\S]*?)$/);
    if (altMatch) { const alts = altMatch[1].split('\n').filter(s=>s.trim()).map(s=>s.replace(/^\d+[\.、)\s]*/,'').trim()); setAltTitles(alts); }
    return { title: titleMatch?.[1]?.trim() || '', body: bodyMatch?.[1]?.trim() || text, tags: tagsMatch?.[1]?.trim() || '' };
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
  const handleCopy = () => { const full = `${editableTitle}\n\n${editableBody}\n\n${editableTags}`; navigator.clipboard.writeText(full).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };
  const handleSaveDraft = async () => {
    const token = localStorage.getItem('pms_auth_token');
    await fetch('/api/xhs/drafts', { method: 'POST', headers: token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: editableTitle, content: editableBody, tags: editableTags.split(/[#\s]+/).filter(Boolean), images: selectedAssets }) });
    toast.success('已保存到草稿箱');
  };
  const handlePublishCheck = async () => {
    await handleSaveDraft();
    const token = localStorage.getItem('pms_auth_token');
    fetch(`/api/xhs/drafts/xhsd_check/check`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(r => r.json()).then(d => setPublishCheck(d)).catch(() => {});
  };
  const StepCard = ({ num, title, children, hint }: { num: number; title: string; children: React.ReactNode; hint?: string }) => (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-4"><span className="w-6 h-6 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center text-xs font-bold">{num}</span><h3 className="font-semibold text-sm text-slate-700">{title}</h3>{hint && <span className="text-[10px] text-slate-400">{hint}</span>}</div>
      {children}
    </div>
  );

  // ====== 渲染函数 ======
  const renderWriteTab = () => (
    <div className="space-y-4">
      {/* 💡 AI智能推荐 */}
      {step === 'scene' && (
        <div className="bg-gradient-to-br from-rose-50 via-white to-pink-50 rounded-2xl border border-rose-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">💡</span>
            <h3 className="font-semibold text-sm text-rose-700">AI 智能推荐</h3>
            <span className="text-[10px] text-rose-400">基于当前时间、季节为你推荐话题</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {smartSuggestions.map((s, i) => (
              <button key={i} onClick={() => handleQuickWrite(s.sceneKey, s.prompt)}
                className="text-left p-3 rounded-xl border border-rose-100 bg-white hover:border-rose-300 hover:shadow-sm transition-all group">
                <div className="flex items-center gap-1.5 mb-1"><span className="text-base">{s.icon}</span><span className="text-sm font-medium text-slate-700 group-hover:text-rose-600">{s.label}</span></div>
                <p className="text-xs text-slate-400 line-clamp-2">{s.prompt.slice(0, 50)}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 选场景 */}
      {step === 'scene' && (
        <div className="space-y-4">
          <StepCard num={1} title="选择推广场景" hint="共6种场景可选">
            <div className="grid grid-cols-3 gap-3">{SCENES.map(s => (
              <button key={s.key} onClick={() => setScene(s)} className={`rounded-2xl p-4 border-2 text-left transition-all ${scene.key===s.key?'border-rose-400 bg-rose-50 shadow-md':'border-slate-100 bg-white hover:border-rose-200 shadow-sm'}`}>
                <div className="text-2xl mb-1">{s.icon}</div><div className="font-semibold text-sm text-slate-700">{s.label}</div>
              </button>))}</div>
            {scene.key==='custom' && <textarea value={customPrompt} onChange={e=>setCustomPrompt(e.target.value)} placeholder="描述你想写的内容..." className="w-full p-4 border border-slate-200 rounded-2xl text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-rose-500/20" />}
          </StepCard>
          <StepCard num={2} title="选择风格和关键词">
            <div className="flex gap-4 items-center flex-wrap">
              <div><label className="text-xs text-slate-500 mb-1 block">风格</label><div className="flex gap-2">{STYLES.map(s=><button key={s} onClick={()=>setStyle(s)} className={`px-3 py-1.5 rounded-full text-xs ${style===s?'bg-rose-500 text-white':'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{s}</button>)}</div></div>
              <div className="flex-1"><label className="text-xs text-slate-500 mb-1 block">关键词</label><Input value={keywords} onChange={e=>setKeywords(e.target.value)} placeholder="如：莫干山民宿 周末去哪儿" className="text-sm" /></div>
            </div>
          </StepCard>
          <details className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <summary className="text-sm font-semibold text-slate-600 cursor-pointer">🏨 民宿信息（AI创作参考）</summary>
            <div className="grid grid-cols-2 gap-3 mt-3 text-sm">
              <div><input value={storeInfo.name} onChange={e=>setStoreInfo({...storeInfo,name:e.target.value})} className="w-full px-2 py-1 border rounded-lg text-sm" placeholder="名称" /></div>
              <div><input value={storeInfo.address} onChange={e=>setStoreInfo({...storeInfo,address:e.target.value})} className="w-full px-2 py-1 border rounded-lg text-sm" placeholder="地址" /></div>
              <div className="col-span-2"><input value={storeInfo.features} onChange={e=>setStoreInfo({...storeInfo,features:e.target.value})} className="w-full px-2 py-1 border rounded-lg text-sm" placeholder="特色" /></div>
              <div className="col-span-2"><input value={storeInfo.roomTypes} onChange={e=>setStoreInfo({...storeInfo,roomTypes:e.target.value})} className="w-full px-2 py-1 border rounded-lg text-sm" placeholder="房型" /></div>
            </div>
          </details>
          <Button onClick={handleGenerate} disabled={generating} className="w-full py-3 bg-gradient-to-r from-rose-500 to-pink-500 text-white text-base rounded-2xl">🚀 开始AI创作</Button>
        </div>
      )}
      {/* 生成中 */}
      {step === 'generate' && (
        <div className="bg-white rounded-2xl border border-rose-200 p-12 text-center">
          <div className="text-5xl mb-4 animate-bounce">✍️</div><p className="text-slate-600 text-sm">AI 正在为你创作...</p>
          {generating && result.title && <div className="mt-6 text-left bg-slate-50 rounded-xl p-4"><p className="text-xs text-slate-400 mb-2">实时预览</p><p className="font-bold text-slate-800 mb-2">{result.title}</p><p className="text-sm text-slate-600 line-clamp-4">{result.body}</p></div>}
        </div>
      )}
      {/* 选配图 */}
      {step === 'assets' && (
        <div className="space-y-4">
          <StepCard num={3} title="文案预览">
            <div className="font-bold text-slate-800 mb-2">{result.title}</div>
            <div className="text-sm text-slate-600 whitespace-pre-wrap mb-2">{result.body}</div>
            <div className="text-sm text-rose-500">{result.tags}</div>
          </StepCard>
          <StepCard num={4} title="选择配图（最多9张）">
            <div className="flex gap-2 mb-3">
              <Button size="sm" onClick={loadAssets} variant="outline" className="text-xs">刷新</Button>
              <Button size="sm" onClick={()=>fileRef.current?.click()} className="text-xs bg-rose-500 text-white">上传新图</Button>
              <input ref={fileRef} type="file" multiple accept="image/*" className="hidden" onChange={handleUpload} />
            </div>
            {loadingAssets ? <p className="text-xs text-slate-400">加载中...</p> :
             <div className="grid grid-cols-4 gap-2">{assets.map(a=>(<button key={a.id} onClick={()=>setSelectedAssets(prev=>prev.includes(a.url)?prev.filter(u=>u!==a.url):[...prev,a.url].slice(0,9))} className={`relative rounded-xl overflow-hidden border-2 ${selectedAssets.includes(a.url)?'border-rose-500 shadow-md':'border-transparent hover:border-slate-200'}`}><img src={a.url} alt={a.name} className="w-full h-24 object-cover"/>{selectedAssets.includes(a.url)&&<div className="absolute top-1 right-1 w-5 h-5 bg-rose-500 rounded-full flex items-center justify-center text-white text-xs">✓</div>}</button>))}</div>}
            <div className="mt-3 flex items-center justify-between"><span className="text-sm text-slate-500">已选 {selectedAssets.length}/9 张</span><Button onClick={()=>setStep('preview')} disabled={selectedAssets.length===0} className="bg-gradient-to-r from-rose-500 to-pink-500 text-white">预览 →</Button></div>
          </StepCard>
        </div>
      )}
      {/* 预览发布 */}
      {step === 'preview' && (
        <div className="space-y-4">
          <StepCard num={5} title="标题和正文">
            <input value={editableTitle} onChange={e=>setEditableTitle(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm font-bold mb-2 focus:outline-none focus:ring-2 focus:ring-rose-500/20" />
            {altTitles.length>0 && <div className="flex flex-wrap gap-1.5 mb-2">{altTitles.map((t,i)=><button key={i} onClick={()=>setEditableTitle(t)} className="px-2 py-1 rounded-lg bg-rose-50 text-xs text-rose-600 hover:bg-rose-100">{t}</button>)}</div>}
            <textarea value={editableBody} onChange={e=>setEditableBody(e.target.value)} className="w-full h-40 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-rose-500/20" />
            <input value={editableTags} onChange={e=>setEditableTags(e.target.value)} className="w-full mt-2 px-3 py-2 border border-slate-200 rounded-xl text-sm text-rose-500" />
          </StepCard>
          <StepCard num={6} title="配图预览">
            <div className="grid grid-cols-3 gap-1">{selectedAssets.map((url,i)=><img key={i} src={url} className="w-full h-20 object-cover rounded-lg"/>)}</div>
          </StepCard>
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={handleCopy} className="py-3 bg-gradient-to-r from-rose-500 to-pink-500 text-white rounded-xl">{copied?'✅ 已复制':'📋 复制文案'}</Button>
            <Button onClick={handleSaveDraft} variant="outline" className="py-3 rounded-xl">💾 保存草稿</Button>
          </div>
          <Button onClick={()=>setStep('scene')} variant="ghost" className="w-full py-2 text-sm text-slate-400 rounded-xl">🔄 重新生成</Button>
        </div>
      )}
    </div>
  );

  const renderCalendarTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><button onClick={() => loadCalendar(-1)} className="text-slate-400">&lt;</button><h3 className="font-semibold">{weekStart||'...'} ~ {weekEnd||'...'}</h3><button onClick={() => loadCalendar(1)} className="text-slate-400">&gt;</button><button onClick={() => loadCalendar(0)} className="text-xs px-2 py-1 bg-slate-100 rounded">本周</button></div>
        <Button onClick={handleCalendarGenerate} disabled={calLoading} className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-sm">{calLoading ? '⏳ AI策划中...' : '🤖 AI 生成周历'}</Button>
      </div>
      <div className="grid grid-cols-7 gap-3">{weekData.map((day, i) => {
        const isToday = day.date === new Date().toISOString().split('T')[0];
        return <div key={i} className={`rounded-2xl border p-4 min-h-[160px] ${isToday ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-100 bg-white'} shadow-sm`}>
          <div className="flex items-center justify-between mb-2"><span className={`text-xs font-bold ${isToday?'text-emerald-600':'text-slate-400'}`}>{WEEKDAYS[i]} {day.date?.slice(5)}</span>{isToday&&<span className="text-[10px] bg-emerald-500 text-white px-1.5 py-0.5 rounded-full">今天</span>}</div>
          {day.topic ? <div><p className="text-sm font-semibold text-slate-700 mb-1">{day.topic}</p><p className="text-xs text-slate-400 line-clamp-2">{day.titleSuggestion}</p></div> : <p className="text-xs text-slate-300 text-center py-6">待策划</p>}
          {day.topic && <button onClick={() => { if(day.titleSuggestion){setEditableTitle(day.titleSuggestion);setStep('scene');setTab('write');} }} className="text-[10px] mt-2 px-2 py-1 bg-rose-50 text-rose-500 rounded">采纳→写笔记</button>}
        </div>;
      })}</div>
      {weekData.length===0 && !calLoading && <div className="text-center py-12 text-slate-400"><p className="text-3xl mb-2">📅</p><p>点击"AI 生成周历"，AI 基于天气/节假日/房态策划一周话题</p></div>}
    </div>
  );

  const renderAnalyticsTab = () => (
    <div className="space-y-4">
      {alLoading ? <p className="text-slate-400 text-center py-12">加载中...</p> : analytics ? <>
        <div className="grid grid-cols-4 gap-3">
          {[{label:'发布篇数',value:analytics.totalPosts,unit:'篇',c:'text-rose-600'},{label:'总曝光',value:analytics.totalViews,unit:'',c:'text-blue-600'},{label:'互动',value:analytics.totalLikes+analytics.totalCollects+analytics.totalComments,unit:'',c:'text-amber-600'},{label:'转化订单',value:analytics.totalOrders,unit:'单',c:'text-emerald-600'}].map((m,i)=><div key={i} className="bg-white rounded-2xl border p-4 text-center shadow-sm"><p className={`text-3xl font-bold ${m.c}`}>{m.value}{m.unit}</p><p className="text-xs text-slate-400 mt-1">{m.label}</p></div>)}
        </div>
        <div className="bg-white rounded-2xl border p-4 shadow-sm"><h3 className="text-sm font-semibold">📈 转化率: {analytics.conversionRate} | 均赞: {analytics.avgLikes}</h3></div>
        {posts.length>0 && <div className="bg-white rounded-2xl border shadow-sm overflow-hidden"><table className="w-full text-sm"><thead className="bg-slate-50"><tr><th className="text-left px-4 py-2 text-xs text-slate-500">时间</th><th className="text-left px-4 py-2 text-xs text-slate-500">链接</th><th className="text-right px-4 py-2 text-xs">👁</th><th className="text-right px-4 py-2 text-xs">❤</th><th className="text-right px-4 py-2 text-xs">↗</th></tr></thead><tbody className="divide-y">{posts.map((p:any)=><tr key={p.id} className="hover:bg-slate-50"><td className="px-4 py-2 text-xs text-slate-400">{p.publishedAt?.slice(0,10)}</td><td className="px-4 py-2 text-xs text-sky-500 truncate max-w-[200px]">{p.publishUrl?.slice(0,40)}</td><td className="px-4 py-2 text-xs text-right">{p.views||0}</td><td className="px-4 py-2 text-xs text-right">{p.likes||0}</td><td className="px-4 py-2 text-xs text-right text-emerald-500">{p.conversions||0}</td></tr>)}</tbody></table></div>}
      </> : <div className="text-center py-12 text-slate-400"><p className="text-3xl mb-2">📊</p><p>暂无数据</p></div>}
    </div>
  );

  const renderDraftsTab = () => (
    <div className="space-y-3">
      {draftsLoading ? <p className="text-slate-400 text-center py-12">加载中...</p> :
       drafts.length===0 ? <div className="text-center py-12 text-slate-400"><p className="text-3xl mb-2">📋</p><p>暂无草稿</p></div> :
       drafts.map((d:any) => <div key={d.id} className="bg-white rounded-2xl border p-4 shadow-sm">
        <div className="flex items-center justify-between mb-2"><span className="text-sm font-semibold text-slate-700">{d.title||'无标题'}</span><span className={`text-xs px-2 py-0.5 rounded-full ${d.status==='draft'?'bg-amber-50 text-amber-600':'bg-emerald-50 text-emerald-600'}`}>{d.status==='draft'?'草稿':'已发布'}</span></div>
        <p className="text-xs text-slate-400 line-clamp-2 mb-2">{d.content?.slice(0,100)}</p>
        <div className="flex gap-2">
          <button onClick={()=>{setEditableTitle(d.title||'');setEditableBody(d.content||'');setEditableTags((d.tags||[]).map((t:string)=>`#${t}`).join(' '));setStep('preview');setTab('write');}} className="text-xs px-3 py-1 bg-rose-50 text-rose-500 rounded-lg hover:bg-rose-100">编辑</button>
          <button onClick={async()=>{const token=localStorage.getItem('pms_auth_token');await fetch('/api/xhs/posts',{method:'POST',headers:token?{'Content-Type':'application/json',Authorization:`Bearer ${token}`}:{'Content-Type':'application/json'},body:JSON.stringify({draftId:d.id,publishUrl:''})});loadDrafts();}} className="text-xs px-3 py-1 bg-emerald-50 text-emerald-500 rounded-lg hover:bg-emerald-100">标记已发布</button>
          <button onClick={async()=>{const token=localStorage.getItem('pms_auth_token');await fetch(`/api/xhs/drafts/${d.id}`,{method:'DELETE',headers:token?{Authorization:`Bearer ${token}`}:{}});loadDrafts();}} className="text-xs px-3 py-1 text-slate-400 hover:text-red-500">删除</button>
        </div>
      </div>)}
    </div>
  );

  const activeTab = TABS.find(t => t.key === tab)!;

  return (
    <div className="h-screen bg-gradient-to-br from-rose-50 via-white to-pink-50 flex flex-col">
      {/* 顶部导航 */}
      <div className="flex items-center justify-between px-6 py-3 bg-white/90 backdrop-blur border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center text-xl shadow-md">📕</div>
          <div><h1 className="text-base font-bold text-slate-800">小红书运营中心</h1><p className="text-xs text-slate-400">{activeTab.label}</p></div>
        </div>
        <button onClick={() => router.back()} className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">← 返回</button>
      </div>

      {/* 三栏布局 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧导航 */}
        <div className="w-[240px] flex-shrink-0 border-r border-slate-200 bg-white/60 flex flex-col p-3 gap-1.5">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1 px-2">运营能力</p>
          {TABS.map(m => (
            <button key={m.key} onClick={() => { setTab(m.key); if (m.key==='write') setStep('scene'); }}
              className={`text-left p-3 rounded-xl transition-all duration-150 border ${tab === m.key ? `${m.activeBg} shadow-sm` : 'border-transparent hover:bg-slate-50'}`}>
              <div className="flex items-center gap-2.5"><span className="text-lg">{m.icon}</span><span className={`text-sm font-semibold ${tab===m.key?'text-slate-800':'text-slate-600'}`}>{m.label}</span></div>
              <p className="text-xs text-slate-400 mt-1 ml-7">{m.desc}</p>
            </button>
          ))}
        </div>

        {/* 中间工作区 */}
        <div className="flex-1 overflow-y-auto p-6 custom-scroll max-w-4xl mx-auto w-full">
          {tab === 'write' && renderWriteTab()}
          {tab === 'calendar' && renderCalendarTab()}
          {tab === 'analytics' && renderAnalyticsTab()}
          {tab === 'drafts' && renderDraftsTab()}
        </div>

        {/* 右侧历史 */}
        <div className="w-[280px] flex-shrink-0 border-l border-slate-200 bg-white/60 flex flex-col">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-600">📋 笔记记录</span>
            <span className="text-[10px] text-slate-400">{noteHistory.length} 篇</span>
          </div>
          <div className="flex-1 overflow-y-auto custom-scroll p-2 space-y-1.5">
            {noteHistory.length===0 ? <div className="text-center py-12"><p className="text-3xl mb-2">📋</p><p className="text-xs text-slate-400">生成的笔记将显示在这里</p></div> :
             noteHistory.map(item => (
              <div key={item.id} className="p-3 rounded-xl hover:bg-slate-50 transition-colors">
                <p className="text-[11px] text-slate-400 mb-0.5">{item.time}</p>
                <p className="text-sm text-slate-600 font-medium truncate">{item.title}</p>
              </div>
            ))}
          </div>
          {noteHistory.length>0 && <div className="px-3 py-2 border-t border-slate-100"><button onClick={()=>{setNoteHistory([]);saveHistory([]);}} className="w-full text-center text-xs text-slate-400 hover:text-red-500 py-1">清空记录</button></div>}
        </div>
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );
}
