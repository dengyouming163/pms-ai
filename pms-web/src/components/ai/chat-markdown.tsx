'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/** 统一风格的外观组件 */
const mkComponents: Partial<Components> = {
  // 标题
  h2: ({ children, ...props }) => <h3 className="text-base font-bold text-slate-800 mt-4 mb-2 first:mt-0" {...props}>{children}</h3>,
  h3: ({ children, ...props }) => <h4 className="text-sm font-bold text-slate-800 mt-3 mb-1" {...props}>{children}</h4>,
  // 段落
  p: ({ children, ...props }) => <p className="text-sm leading-7 mb-2 last:mb-0" {...props}>{children}</p>,
  // 粗体
  strong: ({ children, ...props }) => <strong className="font-bold text-slate-900" {...props}>{children}</strong>,
  // 行内代码
  code: ({ className, children, ...props }: any) => {
    const isInline = !className;
    if (isInline) {
      return <code className="bg-slate-200 text-rose-600 px-1.5 py-0.5 rounded text-xs" {...props}>{children}</code>;
    }
    return <code className="text-xs" {...props}>{children}</code>;
  },
  // 代码块 (用 pre 包裹)
  pre: ({ children, ...props }) => (
    <pre className="bg-slate-800 text-emerald-300 rounded-lg p-3 my-3 overflow-x-auto text-xs leading-relaxed" {...props}>{children}</pre>
  ),
  // 无序列表
  ul: ({ children, ...props }) => <ul className="list-disc pl-5 my-2 space-y-0.5 text-sm leading-7" {...props}>{children}</ul>,
  // 有序列表
  ol: ({ children, ...props }) => <ol className="list-decimal pl-5 my-2 space-y-0.5 text-sm leading-7" {...props}>{children}</ol>,
  // 列表项
  li: ({ children, ...props }) => <li className="text-slate-700" {...props}>{children}</li>,
  // 引用
  blockquote: ({ children, ...props }) => (
    <blockquote className="border-l-3 border-emerald-400 pl-3 my-2 text-sm text-slate-500 italic" {...props}>{children}</blockquote>
  ),
  // 链接
  a: ({ children, ...props }) => <a className="text-emerald-600 underline hover:text-emerald-700" target="_blank" rel="noopener" {...props}>{children}</a>,
  // 表格
  table: ({ children, ...props }) => <div className="overflow-x-auto my-2"><table className="min-w-full text-sm border-collapse" {...props}>{children}</table></div>,
  thead: ({ children, ...props }) => <thead className="bg-slate-100" {...props}>{children}</thead>,
  th: ({ children, ...props }) => <th className="border border-slate-200 px-3 py-1.5 text-left text-xs font-semibold text-slate-600" {...props}>{children}</th>,
  td: ({ children, ...props }) => <td className="border border-slate-200 px-3 py-1.5 text-xs text-slate-700" {...props}>{children}</td>,
  // 分割线
  hr: (props) => <hr className="my-3 border-slate-200" {...props} />,
};

interface ChatMarkdownProps {
  content: string;
}

export function ChatMarkdown({ content }: ChatMarkdownProps) {
  return (
    <div className="assistant-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={mkComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
