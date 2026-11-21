'use client';

import { useRouter } from 'next/navigation';
import { AiChatSidebar } from '@/components/ai-workspace/ai-chat-sidebar';

/* ========== 功能卡片配置 ========== */
interface NavCard { icon: string; name: string; desc: string; route: string; }

const CARD_GROUPS: { title: string; cards: NavCard[] }[] = [
  {
    title: '📊 收益增长',
    cards: [
      { icon: '💰', name: 'AI 定价助手', desc: '智能调价 · 渠道优化 · 六维定价引擎', route: '/pricing-center' },
      { icon: '🔍', name: '竞品价格管理', desc: '对标分析 · 手动录价 · 自动引用', route: '/ai-workspace/competitor' },
    ],
  },
  {
    title: '✍️ 内容工厂',
    cards: [
      { icon: '🎬', name: '视频创作', desc: '口播脚本 · AI 配音 · 数字人', route: '/ai-workspace/promotion/video' },
      { icon: '📕', name: '小红书运营', desc: '写种草笔记 · 内容周历 · 数据分析', route: '/ai-workspace/xhs' },
      { icon: '🔊', name: '我的声音', desc: '声音复刻 · 音色管理 · 试听合成', route: '/ai-workspace/promotion/voice' },
    ],
  },
];

function AIWorkspaceContent() {
  const router = useRouter();
  const today = new Date();
  const todayStr = `${today.getMonth() + 1}月${today.getDate()}日 周${['日', '一', '二', '三', '四', '五', '六'][today.getDay()]}`;

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 text-slate-800 flex flex-col overflow-hidden">
      <div className="flex flex-1 gap-3 px-3 lg:px-5 py-3 min-h-0">

        {/* ======== 左侧：功能卡片区 ======== */}
          <div className="w-[260px] flex-shrink-0 flex flex-col min-h-0">
            {/* 顶部状态栏 */}
            <div className="mb-3 flex-shrink-0">
              <button
                onClick={() => router.push('/dashboard')}
                className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 hover:border-slate-300 hover:shadow-sm hover:text-slate-800 transition-all group"
              >
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-400 flex items-center justify-center text-sm shadow-sm shadow-emerald-500/20 group-hover:shadow-emerald-500/30 transition-shadow">
                  🏨
                </div>
                <span className="text-xs font-semibold">PMS 工作台</span>
                <svg className="w-3 h-3 ml-auto text-slate-300 group-hover:text-slate-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
            </div>
            {/* 卡片列表 */}
            <div className="flex-1 overflow-y-auto custom-scroll space-y-3 pr-1">

            {CARD_GROUPS.map(group => (
              <div key={group.title}>
                <h2 className="text-[11px] font-semibold text-slate-400 mb-1.5 px-0.5">{group.title}</h2>
                <div className="grid grid-cols-2 gap-1.5">
                  {group.cards.map(card => (
                    <button
                      key={card.route}
                      onClick={() => router.push(card.route)}
                      className="group flex flex-col items-center justify-center p-2.5 aspect-square bg-white rounded-xl border border-slate-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-150 text-center"
                    >
                      <span className="text-xl">{card.icon}</span>
                      <span className="text-xs font-semibold text-slate-600 mt-1 leading-tight">{card.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {/* 底部任务入口 */}
            <button
              onClick={() => router.push('/ai-workspace/tasks')}
              className="w-full text-center py-3 text-sm text-slate-400 hover:text-slate-600 transition-colors"
            >
              📋 查看全部 AI 任务记录 →
            </button>
            </div>
          </div>

          {/* ======== 右侧：AI 对话 ======== */}
          <AiChatSidebar placeholder="问任何经营问题..." className="flex-1 !w-auto min-w-0" />
      </div>

    </div>
  );
}

export default function AIWorkspacePage() {
  return <AIWorkspaceContent />;
}
