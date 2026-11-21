'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown' with { 'resolution-mode': 'import' };

interface Props { content: string; }

interface ModuleConfig { icon: string; title: string; bgClass: string; borderClass: string; accentClass: string; }

const MODULE_MAP: Record<string, ModuleConfig> = {
  '一句话概要': { icon: '📋', title: '一句话概要', bgClass: 'bg-gradient-to-br from-blue-50 to-indigo-50', borderClass: 'border-blue-300', accentClass: 'text-blue-700' },
  '口播文案': { icon: '🎙️', title: '口播文案（照着念）', bgClass: 'bg-gradient-to-br from-amber-50 to-yellow-50', borderClass: 'border-amber-300', accentClass: 'text-amber-700' },
  '拍摄清单': { icon: '✅', title: '拍摄清单（照着做）', bgClass: 'bg-gradient-to-br from-emerald-50 to-green-50', borderClass: 'border-emerald-300', accentClass: 'text-emerald-700' },
  '发布指南': { icon: '📊', title: '发布指南', bgClass: 'bg-gradient-to-br from-violet-50 to-purple-50', borderClass: 'border-violet-300', accentClass: 'text-violet-700' },
  '直播主题': { icon: '📋', title: '直播主题', bgClass: 'bg-gradient-to-br from-red-50 to-rose-50', borderClass: 'border-red-300', accentClass: 'text-red-700' },
  '直播时长与节奏': { icon: '⏱️', title: '时长与节奏', bgClass: 'bg-gradient-to-br from-orange-50 to-amber-50', borderClass: 'border-orange-300', accentClass: 'text-orange-700' },
  '直播话术脚本': { icon: '🗣️', title: '话术脚本（照着念）', bgClass: 'bg-gradient-to-br from-purple-50 to-violet-50', borderClass: 'border-purple-300', accentClass: 'text-purple-700' },
  '画面与场景安排': { icon: '🎬', title: '画面与场景', bgClass: 'bg-gradient-to-br from-sky-50 to-blue-50', borderClass: 'border-sky-300', accentClass: 'text-sky-700' },
  '准备清单': { icon: '🛠️', title: '准备清单', bgClass: 'bg-gradient-to-br from-slate-50 to-gray-50', borderClass: 'border-slate-300', accentClass: 'text-slate-700' },
  '执行Checklist': { icon: '✅', title: '执行Checklist', bgClass: 'bg-gradient-to-br from-emerald-50 to-green-50', borderClass: 'border-emerald-300', accentClass: 'text-emerald-700' },
};

function getModuleConfig(heading: string): ModuleConfig | null {
  for (const [key, config] of Object.entries(MODULE_MAP)) {
    if (heading.includes(key)) return config;
  }
  return null;
}

function splitModules(markdown: string): { heading: string; body: string; config: ModuleConfig | null }[] {
  const sections = markdown.split(/(?=^## )/m);
  return sections.filter(s => s.trim()).map(section => {
    const lines = section.trim().split('\n');
    const heading = lines[0].replace(/^## /, '').trim();
    const body = lines.slice(1).join('\n').trim();
    return { heading, body, config: getModuleConfig(heading) };
  });
}

function isTagLine(text: string): boolean {
  return /^#\S+/.test(text.trim()) && text.split('#').filter(Boolean).every(t => t.trim().length < 20);
}

const baseComponents: Components = {
  h2: ({ children }) => <h2 className="text-base font-extrabold text-slate-800 mb-3 mt-4 first:mt-0 tracking-tight">{children}</h2>,
  p: ({ children }) => {
    const text = String(children || '');
    if (isTagLine(text)) {
      const tags = text.split('#').filter(Boolean).map(t => t.trim());
      return <div className="flex flex-wrap gap-2 my-2">{tags.map((tag, i) => <span key={i} className="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-white border border-slate-200 text-slate-600 shadow-sm hover:border-rose-300 hover:text-rose-600 transition-colors cursor-default">#{tag}</span>)}</div>;
    }
    return <p className="text-sm text-slate-600 leading-relaxed mb-2 last:mb-0">{children}</p>;
  },
  strong: ({ children }) => <strong className="font-extrabold text-slate-800">{children}</strong>,
  em: ({ children }) => <em className="font-medium text-sky-600 not-italic">{children}</em>,
  li: ({ children }) => {
    const text = String(children || '');
    const match = text.match(/^(\d+)\.\s*(.*)/);
    if (match) {
      return <li className="flex items-start gap-3 mb-2 ml-0 list-none text-sm">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-xs font-extrabold flex-shrink-0 mt-0.5">{match[1]}</span>
        <span className="text-slate-700">{match[2]}</span>
      </li>;
    }
    return <li className="text-sm text-slate-600 leading-relaxed ml-4 mb-1.5">{children}</li>;
  },
  code: ({ children }) => <code className="px-1.5 py-0.5 rounded-md bg-slate-100 text-xs font-mono text-slate-700 border border-slate-200">{children}</code>,
  hr: () => <hr className="my-3 border-slate-200" />,
};

// 口播文案区域 — 大字 + 复制按钮
const scriptComponents: Components = {
  ...baseComponents,
  p: ({ children }) => {
    const text = String(children || '');
    const copyScript = () => { navigator.clipboard.writeText(text.replace(/<\/?[^>]+(>|$)/g, '')); };
    return (
      <div className="relative group">
        <p className="text-[15px] text-slate-700 leading-loose font-medium tracking-wide mb-2 last:mb-0 whitespace-pre-wrap">{children}</p>
        <button onClick={copyScript} className="absolute top-0 right-0 px-2 py-1 text-[10px] bg-white border border-slate-200 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-amber-600 hover:border-amber-300">📋 复制</button>
      </div>
    );
  },
  strong: ({ children }) => <strong className="font-extrabold text-amber-700 bg-amber-100/50 px-1 rounded">{children}</strong>,
};

export function ContentRenderer({ content }: Props) {
  const modules = splitModules(content);
  if (modules.length === 0 || modules.every(m => !m.config)) {
    return <div className="text-sm text-slate-700 leading-relaxed"><ReactMarkdown remarkPlugins={[remarkGfm]} components={baseComponents}>{content}</ReactMarkdown></div>;
  }
  return (
    <div className="space-y-4">
      {modules.map((mod, i) => {
        if (!mod.config) {
          return <div key={i} className="text-sm text-slate-600 leading-relaxed px-1"><ReactMarkdown remarkPlugins={[remarkGfm]} components={baseComponents}>{mod.heading ? `## ${mod.heading}\n${mod.body}` : mod.body}</ReactMarkdown></div>;
        }
        const { icon, title, bgClass, borderClass, accentClass } = mod.config;
        const isScript = title.includes('口播文案') || title.includes('话术脚本');
        const components = isScript ? scriptComponents : baseComponents;
        return (
          <div key={i} className={`rounded-2xl border-2 p-5 ${bgClass} ${borderClass} shadow-sm`}>
            <div className="flex items-center gap-2.5 mb-4 pb-3 border-b border-slate-200/60">
              <span className="text-xl">{icon}</span>
              <h4 className={`font-extrabold text-sm tracking-tight ${accentClass}`}>{title}</h4>
            </div>
            <div><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{mod.body}</ReactMarkdown></div>
          </div>
        );
      })}
    </div>
  );
}
