'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { toast } from 'sonner';
import { CustomerStatsBar } from '@/components/ai-workspace/customer-stats-bar';
import { CustomerList } from '@/components/ai-workspace/customer-list';
import { CustomerDetailPanel } from '@/components/ai-workspace/customer-detail-panel';
import { AiChatSidebar } from '@/components/ai-workspace/ai-chat-sidebar';
import { AiInsightCard } from '@/components/ai-workspace/ai-insight-card';

export default function CustomersPage() {
  const router = useRouter();

  const [stats, setStats] = useState<any>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [insights, setInsights] = useState<Array<{ icon: string; title: string; desc: string; actionLabel: string; toolName: string; params: Record<string, any> }>>([]);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const d = await apiGet('/api/customers?type=stats');
      setStats(d);
      const newInsights: typeof insights = [];
      if (d.dormantCount > 0) {
        newInsights.push({ icon: '😴', title: `${d.dormantCount} 位沉睡客户`, desc: '超过90天未入住，存在流失风险', actionLabel: '一键批量关怀', toolName: 'batch_care', params: { level: 'dormant' } });
      }
      if (d.vipCount > 0) {
        newInsights.push({ icon: '⭐', title: `${d.vipCount} 位 VIP 客户`, desc: '建议定期维护VIP关系，提升忠诚度', actionLabel: '查看VIP列表', toolName: 'filter', params: { filter: 'vip' } });
      }
      if (d.carePending && d.carePending > 0) {
        newInsights.push({ icon: '💌', title: `${d.carePending} 条待处理关怀`, desc: '有未完成的客户关怀提醒', actionLabel: '查看待关怀', toolName: 'filter', params: { filter: 'care' } });
      }
      setInsights(newInsights);
    } catch (e) { setError('统计数据加载失败'); console.error('Failed to load stats:', e); }
  }, []);

  const loadCustomers = useCallback(async (page = 1, kw = keyword, filter = activeFilter) => {
    setLoading(true);
    try {
      const levelFilter = filter === 'vip' ? 'diamond,gold' : '';
      const params = new URLSearchParams();
      params.set('page', String(page));
      // 对于需要客户端过滤的标签，拉取更多数据
      if (filter === 'dormant' || filter === 'new' || filter === 'care') {
        params.set('limit', '200');
      } else {
        params.set('limit', '20');
      }
      if (kw) params.set('keyword', kw);
      if (levelFilter) params.set('level', levelFilter);

      const d = await apiGet(`/api/customers?${params.toString()}`);
      let result = d.customers || [];

      // 客户端侧过滤
      if (filter === 'dormant') {
        const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
        result = result.filter((c: any) => {
          if (!c.lastStayDate) return true;
          return c.lastStayDate < ninetyDaysAgo;
        });
      } else if (filter === 'new') {
        const now = new Date();
        result = result.filter((c: any) => {
          const d2 = new Date(c.createdAt);
          return d2.getMonth() === now.getMonth() && d2.getFullYear() === now.getFullYear();
        });
      } else if (filter === 'care') {
        // 从关怀提醒接口获取待处理的客户ID列表
        try {
          const careData = await apiGet('/api/customers?type=care');
          const reminders = (careData as any).reminders || [];
          const careIds = new Set(reminders.filter((r: any) => r.status === 'pending').map((r: any) => r.customerId));
          result = result.filter((c: any) => careIds.has(c.id));
        } catch {
          // 关怀数据加载失败，显示全部客户
        }
      }

      setCustomers(result);
      setPagination(d.pagination || { page: 1, total: result.length, totalPages: Math.ceil(result.length / 20) });
    } catch (e) { setError('客户列表加载失败'); console.error('Failed to load customers:', e); }
    setLoading(false);
  }, [keyword, activeFilter]);

  useEffect(() => { loadStats(); loadCustomers(); }, []);

  const handleFilterClick = (filter: string) => {
    setActiveFilter(filter);
    loadCustomers(1, keyword, filter);
  };

  const handleActionExecute = async (toolName: string, params: Record<string, any>) => {
    if (toolName === 'batch_care') {
      try {
        const d = await apiGet(`/api/customers?level=dormant&limit=50`);
        const dormantCustomers = (d as any).customers || [];
        await Promise.all(dormantCustomers.map((c: any) =>
          apiPost('/api/customers', { action: 'sendCare', customerId: c.id, customerName: c.name, type: 'rebuy', content: '系统检测到您已超过90天未入住，为您准备了一张专属优惠券，欢迎再次光临！', dueDate: new Date().toISOString().split('T')[0] })
        ));
        toast.success(`已为 ${dormantCustomers.length} 位沉睡客户发送关怀提醒`);
        loadStats();
      } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    } else if (toolName === 'filter') {
      setActiveFilter(params.filter);
      loadCustomers(1, keyword, params.filter);
    }
  };

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50 flex flex-col">
      <div className="flex items-center justify-between px-5 py-2.5 bg-white/90 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-lg shadow-md">🤝</div>
          <div>
            <h1 className="text-base font-bold text-slate-800">AI 客户管理中心</h1>
            <p className="text-xs text-slate-400">客户总览 · VIP管理 · 客户关怀</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => router.back()} className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">← 返回</button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl flex items-center justify-between">
          <span className="text-sm text-red-600">{error}</span>
          <button onClick={() => { setError(null); loadStats(); loadCustomers(); }}
            className="text-xs px-3 py-1 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 font-medium">重试</button>
        </div>
      )}

      <CustomerStatsBar stats={stats} onFilterClick={handleFilterClick} />

      {insights.length > 0 && (
        <div className="flex gap-2 px-4 py-2 flex-shrink-0 overflow-x-auto">
          {insights.map((ins, i) => (
            <AiInsightCard key={i} icon={ins.icon} title={ins.title} description={ins.desc} actionLabel={ins.actionLabel} onAction={() => handleActionExecute(ins.toolName, ins.params)} variant={ins.icon === '😴' ? 'warning' : ins.icon === '⭐' ? 'info' : 'success'} />
          ))}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <CustomerList customers={customers} pagination={pagination} loading={loading} activeFilter={activeFilter} onSearch={(kw) => { setKeyword(kw); loadCustomers(1, kw, activeFilter); }} onFilterChange={(f) => { setActiveFilter(f); loadCustomers(1, keyword, f); }} onPageChange={(p) => loadCustomers(p)} onSelectCustomer={(c) => setSelectedCustomerId(c.id)} />
        <AiChatSidebar defaultTab="customers" placeholder="输入客户管理指令..." />
      </div>

      <CustomerDetailPanel customerId={selectedCustomerId || ''} open={!!selectedCustomerId} onClose={() => setSelectedCustomerId(null)} />
    </div>
  );
}
