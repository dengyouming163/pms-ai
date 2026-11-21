'use client';

import { useState, useRef, useEffect } from 'react';
import { streamAIChat } from '@/lib/ai/chat-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChatMarkdown } from '@/components/ai/chat-markdown';

interface Message { role: 'user' | 'assistant'; content: string; }

type TabKey = 'general' | 'ops' | 'customers';

interface CapabilityTag {
  label: string;
  prompt: string;
}

interface TagGroup {
  title: string;        // 分组标题，空字符串表示不显示
  tags: CapabilityTag[];
}

interface ScenarioConfig {
  key: TabKey;
  label: string;
  icon: string;
  contextMessage: string;
  groups: TagGroup[];
}

const SCENARIOS: ScenarioConfig[] = [
  {
    key: 'general', label: '通用', icon: '💬',
    contextMessage: '我是酒店经营者，请就我提出的问题给出专业建议。',
    groups: [{
      title: '',
      tags: [
        { label: '📊 经营日报', prompt: '今天整体经营怎么样？入住率、RevPAR、收入这些关键数据帮我汇总一下' },
        { label: '📈 收益趋势', prompt: '最近一周收益有什么变化？帮我分析趋势，看看哪里有增长空间' },
        { label: '🏨 入住率诊断', prompt: '当前入住率偏低，帮我诊断一下是什么原因，有什么改善建议' },
        { label: '⚠️ 异常预警', prompt: '帮我扫描一下，最近有没有哪些指标异常？超时订单、空置率、价格倒挂都帮我看看' },
        { label: '📋 多店对比', prompt: '各门店最近表现怎么样？帮我对比一下，看哪家做得好、哪家需要关注' },
      ],
    }],
  },
  {
    key: 'ops', label: '运营管家', icon: '🔧',
    contextMessage: '请扫描今日运营数据，帮我检查待入住/退房、脏房、超时订单和异常房间。',
    groups: [
      {
        title: '🔍 查状态',
        tags: [
          { label: '📊 状态概览', prompt: '给我一个完整的房态概览：可售、在住、脏房、维修、锁房各多少间' },
          { label: '🛎️ 今日到店', prompt: '今天有哪些客人要入住？帮我列出来，有没有特殊需求的' },
          { label: '🚪 今日离店', prompt: '今天哪些房间要退房？按时间排序帮我列一下，方便安排清洁' },
          { label: '🛏️ 在住房间', prompt: '现在有多少间在住的？分别在哪些楼层？有没有快到退房时间还没退的' },
          { label: '🧹 脏房列表', prompt: '目前有多少间脏房？分布在哪些楼层？帮我按退房时间排清洁优先级' },
          { label: '🔒 锁房列表', prompt: '当前锁了哪些房间？什么原因锁的？锁了多久了？' },
          { label: '🔧 维修列表', prompt: '哪些房间在维修中？分别什么问题？预计什么时候能恢复？' },
          { label: '📅 预订查询', prompt: '最近一周有哪些预订？帮我看看预订趋势和空房率' },
          { label: '⚡ 超时订单', prompt: 'OTA渠道有没有超时未确认的订单？哪些最紧急需要马上处理？' },
        ],
      },
      {
        title: '⚡ 执行操作',
        tags: [
          { label: '✅ 办理入住', prompt: '帮我办理入住，需要告诉我房号和客人姓名' },
          { label: '👋 办理退房', prompt: '帮我办理退房，告诉我哪个房间需要退' },
          { label: '🔄 换房', prompt: '客人需要换房，帮我把客人从当前房间换到新房间' },
          { label: '⏰ 续住', prompt: '这个房间的客人要续住，帮我把离店日期往后延' },
          { label: '📝 预订新房', prompt: '有新客人要预订，帮我登记一下房号、客人姓名和入住日期' },
          { label: '❌ 取消预订', prompt: '这个预订需要取消，帮我处理一下' },
          { label: '✏️ 修改预订', prompt: '这个预订信息有变动，帮我修改一下' },
          { label: '🔒 锁房', prompt: '这个房间需要锁起来暂停售卖，帮我锁一下' },
          { label: '🔓 开房', prompt: '这个锁着的房间可以重新卖了，帮我解锁恢复' },
          { label: '🧹 标记干净', prompt: '这个房间打扫完了，帮我标记为干净可入住' },
          { label: '🗑️ 标记脏房', prompt: '这个房间退房了需要打扫，帮我标记为脏房' },
          { label: '🔧 维修挂起', prompt: '这个房间出问题了需要维修，帮我标记为维修中' },
        ],
      },
    ],
  },
  {
    key: 'customers', label: '客户管家', icon: '👥',
    contextMessage: '请扫描客户数据库，找出沉睡客户、可升级VIP的客户、需要关怀提醒的客户。',
    groups: [{
      title: '',
      tags: [
        { label: '👤 客户总览', prompt: '帮我看看客户库的整体情况，VIP占比、复购率怎么样' },
        { label: '😴 沉睡客户', prompt: '哪些客户很久没来了？帮我找出超过90天的，看看怎么激活他们' },
        { label: '⭐ VIP管理', prompt: 'VIP客户最近入住情况怎么样？有没有快流失的？有没有可以升级的？' },
        { label: '💌 客户关怀', prompt: '帮我看看本周应该重点关怀哪些客户，给个具体方案' },
        { label: '📢 营销策略', prompt: '下个月营销怎么做？帮我按客户分层出个方案' },
      ],
    }],
  },
];

