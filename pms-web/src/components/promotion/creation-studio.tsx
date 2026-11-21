'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { streamAIChat } from '@/lib/ai/chat-client';
import { apiGet, apiPost, apiDelete } from '@/lib/api-client';
import { Loader2, Plus } from 'lucide-react';
import { ContentRenderer } from './content-renderer';
import { SessionManager, type SessionInfo } from './session-manager';
import { showToast, ToastContainer } from './toast';

interface Message { role: 'user' | 'assistant'; content: string; titles?: string[]; tags?: string; }

export interface ScriptVariant { script: string; shots: string; titles: string[]; music: string; tags: string; }
interface Props { onFlow?: (target: string, script: ScriptVariant) => void; }

export function CreationStudio(_props: Props) {
  const [storeInfo, setStoreInfo] = useState({ name: '', features: '', roomTypes: '', address: '' });
  const [hotTopics, setHotTopics] = useState<Array<{ label: string; icon: string; prompt: string }>>([]);
  const [topicsLoading, setTopicsLoading] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const sessionBarRef = useRef<HTMLDivElement>(null);
  const sessionTitle = sessions.find(s => s.id === sessionId)?.title || '新对话';

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages, streamingText]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sessionBarRef.current && !sessionBarRef.current.contains(e.target as Node)) {
        setSessionPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    apiGet('/api/stores').then((d: any) => {
      if (d?.length > 0) {
        const s = d[0];
        apiGet('/api/stores?type=roomTypes&storeId=' + s.id).then((rt: any) => {
          setStoreInfo({ name: s.name || '我的民宿', address: s.address || '', features: (s.facilities || []).join('、'), roomTypes: (rt || []).map((r: any) => r.name).join('、') || '大床房、双床房' });
        }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  // 加载今日热点
  useEffect(() => {
    setTopicsLoading(true);
    apiGet('/api/hot-topics/today').then((d: any) => {
      if (d.success && d.data?.length) setHotTopics(d.data);
    }).catch(() => {}).finally(() => setTopicsLoading(false));
  }, []);

  const refreshTopics = () => {
    setTopicsLoading(true);
    apiGet('/api/hot-topics/today?refresh=1').then((d: any) => {
      if (d.success && d.data?.length) setHotTopics(d.data);
    }).catch(() => {}).finally(() => setTopicsLoading(false));
  };

  const loadSessions = useCallback(async () => {
    try {
      const data = await apiGet('/api/creation-sessions?limit=50');
      if (data.success) setSessions(data.data || []);
    } catch { /* 加载会话列表失败不影响使用 */ }
  }, []);
  useEffect(() => { loadSessions(); }, [loadSessions]);

  const handleCreateSession = async () => {
    try {
      const data = await apiPost('/api/creation-sessions', { title: '新对话', platform: '抖音' });
      if (data.success) { setSessionId(data.data.id); setMessages([]); setStreamingText(''); loadSessions(); }
    } catch { /* 创建失败静默处理 */ }
  };

  const handleSelectSession = async (session: SessionInfo) => {
    setSessionId(session.id);
    try {
      const data = await apiGet(`/api/creation-sessions/${session.id}`);
      if (data.success && data.data.messages) {
        setMessages(data.data.messages.map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content || '' })));
      } else { setMessages([]); }
    } catch { setMessages([]); }
  };

  const saveMessage = async (role: 'user' | 'assistant', content: string) => {
    if (!sessionId) return;
    try { await apiPost(`/api/creation-sessions/${sessionId}/messages`, { role, content }); } catch { /* 保存失败不影响使用 */ }
  };

  const handleDeleteSession = async (id: string) => {
    try {
      await apiDelete(`/api/creation-sessions/${id}`);
      if (sessionId === id) { setSessionId(null); setMessages([]); }
      loadSessions();
    } catch { /* 删除失败静默处理 */ }
  };

  const buildScenePrompt = (topic: string) => {
    const n = storeInfo.name || '精品民宿';
    const r = storeInfo.roomTypes || '大床房、双床房';
    const f = storeInfo.features || '舒适环境、贴心服务';

    return `你是民宿老板的短视频创作助手。根据以下信息生成一条可以直接拍摄的短视频分镜脚本。

【民宿信息】
名称：${n}
房型：${r}
特色：${f}

【创作方向】
${topic}

【输出要求】
严格按以下格式输出，不要加任何额外的解释和说明：

## 📋 一句话概要
标题：（10-20字的吸引人标题）

## 🎬 分镜脚本
### 镜1 | {镜头名} | ⏱{秒数}秒
镜头：{具体的拍摄指引，包括机位、运镜、光线}
口播：{这段画面配的口播文案}

### 镜2 | {镜头名} | ⏱{秒数}秒
镜头：...
口播：...

（共5-8个镜头，每段口播15-40字，总时长30-90秒）

【口播要求】
- 口语化、自然，像对着朋友说话
- 有开头钩子+中间展示+结尾行动号召
- 适合短视频带货风格
- 每段口播独立完整，用换行分隔

【⚠️ 重要】在整段回复的最后，追加一个 JSON 代码块，包含结构化数据，格式如下：
\`\`\`json
{
  "title": "完整标题",
  "shortTitle": "短视频标题（8-12字）",
  "shots": [
    {"index":1, "label":"镜头名", "script":"口播文案", "duration":5, "cameraHint":"镜头指引"},
    {"index":2, "label":"镜头名", "script":"口播文案", "duration":7, "cameraHint":"镜头指引"}
  ]
}
shortTitle 用于视频片头字幕显示，必须精简到8-12个汉字
\`\`\`
JSON 数据必须与上方的分镜脚本完全一致，不要省略任何字段。`;
	  };

  const doGenerate = async (prompt: string) => {
    setStreaming(true); setStreamingText('');
    // 把格式指令和话题合并成一条消息，确保 AI 不会忽略格式
    const fullMessage = buildScenePrompt(prompt);
    const history = messages.slice(-6).map(m => ({ role: m.role as 'user' | 'assistant', content: (m.content || '').slice(0, 300) }));
    try {
      await streamAIChat(fullMessage, history, {
        onToken: (t) => { setStreamingText((prev) => prev + t); },
        onDone: (s) => { setMessages(prev => [...prev, { role: 'assistant', content: s }]); setStreaming(false); setStreamingText(''); saveMessage('assistant', s); loadSessions(); },
        onError: (e) => { setStreaming(false); setStreamingText(''); },
      });
    } catch (e: any) { setStreaming(false); setStreamingText(''); }
  };

  // 一键保存方案到创作记录
  const handleSavePlan = async (content: string) => {
    try {
      const titleMatch = content.match(/## 📋[^\n]*\n(.+)/);
      const title = titleMatch?.[1]?.trim()?.slice(0, 30) || `方案 ${new Date().toLocaleDateString()}`;
      const clean = content.replace(/^## /gm, "").trim();
      await apiPost("/api/creation-records", { type: "copy", title, script: clean.slice(0, 5000), tags: "", titles: [title] });
      showToast("已保存到创作记录", "success");
      window.dispatchEvent(new CustomEvent("pms:refresh-history"));
    } catch { showToast("保存失败，请重试", "error"); }
  };

  const handleSend = () => {
    const msg = input.trim(); if (!msg || streaming) return;
    if (!sessionId) {
      handleCreateSession().then(() => {
        setTimeout(() => { setMessages(prev => [...prev, { role: 'user', content: msg }]); setInput(''); saveMessage('user', msg); doGenerate(msg); }, 100);
      });
      return;
    }
    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    setInput(''); saveMessage('user', msg); doGenerate(msg);
  };

  return (
    <div className="flex gap-3 h-full">
      {/* 左侧栏：今日热点 */}
      <div className="w-72 flex-shrink-0 flex flex-col">
        <div className="bg-gradient-to-b from-sky-50 to-white rounded-3xl border border-sky-200 p-4 flex-1 flex flex-col overflow-hidden shadow-sm">
          <div className="flex items-center justify-between mb-3 flex-shrink-0">
            <p className="text-xs font-semibold text-slate-500">🔥 今日热点</p>
            <button onClick={refreshTopics} disabled={topicsLoading}
              className={`text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-500 hover:bg-sky-100 ${topicsLoading ? 'animate-spin' : ''}`}>
              🔄
            </button>
          </div>
          <div className="flex-1 overflow-y-auto custom-scroll space-y-2">
            {topicsLoading ? (
              Array.from({length: 6}).map((_, i) => (
                <div key={i} className="p-3 rounded-xl border border-sky-100 bg-white animate-pulse">
                  <div className="h-3 bg-slate-100 rounded w-3/4 mb-1.5" />
                  <div className="h-2.5 bg-slate-50 rounded w-full" />
                </div>
              ))
            ) : (
              hotTopics.map((t, i) => (
                <button key={i} onClick={() => { setInput(t.prompt); doGenerate(t.prompt); }}
                  className="w-full text-left p-3 rounded-xl border border-sky-100 bg-white hover:border-sky-300 hover:shadow-md transition-all group">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-base">{t.icon}</span>
                    <span className="text-sm font-bold text-slate-700 group-hover:text-sky-600 truncate">{t.label}</span>
                  </div>
                  <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{t.prompt}</p>
                </button>
              ))
            )}
            {!topicsLoading && hotTopics.length === 0 && (
              <p className="text-xs text-slate-400 text-center py-8">热点加载失败，请点击刷新</p>
            )}
          </div>
        </div>
      </div>

      {/* 右侧面板：AI 对话 */}
      <div className="flex-1 flex flex-col min-w-0 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-white/80 flex-shrink-0">
          <span className="text-sm font-semibold text-slate-500">💬 AI 创作助手</span>
          <button onClick={handleCreateSession} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-sky-600 bg-sky-50 hover:bg-sky-100 rounded-xl transition-colors"><Plus className="w-3.5 h-3.5" /> 新对话</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scroll" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center h-full text-slate-300 gap-2">
              <div className="text-5xl">💬</div>
              <p className="text-sm">从左侧选择话题，或直接输入创作主题</p>
              {!sessionId && <p className="text-xs text-slate-400 mt-1">发送第一条消息后将自动创建会话</p>}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'user' ? (
                <div className="max-w-[80%] bg-sky-500 text-white rounded-2xl rounded-br-md px-4 py-3 text-sm shadow-sm">{m.content}</div>
              ) : (
                <div className="max-w-[90%]">
                  <div className="bg-slate-50 rounded-2xl rounded-bl-md px-5 py-4 shadow-sm"><ContentRenderer content={m.content} /></div>
                  <button
                    onClick={() => handleSavePlan(m.content)}
                    className="mt-1.5 text-[11px] px-3 py-1 bg-white border border-slate-200 rounded-lg text-slate-400 hover:text-sky-600 hover:border-sky-300 transition-colors"
                  >
                    💾 一键保存
                  </button>
                </div>
              )}
            </div>
          ))}
          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[90%] bg-slate-50 rounded-2xl rounded-bl-md px-5 py-4 min-w-[160px] shadow-sm">
                {streamingText ? (
                  <div className="text-sm text-slate-700 leading-relaxed"><ContentRenderer content={streamingText} /><span className="inline-block w-2 h-4 bg-sky-500 ml-0.5 animate-pulse rounded-sm align-middle" /></div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" />AI 正在创作...</div>
                )}
              </div>
            </div>
          )}
        </div>
        {/* 底部输入框 */}
        <div className="flex-shrink-0 p-3 border-t border-slate-100">
          <div className="flex gap-2">
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder="描述你想拍的视频，或点击左侧热点..."
              disabled={streaming}
              className="flex-1 px-4 py-3 border border-slate-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20 disabled:bg-slate-50" />
            <button onClick={handleSend}
              disabled={!input.trim() || streaming}
              className="px-4 py-3 bg-gradient-to-r from-sky-500 to-blue-600 text-white rounded-2xl shadow-md hover:shadow-lg disabled:opacity-50">
              🎬
            </button>
          </div>
        </div>
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
      <ToastContainer />
    </div>
  );
}
