'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useMode } from '@/lib/context/mode-context';
import { streamAIChat } from '@/lib/ai/chat-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

import { ChatMarkdown } from '@/components/ai/chat-markdown';

const QUICK_PROMPTS = [
  { label: '今天怎么样？', message: '今天酒店整体经营情况怎么样？' },
  { label: '最近收益如何？', message: '帮我分析一下最近的收益情况' },
  { label: '帮我看看定价', message: '目前的定价策略有什么优化建议吗？' },
  { label: '有没有异常？', message: '最近有什么需要我关注的异常情况吗？' },
];

export function AIChatPanel({ onClose }: { onClose?: () => void }) {
  const { isAIMode } = useMode();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [currentAgent, setCurrentAgent] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, streamingText]);

  const handleSend = useCallback(async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || streaming) return;
    setInput('');
    setStreaming(true);
    setStreamingText('');
    setCurrentAgent('经营参谋长');
    const userMsg: Message = { role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    try {
      await streamAIChat(msg, history, {
        onAgentStart: (agent, action) => setCurrentAgent(`${agent} · ${action}`),
        onToken: (text) => { setCurrentAgent(''); setStreamingText(prev => prev + text); },
        onDone: (summary) => {
          setMessages(prev => [...prev, { role: 'assistant', content: summary }]);
          setStreamingText('');
          setStreaming(false);
        },
        onError: (error) => {
          setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${error}` }]);
          setStreamingText('');
          setStreaming(false);
        },
      });
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${err.message}` }]);
      setStreamingText('');
      setStreaming(false);
    }
  }, [input, messages, streaming]);

  if (!isAIMode) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <p className="text-muted-foreground mb-4">AI 模式未开启</p>
        <p className="text-xs text-muted-foreground">请在设置中切换到 AI Agent 模式</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="p-4 border-b flex items-center justify-between bg-white">
        <div>
          <h3 className="font-semibold text-sm">AI 助手</h3>
          {currentAgent && streaming && (
            <p className="text-xs text-muted-foreground">{currentAgent} 正在分析...</p>
          )}
        </div>
        {onClose && <Button variant="ghost" size="sm" onClick={onClose}>&#10005;</Button>}
      </div>
      <ScrollArea ref={scrollRef} className="flex-1 p-4">
        {messages.length === 0 && !streaming && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">你好！我是你的 AI 经营助手</p>
            <div className="flex flex-wrap gap-2">
              {QUICK_PROMPTS.map(p => (
                <button key={p.label} onClick={() => handleSend(p.message)}
                  className="px-3 py-1.5 text-xs border rounded-full hover:bg-muted transition-colors">
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`mb-4 ${m.role === 'user' ? 'text-right' : ''}`}>
            <div className={`inline-block max-w-[85%] p-3 rounded-xl text-sm ${
              m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
              {m.role === 'assistant'
                ? <ChatMarkdown content={m.content} />
                : <div className="whitespace-pre-wrap">{m.content}</div>
              }
            </div>
          </div>
        ))}
        {streaming && streamingText && (
          <div className="mb-4">
            <div className="inline-block max-w-[85%] p-3 rounded-xl text-sm bg-muted">
              <ChatMarkdown content={streamingText} />
              <span className="animate-pulse">&#9612;</span>
            </div>
          </div>
        )}
      </ScrollArea>
      <div className="p-4 border-t">
        <form onSubmit={e => { e.preventDefault(); handleSend(); }} className="flex gap-2">
          <Input value={input} onChange={e => setInput(e.target.value)}
            placeholder="输入你的问题..." disabled={streaming} className="flex-1" />
          <Button type="submit" disabled={!input.trim() || streaming}>
            {streaming ? '⏳' : '发送'}
          </Button>
        </form>
      </div>
    </div>
  );
}