interface AiChatSidebarProps {
  defaultTab?: TabKey;
  placeholder?: string;
  className?: string;
}

export function AiChatSidebar({ defaultTab, placeholder = '输入指令...', className }: AiChatSidebarProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [progressHint, setProgressHint] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>(defaultTab || 'general');
  const [capExpanded, setCapExpanded] = useState(true);
  const tabInitializedRef = useRef<Set<TabKey>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages, streamingText]);

  const handleSend = async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || streaming) return;
    setInput(''); setStreaming(true); setStreamingText('');
    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    try {
      await streamAIChat(msg, messages.map(m => ({ role: m.role, content: m.content })), {
        onAgentStart: (_agent, action) => setProgressHint(action),
        onToken: (t) => { setProgressHint(''); setStreamingText(prev => prev + t); },
        onDone: (s) => {
          setMessages(prev => [...prev, { role: 'assistant', content: s }]);
          setStreamingText(''); setStreaming(false); setProgressHint('');
        },
        onError: (e) => {
          setMessages(prev => [...prev, { role: 'assistant', content: '❌ ' + e }]);
          setStreamingText(''); setStreaming(false); setProgressHint('');
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '未知错误';
      setMessages(prev => [...prev, { role: 'assistant', content: '❌ ' + msg }]);
      setStreamingText(''); setStreaming(false);
    }
  };

  // 点击标签：直接发送标签对应的提示词
  const handleTagClick = (prompt: string) => {
    handleSend(prompt);
  };

  // Tab 切换
  const handleTabChange = (tab: TabKey) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setMessages([]);
  };

  // Tab 切换后自动发送场景提示语（useEffect 确保 messages 已清空）
  useEffect(() => {
    if (!tabInitializedRef.current.has(activeTab)) {
      tabInitializedRef.current.add(activeTab);
      const scenario = SCENARIOS.find(s => s.key === activeTab);
      if (scenario) {
        handleSend(scenario.contextMessage);
      }
    }
  }, [activeTab]);

  const activeScenario = SCENARIOS.find(s => s.key === activeTab)!;

  return (
    <div className={`w-full xl:w-[880px] lg:w-[800px] flex-shrink-0 h-full flex flex-col bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden ${className || ''}`}>
      {/* 标题栏 */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2 flex-shrink-0 bg-slate-50/50">
        <span className="text-lg">🤖</span>
        <span className="text-sm font-semibold text-slate-600">AI 助手</span>
        <span className="text-[11px] text-slate-400 ml-auto">{activeScenario.label}模式</span>
      </div>

      {/* Tab 切换栏 */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-slate-100 bg-slate-50/30 flex-shrink-0">
        {SCENARIOS.map(s => (
          <button
            key={s.key}
            onClick={() => handleTabChange(s.key)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === s.key
                ? 'bg-white shadow-sm text-slate-700 border border-slate-200'
                : 'text-slate-400 hover:text-slate-600 hover:bg-white/50'
            }`}
          >
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {/* 能力标签（可折叠） */}
      <div className="px-3 py-2 border-b border-slate-100 bg-white flex-shrink-0">
        <button
          onClick={() => setCapExpanded(!capExpanded)}
          className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 mb-2"
        >
          我能帮你
          <svg className={`w-3 h-3 transition-transform ${capExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {capExpanded && (
          <div className="space-y-2">
            {activeScenario.groups.map((group, gi) => (
              <div key={gi}>
                {group.title && (
                  <div className="text-[10px] font-semibold text-slate-400 mb-1.5">{group.title}</div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {group.tags.map((tag, ti) => (
                    <button
                      key={ti}
                      onClick={() => handleTagClick(tag.prompt)}
                      disabled={streaming}
                      className="px-2.5 py-1 rounded-full text-[11px] bg-slate-50 border border-slate-200 text-slate-600 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {tag.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="pt-1.5 border-t border-slate-50 text-[11px] text-slate-400">
              💡 也可以直接输入你的问题
            </div>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4 custom-scroll">
        {messages.length === 0 && !streaming && (
          <div className="text-center py-12">
            <p className="text-3xl mb-2">{activeScenario.icon}</p>
            <p className="text-sm text-slate-400">AI {activeScenario.label}助手就绪</p>
            <p className="text-[11px] text-slate-300 mt-1">上方查看我能帮你做什么</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (i === 0 || messages[i-1]?.role !== 'assistant') && (
              <span className="text-lg mr-2 flex-shrink-0 mt-1">🤖</span>
            )}
            <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm ${
              m.role === 'user'
                ? 'bg-emerald-500 text-white rounded-br-md'
                : 'bg-slate-50 text-slate-700 rounded-bl-md border border-slate-100'
            }`}>
              {m.role === 'assistant'
                ? <ChatMarkdown content={m.content} />
                : <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
              }
            </div>
          </div>
        ))}
        {streaming && progressHint && !streamingText && (
          <div className="flex justify-start">
            {messages.length === 0 || messages[messages.length-1]?.role !== 'assistant' ? (
              <span className="text-lg mr-2 flex-shrink-0 mt-1">🤖</span>
            ) : null}
            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-slate-50 border border-slate-100 text-sm text-slate-400 italic flex items-center gap-2">
              {progressHint}<span className="inline-block w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
            </div>
          </div>
        )}
        {streaming && streamingText && (
          <div className="flex justify-start">
            {messages.length === 0 || messages[messages.length-1]?.role !== 'assistant' ? (
              <span className="text-lg mr-2 flex-shrink-0 mt-1">🤖</span>
            ) : null}
            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-slate-50 border border-slate-100 text-sm text-slate-700">
              <ChatMarkdown content={streamingText} />
              <span className="animate-pulse text-emerald-500">▌</span>
            </div>
          </div>
        )}
      </div>
      <div className="px-3 py-2.5 border-t border-slate-100 flex gap-2 flex-shrink-0">
        <Input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder={placeholder} disabled={streaming}
          className="flex-1 h-10 rounded-full border-slate-200 text-sm focus:border-emerald-500" />
        <Button onClick={() => handleSend()} disabled={!input.trim() || streaming} aria-label="发送消息"
          className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-400 text-white p-0 flex items-center justify-center">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7"/></svg>
        </Button>
      </div>
    </div>
  );
}
