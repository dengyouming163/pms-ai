'use client';

import { useState, useEffect, useMemo } from 'react';
import { PageHeader } from '@/components/page-header';
import { TabBar } from '@/components/tab-bar';
import {
  Users, Tag, Search, Phone, Mail, MessageSquare,
  Star, Edit3, Trash2, UserPlus, Crown, Heart,
  TrendingUp, Clock, AlertTriangle, ChevronRight,
  Sparkles, Award, BarChart3, Calendar, FileText,
  X, Check, Zap, Eye, Copy, Send, Plus, Settings2
} from 'lucide-react';
import { isValidPhone, isValidIdCard, validateRequired } from '@/lib/utils/validation';
import { apiGet, apiPost } from '@/lib/api-client';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { CustomerInsights } from '@/components/ai/customer-insights';

const tabs = [
  { key: 'list', label: '客户列表' },
  { key: 'tags', label: '智能标签' },
  { key: 'care', label: '客户关怀' },
];

/* eslint-disable @typescript-eslint/no-explicit-any */

const tagColorMap: Record<string, { bg: string; text: string; border: string }> = {
  'VIP': { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  '常客': { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  '新客': { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
  '投诉敏感': { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  '商务客户': { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
  '家庭客户': { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200' },
  '网红客': { bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200' },
  '待激活': { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200' },
};

const memberLevelConfig: Record<string, { bg: string; text: string; border: string }> = {
  'silver': { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-300' },
  'gold': { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  'platinum': { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
};

const careTypeConfig: Record<string, { icon: any; color: string; bg: string; label: string }> = {
  'birthday': { icon: Heart, color: 'text-pink-500', bg: 'bg-pink-50', label: '生日关怀' },
  'rebuy': { icon: TrendingUp, color: 'text-amber-500', bg: 'bg-amber-50', label: '复购提醒' },
  'upgrade': { icon: Crown, color: 'text-purple-500', bg: 'bg-purple-50', label: '升级促活' },
  'complaint': { icon: AlertTriangle, color: 'text-red-500', bg: 'bg-red-50', label: '投诉跟进' },
};

export default function CustomersPage() {
  const [activeTab, setActiveTab] = useState('list');
  const [customers, setCustomers] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [tags, setTags] = useState<any[]>([]);
  const [careReminders, setCareReminders] = useState<any[]>([]);
  const [autoRules, setAutoRules] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');

  // 分页状态
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  // 客户详情弹窗
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null);
  const [customerDetail, setCustomerDetail] = useState<any>(null);

  // 添加客户弹窗
  const [showAdd, setShowAdd] = useState(false);

  // 编辑标签弹窗
  const [showEditTag, setShowEditTag] = useState(false);
  const [editTagForm, setEditTagForm] = useState({ tagId: '', name: '', color: '', description: '' });

  // 添加自动规则弹窗
  const [showAddRule, setShowAddRule] = useState(false);
  const [addRuleForm, setAddRuleForm] = useState({ name: '', rule: '', field: '', tag: '' });

  // 查看标签下客户弹窗
  const [showTagCustomers, setShowTagCustomers] = useState(false);
  const [tagCustomersList, setTagCustomersList] = useState<{ tag: string; customers: any[] }>({ tag: '', customers: [] });
  const [channelList, setChannelList] = useState<{ name: string }[]>([]);
  const [addForm, setAddForm] = useState({
    name: '', phone: '', gender: '男', birthday: '', idCard: '',
    source: '直营', remark: '',
    preferenceInput: '', preferences: [] as string[],
    tagInput: '', tags: [] as string[],
  });
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});

  // 编辑客户弹窗
  const [showEditCustomer, setShowEditCustomer] = useState(false);
  const [editForm, setEditForm] = useState({
    id: '', name: '', phone: '', gender: '男', birthday: '', idCard: '',
    source: '直营', remark: '',
    preferenceInput: '', preferences: [] as string[],
    tagInput: '', tags: [] as string[],
  });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const openEditCustomer = (customer: any) => {
    setEditForm({
      id: customer.id, name: customer.name, phone: customer.phone,
      gender: customer.gender || '男', birthday: customer.birthday || '',
      idCard: customer.idCard || '', source: customer.source || '直营',
      remark: customer.remark || '',
      preferenceInput: '', preferences: customer.preferences || [],
      tagInput: '', tags: customer.tags || [],
    });
    setEditErrors({});
    setShowEditCustomer(true);
  };

  // 刷新标签数据
  const refreshTags = () => {
    apiGet('/api/customers?type=tags').then(d => setTags(d.tags));
  };

  // 刷新关怀数据
  const refreshCare = () => {
    apiGet('/api/customers?type=care').then(d => setCareReminders(d.reminders));
  };

  // 刷新自动规则
  const refreshAutoRules = () => {
    apiGet('/api/customers?type=auto-rules').then(d => setAutoRules(d.rules));
  };

  useEffect(() => {
    apiGet('/api/customers?type=list').then(d => { setCustomers(d.customers); setStats(d.stats); });
    apiGet('/api/channels').then((d: any) => setChannelList(d.channels || []));
    refreshTags();
    refreshCare();
    refreshAutoRules();
  }, []);

  // 打开客户详情
  const openCustomerDetail = (customer: any) => {
    setSelectedCustomer(customer);
    apiGet(`/api/customers?type=detail&id=${customer.id}`).then(d => setCustomerDetail(d));
  };

  const filteredCustomers = useMemo(() => {
    return customers.filter(c => {
      const matchSearch = !search || c.name.includes(search) || c.phone.includes(search);
      const matchTag = tagFilter === 'all' || c.tags.includes(tagFilter);
      const matchLevel = levelFilter === 'all' || c.memberLevel?.key === levelFilter || c.memberLevel === levelFilter;
      return matchSearch && matchTag && matchLevel;
    });
  }, [customers, search, tagFilter, levelFilter]);

  // 价值评分颜色
  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-emerald-600';
    if (score >= 50) return 'text-amber-600';
    return 'text-slate-500';
  };
  const getScoreBg = (score: number) => {
    if (score >= 80) return 'bg-emerald-50';
    if (score >= 50) return 'bg-amber-50';
    return 'bg-slate-50';
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Users className="w-5 h-5" />}
        title="客户管理"
        action={{ label: '添加客户', onClick: () => { setShowAdd(true); setAddErrors({}); setAddForm({ name: '', phone: '', gender: '男', birthday: '', idCard: '', source: '直营', remark: '', preferenceInput: '', preferences: [], tagInput: '', tags: [] }); } }}
      />
      <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />
      <CustomerInsights customers={[]} />

      {/* ============ 客户列表 ============ */}
      {activeTab === 'list' && stats && (
        <div className="space-y-5">
          {/* 统计卡片 */}
          <div className="grid grid-cols-6 gap-3">
            <div className="bg-white rounded-2xl border border-slate-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center"><Users className="w-5 h-5 text-emerald-600" /></div>
              <div><div className="text-xl font-bold text-slate-800">{stats.total}</div><div className="text-xs text-slate-500">客户总数</div></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center"><UserPlus className="w-5 h-5 text-blue-600" /></div>
              <div><div className="text-xl font-bold text-slate-800">{stats.newThisMonth}</div><div className="text-xs text-slate-500">本月新客</div></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center"><Crown className="w-5 h-5 text-amber-600" /></div>
              <div><div className="text-xl font-bold text-slate-800">{stats.vipCount}</div><div className="text-xs text-slate-500">VIP客户</div></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center"><Star className="w-5 h-5 text-green-600" /></div>
              <div><div className="text-xl font-bold text-slate-800">{stats.regularCount}</div><div className="text-xs text-slate-500">常客</div></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-rose-50 rounded-xl flex items-center justify-center"><Heart className="w-5 h-5 text-rose-500" /></div>
              <div><div className="text-xl font-bold text-slate-800">{stats.carePending}</div><div className="text-xs text-slate-500">待关怀</div></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center"><BarChart3 className="w-5 h-5 text-purple-600" /></div>
              <div><div className="text-xl font-bold text-slate-800">{stats.avgValueScore}</div><div className="text-xs text-slate-500">平均价值分</div></div>
            </div>
          </div>

          {/* 搜索和筛选 */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 max-w-xs">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                placeholder="搜索姓名/手机号"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="all">全部标签</option>
              {tags.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
            <select
              className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
            >
              <option value="all">全部等级</option>
              <option value="silver">银卡</option>
              <option value="gold">金卡</option>
              <option value="platinum">白金卡</option>
            </select>
            <div className="text-xs text-slate-400 ml-auto">{filteredCustomers.length} 位客户</div>
          </div>

          {/* 客户列表 */}
          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-5 py-3 font-medium text-slate-600">客户</th>
                  <th className="text-left px-3 py-3 font-medium text-slate-600">会员</th>
                  <th className="text-center px-3 py-3 font-medium text-slate-600">价值分</th>
                  <th className="text-left px-3 py-3 font-medium text-slate-600">标签</th>
                  <th className="text-center px-3 py-3 font-medium text-slate-600">入住</th>
                  <th className="text-right px-3 py-3 font-medium text-slate-600">累计消费</th>
                  <th className="text-left px-3 py-3 font-medium text-slate-600">最近入住</th>
                  <th className="text-left px-3 py-3 font-medium text-slate-600">偏好</th>
                  <th className="text-center px-3 py-3 font-medium text-slate-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredCustomers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/50 transition-colors cursor-pointer" onClick={() => openCustomerDetail(c)}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center font-bold text-xs">{c.name[0]}</div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-slate-800">{c.name}</span>
                            <span className="text-xs text-slate-400">{c.gender}</span>
                          </div>
                          <div className="text-xs text-slate-400 font-mono">{c.phone}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${memberLevelConfig[c.memberLevel?.key]?.bg || 'bg-slate-50'} ${memberLevelConfig[c.memberLevel?.key]?.text || 'text-slate-600'} ${memberLevelConfig[c.memberLevel?.key]?.border || 'border-slate-200'}`}>
                        {c.memberLevel?.icon} {c.memberLevel?.name}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-xs font-bold ${getScoreBg(c.valueScore)} ${getScoreColor(c.valueScore)}`}>
                        {c.valueScore}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 2).map((tag: string) => {
                          const colors = tagColorMap[tag] || { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200' };
                          return <span key={tag} className={`px-1.5 py-0.5 rounded text-[10px] ${colors.bg} ${colors.text} border ${colors.border}`}>{tag}</span>;
                        })}
                        {c.tags.length > 2 && <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-50 text-slate-500 border border-slate-200">+{c.tags.length - 2}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`font-semibold ${c.stayCount >= 10 ? 'text-emerald-600' : c.stayCount >= 5 ? 'text-slate-700' : 'text-slate-500'}`}>{c.stayCount}次</span>
                    </td>
                    <td className="px-3 py-3 text-right font-medium text-slate-700">¥{c.totalSpent.toLocaleString()}</td>
                    <td className="px-3 py-3 text-slate-500 text-xs">{c.lastStay}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.preferences?.slice(0, 2).map((p: string, i: number) => (
                          <span key={i} className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-600">{p}</span>
                        ))}
                        {c.preferences?.length > 2 && <span className="text-[10px] text-slate-400">+{c.preferences.length - 2}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-center gap-1">
                        <button className="p-1.5 hover:bg-blue-50 rounded-lg" title="查看详情" onClick={() => openCustomerDetail(c)}><Eye className="w-3.5 h-3.5 text-blue-500" /></button>
                        <button className="p-1.5 hover:bg-emerald-50 rounded-lg" title="打电话"><Phone className="w-3.5 h-3.5 text-emerald-500" /></button>
                        <button className="p-1.5 hover:bg-amber-50 rounded-lg" title="发短信"><MessageSquare className="w-3.5 h-3.5 text-amber-500" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredCustomers.length === 0 && (
              <div className="py-12 text-center text-slate-400 text-sm">暂无匹配客户</div>
            )}
          </div>
        </div>
      )}

      {/* ============ 智能标签 ============ */}
      {activeTab === 'tags' && (
        <div className="space-y-5">
          {/* 标签概览 */}
          <div className="grid grid-cols-4 gap-4">
            {tags.map((tag) => {
              const colors = tagColorMap[tag.name] || { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200' };
              return (
                <div key={tag.id} className="bg-white rounded-2xl border border-slate-100 p-5 hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full" style={{ backgroundColor: tag.color }} />
                      <span className="font-semibold text-slate-800">{tag.name}</span>
                      {tag.isAuto && (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-600 border border-emerald-200">
                          <Sparkles className="w-2.5 h-2.5" />自动
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button className="p-1.5 hover:bg-slate-100 rounded-lg" title="编辑标签" onClick={() => { setEditTagForm({ tagId: tag.id, name: tag.name, color: tag.color, description: tag.description }); setShowEditTag(true); }}><Edit3 className="w-3.5 h-3.5 text-slate-400" /></button>
                      <button className="p-1.5 hover:bg-red-50 rounded-lg" title="删除标签" onClick={async () => { if (confirm(`确定删除标签「${tag.name}」？`)) { await apiPost('/api/customers', { action: 'deleteTag', tagId: tag.id }); refreshTags(); } }}><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 mb-3">{tag.description}</p>
                  <div className="flex items-center justify-between">
                    <span className={`px-2 py-0.5 rounded-md text-xs ${colors.bg} ${colors.text} border ${colors.border}`}>{tag.count} 位客户</span>
                    <button className="text-xs text-emerald-600 hover:text-emerald-700" onClick={() => { setTagCustomersList({ tag: tag.name, customers: customers.filter(c => c.tags?.includes(tag.name)) }); setShowTagCustomers(true); }}>查看客户</button>
                  </div>
                </div>
              );
            })}
            {/* 添加标签卡片 */}
            <div
              className="bg-white rounded-2xl border-2 border-dashed border-slate-200 p-5 flex flex-col items-center justify-center cursor-pointer hover:border-emerald-300 hover:bg-emerald-50/30 transition-colors"
              onClick={async () => {
                const name = prompt('请输入标签名称');
                if (!name?.trim()) return;
                const color = prompt('请输入标签颜色（十六进制，如 #7c3aed）', '#6b7280');
                await apiPost('/api/customers', { action: 'addTag', name: name.trim(), color: color || '#6b7280', description: '' });
                refreshTags();
              }}
            >
              <Plus className="w-6 h-6 text-slate-300 mb-2" />
              <span className="text-xs text-slate-400">添加标签</span>
            </div>
          </div>

          {/* 自动打标规则 */}
          <div className="bg-white rounded-2xl border border-slate-100 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-600" />自动打标规则
              </h3>
              <button
                className="flex items-center gap-1 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-xs hover:bg-emerald-100 transition-colors"
                onClick={() => { setAddRuleForm({ name: '', rule: '', field: '', tag: '' }); setShowAddRule(true); }}
              >
                <Plus className="w-3 h-3" />添加规则
              </button>
            </div>
            <div className="space-y-2">
              {autoRules.map((r) => (
                <div key={r.id} className="flex items-center justify-between p-4 border border-slate-100 rounded-xl hover:bg-slate-50/50 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-700 font-mono bg-slate-50 px-2 py-0.5 rounded">{r.rule}</span>
                      <span className="text-slate-300">→</span>
                      <span className={`px-2 py-0.5 rounded-md text-xs ${tagColorMap[r.tag]?.bg || 'bg-slate-50'} ${tagColorMap[r.tag]?.text || 'text-slate-600'} border ${tagColorMap[r.tag]?.border || 'border-slate-200'}`}>{r.tag}</span>
                    </div>
                    <span className="text-xs text-slate-400">匹配字段: {r.field}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-400">{r.enabled ? '已生效' : '未启用'}</span>
                    <button
                      className={`relative w-9 h-5 rounded-full transition-colors ${r.enabled ? 'bg-emerald-500' : 'bg-slate-200'}`}
                      onClick={async () => {
                        await apiPost('/api/customers', { action: 'toggleAutoRule', ruleId: r.id });
                        refreshAutoRules();
                      }}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${r.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                </div>
              ))}
              {autoRules.length === 0 && (
                <div className="py-8 text-center text-sm text-slate-400">暂无自动打标规则</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============ 客户关怀 ============ */}
      {activeTab === 'care' && (
        <div className="space-y-5">
          {/* 关怀统计 */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-gradient-to-br from-pink-50 to-white rounded-2xl border border-pink-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-pink-100 rounded-xl flex items-center justify-center"><Heart className="w-5 h-5 text-pink-500" /></div>
              <div><div className="text-xl font-bold text-slate-800">{careReminders.filter(r => r.type === 'birthday').length}</div><div className="text-xs text-slate-500">生日关怀</div></div>
            </div>
            <div className="bg-gradient-to-br from-amber-50 to-white rounded-2xl border border-amber-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center"><TrendingUp className="w-5 h-5 text-amber-500" /></div>
              <div><div className="text-xl font-bold text-slate-800">{careReminders.filter(r => r.type === 'rebuy').length}</div><div className="text-xs text-slate-500">复购提醒</div></div>
            </div>
            <div className="bg-gradient-to-br from-purple-50 to-white rounded-2xl border border-purple-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center"><Crown className="w-5 h-5 text-purple-500" /></div>
              <div><div className="text-xl font-bold text-slate-800">{careReminders.filter(r => r.type === 'upgrade').length}</div><div className="text-xs text-slate-500">升级促活</div></div>
            </div>
            <div className="bg-gradient-to-br from-red-50 to-white rounded-2xl border border-red-100 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center"><AlertTriangle className="w-5 h-5 text-red-500" /></div>
              <div><div className="text-xl font-bold text-slate-800">{careReminders.filter(r => r.type === 'complaint').length}</div><div className="text-xs text-slate-500">投诉跟进</div></div>
            </div>
          </div>

          {/* 关怀列表 */}
          <div className="space-y-3">
            {careReminders.map((reminder) => {
              const config = careTypeConfig[reminder.type];
              const IconComp = config.icon;
              return (
                <div key={reminder.id} className={`bg-white rounded-2xl border p-5 hover:shadow-md transition-shadow ${reminder.priority === 'high' ? 'border-red-100' : reminder.priority === 'medium' ? 'border-amber-100' : 'border-slate-100'}`}>
                  <div className="flex items-start gap-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${config.bg}`}>
                      <IconComp className={`w-5 h-5 ${config.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 rounded-md text-xs ${config.bg} ${config.color} border border-current/10`}>{config.label}</span>
                        <span className="font-medium text-slate-800">{reminder.customerName}</span>
                        {reminder.priority === 'high' && <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-50 text-red-600 border border-red-200">紧急</span>}
                      </div>
                      <p className="text-sm text-slate-600 mb-2">{reminder.message}</p>
                      <div className="flex items-center gap-3 text-xs text-slate-400">
                        <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{reminder.date}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {reminder.status !== 'done' && (
                        <>
                          <button
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-xs hover:bg-emerald-100 transition-colors"
                            onClick={async () => { await apiPost('/api/customers', { action: 'sendCare', reminderId: reminder.id }); refreshCare(); }}
                          >
                            <Send className="w-3 h-3" />发送关怀
                          </button>
                          <button
                            className="flex items-center gap-1 px-3 py-1.5 bg-amber-50 text-amber-700 rounded-lg text-xs hover:bg-amber-100 transition-colors"
                            onClick={async () => { await apiPost('/api/customers', { action: 'markCareDone', reminderId: reminder.id }); refreshCare(); }}
                          >
                            <Check className="w-3 h-3" />标记已处理
                          </button>
                        </>
                      )}
                      {reminder.status === 'done' && (
                        <span className="flex items-center gap-1 px-3 py-1.5 bg-slate-50 text-slate-500 rounded-lg text-xs">
                          <Check className="w-3 h-3" />已处理
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============ 客户画像详情弹窗 ============ */}
      {selectedCustomer && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => { setSelectedCustomer(null); setCustomerDetail(null); }}>
          <div className="bg-white rounded-2xl w-[860px] max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center font-bold text-lg">{selectedCustomer.name[0]}</div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-slate-800">{selectedCustomer.name}</span>
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${memberLevelConfig[selectedCustomer.memberLevel?.key]?.bg} ${memberLevelConfig[selectedCustomer.memberLevel?.key]?.text} ${memberLevelConfig[selectedCustomer.memberLevel?.key]?.border}`}>
                      {selectedCustomer.memberLevel?.icon} {selectedCustomer.memberLevel?.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-slate-500">
                    <span>{selectedCustomer.phone}</span>
                    <span>{selectedCustomer.gender}</span>
                  </div>
                </div>
              </div>
              <button onClick={() => { setSelectedCustomer(null); setCustomerDetail(null); }} className="p-2 hover:bg-slate-100 rounded-xl"><X className="w-5 h-5 text-slate-400" /></button>
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {customerDetail ? (
                <>
                  {/* 价值评分 + 会员进度 */}
                  <div className="grid grid-cols-3 gap-4">
                    {/* 价值评分 */}
                    <div className={`${getScoreBg(customerDetail.valueScore)} rounded-2xl p-5 flex flex-col items-center justify-center border ${customerDetail.valueScore >= 80 ? 'border-emerald-100' : customerDetail.valueScore >= 50 ? 'border-amber-100' : 'border-slate-100'}`}>
                      <div className="text-xs text-slate-500 mb-1">客户价值评分</div>
                      <div className={`text-4xl font-bold ${getScoreColor(customerDetail.valueScore)}`}>{customerDetail.valueScore}</div>
                      <div className="text-xs text-slate-400 mt-1">
                        {customerDetail.valueScore >= 80 ? '高价值客户' : customerDetail.valueScore >= 50 ? '潜力客户' : '待培养客户'}
                      </div>
                    </div>

                    {/* 会员信息 */}
                    <div className="bg-white rounded-2xl border border-slate-100 p-5">
                      <div className="text-xs text-slate-500 mb-3">会员等级</div>
                      <div className="flex items-center gap-2 mb-3">
                        <span className={`text-2xl`}>{customerDetail.memberLevel?.icon}</span>
                        <div>
                          <div className="font-bold text-slate-800">{customerDetail.memberLevel?.name}</div>
                          <div className="text-xs text-slate-400">享{customerDetail.memberLevel?.discount / 10}折优惠</div>
                        </div>
                      </div>
                      {customerDetail.nextLevel && (
                        <div>
                          <div className="flex justify-between text-xs text-slate-500 mb-1">
                            <span>距{customerDetail.nextLevel.name}</span>
                            <span>还差¥{customerDetail.nextLevel.gap.toLocaleString()}</span>
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600 rounded-full transition-all"
                              style={{ width: `${Math.min(100, ((customerDetail.totalSpent) / (customerDetail.totalSpent + customerDetail.nextLevel.gap)) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {!customerDetail.nextLevel && (
                        <div className="text-xs text-purple-600 flex items-center gap-1"><Crown className="w-3 h-3" />已是最尊贵等级</div>
                      )}
                    </div>

                    {/* 消费概览 */}
                    <div className="bg-white rounded-2xl border border-slate-100 p-5">
                      <div className="text-xs text-slate-500 mb-3">消费概览</div>
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">累计消费</span>
                          <span className="font-bold text-slate-800">¥{customerDetail.totalSpent.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">入住次数</span>
                          <span className="font-bold text-slate-800">{customerDetail.stayCount}次</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">客单价</span>
                          <span className="font-bold text-slate-800">¥{customerDetail.avgSpent.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-600">首次入住</span>
                          <span className="text-slate-700">{customerDetail.firstStay}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 标签 + 偏好 */}
                  <div className="grid grid-cols-2 gap-4">
                    {/* 标签 */}
                    <div className="bg-white rounded-2xl border border-slate-100 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-semibold text-slate-800 flex items-center gap-1.5"><Tag className="w-4 h-4 text-emerald-600" />客户标签</h4>
                        <button className="text-xs text-emerald-600 hover:text-emerald-700 flex items-center gap-0.5"><Plus className="w-3 h-3" />添加</button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {customerDetail.tags.map((tag: string) => {
                          const colors = tagColorMap[tag] || { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200' };
                          return (
                            <span key={tag} className={`px-2.5 py-1 rounded-lg text-xs ${colors.bg} ${colors.text} border ${colors.border} flex items-center gap-1`}>
                              {tag}
                              <button className="hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    {/* 偏好 */}
                    <div className="bg-white rounded-2xl border border-slate-100 p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-semibold text-slate-800 flex items-center gap-1.5"><Heart className="w-4 h-4 text-rose-500" />入住偏好</h4>
                        <button className="text-xs text-emerald-600 hover:text-emerald-700 flex items-center gap-0.5"><Plus className="w-3 h-3" />添加</button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {customerDetail.preferences?.map((p: string, i: number) => (
                          <span key={i} className="px-2.5 py-1 rounded-lg text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                            {p}
                            <button className="hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
                          </span>
                        ))}
                        {(!customerDetail.preferences || customerDetail.preferences.length === 0) && (
                          <span className="text-xs text-slate-400">暂无偏好记录</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 消费趋势 */}
                  <div className="bg-white rounded-2xl border border-slate-100 p-5">
                    <h4 className="font-semibold text-slate-800 flex items-center gap-1.5 mb-4"><BarChart3 className="w-4 h-4 text-blue-600" />消费趋势（近12月）</h4>
                    <div className="flex items-end gap-1.5 h-32">
                      {customerDetail.monthlySpent?.map((m: any, i: number) => {
                        const maxAmount = Math.max(...customerDetail.monthlySpent.map((ms: any) => ms.amount), 1);
                        const height = Math.max(4, (m.amount / maxAmount) * 100);
                        const isLast = i === customerDetail.monthlySpent.length - 1;
                        return (
                          <div key={i} className="flex-1 flex flex-col items-center gap-1">
                            <div className="text-[10px] text-slate-400">{m.amount > 0 ? `¥${(m.amount / 100).toFixed(0)}百` : ''}</div>
                            <div
                              className={`w-full rounded-t-md transition-all ${m.amount > 0 ? (isLast ? 'bg-emerald-500' : 'bg-emerald-200') : 'bg-slate-50'}`}
                              style={{ height: `${height}%` }}
                            />
                            <div className={`text-[9px] ${isLast ? 'text-emerald-600 font-medium' : 'text-slate-400'}`}>{m.month.slice(5)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 入住历史 */}
                  <div className="bg-white rounded-2xl border border-slate-100 p-5">
                    <h4 className="font-semibold text-slate-800 flex items-center gap-1.5 mb-4"><Clock className="w-4 h-4 text-amber-500" />入住历史</h4>
                    <div className="space-y-2">
                      {customerDetail.stayHistory?.map((s: any) => (
                        <div key={s.id} className="flex items-center gap-4 p-3 bg-slate-50/50 rounded-xl hover:bg-slate-50 transition-colors">
                          <div className="text-sm text-slate-500 w-20 flex-shrink-0">{s.date}</div>
                          <div className="text-sm font-medium text-slate-800 flex-1">{s.roomType} · {s.roomNo}</div>
                          <span className="text-xs text-slate-400">{s.source}</span>
                          <span className="text-sm font-semibold text-slate-700">¥{s.amount.toLocaleString()}</span>
                          {s.remark && <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded">{s.remark}</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 投诉记录 */}
                  {customerDetail.complaints?.length > 0 && (
                    <div className="bg-red-50/50 rounded-2xl border border-red-100 p-5">
                      <h4 className="font-semibold text-red-700 flex items-center gap-1.5 mb-3"><AlertTriangle className="w-4 h-4" />投诉记录</h4>
                      <div className="space-y-2">
                        {customerDetail.complaints.map((comp: any, i: number) => (
                          <div key={i} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-red-50">
                            <span className="text-sm text-slate-500">{comp.date}</span>
                            <span className="text-sm text-slate-700 flex-1">{comp.content}</span>
                            <span className={`text-xs px-2 py-0.5 rounded ${comp.status === '已处理' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{comp.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 备注 */}
                  <div className="bg-white rounded-2xl border border-slate-100 p-5">
                    <h4 className="font-semibold text-slate-800 flex items-center gap-1.5 mb-3"><FileText className="w-4 h-4 text-slate-400" />备注</h4>
                    <p className="text-sm text-slate-600">{customerDetail.remark || '暂无备注'}</p>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center py-12 text-slate-400 text-sm">加载中...</div>
              )}
            </div>

            {/* 底部操作 */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-2">
                <button className="flex items-center gap-1.5 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-xl text-sm hover:bg-emerald-100 transition-colors">
                  <Phone className="w-4 h-4" />拨打电话
                </button>
                <button className="flex items-center gap-1.5 px-4 py-2 bg-blue-50 text-blue-700 rounded-xl text-sm hover:bg-blue-100 transition-colors">
                  <MessageSquare className="w-4 h-4" />发送短信
                </button>
              </div>
              <button onClick={() => openEditCustomer(customerDetail)} className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm hover:bg-emerald-700 transition-colors">
                <Edit3 className="w-4 h-4" />编辑客户
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 添加客户弹窗 ============ */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowAdd(false); setAddErrors({}); }}>
          <div className="bg-white rounded-2xl w-full max-w-[680px] max-h-[90vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
              <div>
                <h3 className="text-lg font-semibold text-slate-800">添加客户</h3>
                <p className="text-xs text-slate-400 mt-0.5">录入客户信息，入住时将自动匹配建档</p>
              </div>
              <button className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors" onClick={() => { setShowAdd(false); setAddErrors({}); }}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {/* 基本信息 */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-emerald-500" />基本信息
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">姓名 <span className="text-red-400">*</span></label>
                    <input
                      className={`w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${addErrors.name ? 'border-red-300' : 'border-slate-200'}`}
                      placeholder="请输入客户姓名"
                      value={addForm.name}
                      onChange={(e) => { setAddForm({ ...addForm, name: e.target.value }); if (addErrors.name) setAddErrors(prev => { const next = { ...prev }; delete next.name; return next; }); }}
                    />
                    {addErrors.name && <p className="text-red-500 text-xs mt-1">{addErrors.name}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">手机号 <span className="text-red-400">*</span></label>
                    <input
                      className={`w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${addErrors.phone ? 'border-red-300' : 'border-slate-200'}`}
                      placeholder="请输入手机号"
                      value={addForm.phone}
                      onChange={(e) => { setAddForm({ ...addForm, phone: e.target.value }); if (addErrors.phone) setAddErrors(prev => { const next = { ...prev }; delete next.phone; return next; }); }}
                    />
                    {addErrors.phone && <p className="text-red-500 text-xs mt-1">{addErrors.phone}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">性别</label>
                    <div className="flex gap-2">
                      {(['男', '女'] as const).map((g) => (
                        <button
                          key={g}
                          className={`flex-1 px-3 py-2 rounded-xl text-sm border transition-colors ${addForm.gender === g ? 'bg-emerald-50 border-emerald-300 text-emerald-700 font-medium' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                          onClick={() => setAddForm({ ...addForm, gender: g })}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">生日</label>
                    <input
                      type="date"
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      value={addForm.birthday}
                      onChange={(e) => setAddForm({ ...addForm, birthday: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">身份证号</label>
                    <input
                      className={`w-full px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${addErrors.idCard ? 'border-red-300' : 'border-slate-200'}`}
                      placeholder="选填"
                      value={addForm.idCard}
                      onChange={(e) => { setAddForm({ ...addForm, idCard: e.target.value }); if (addErrors.idCard) setAddErrors(prev => { const next = { ...prev }; delete next.idCard; return next; }); }}
                    />
                    {addErrors.idCard && <p className="text-red-500 text-xs mt-1">{addErrors.idCard}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">来源渠道</label>
                    <select
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      value={addForm.source}
                      onChange={(e) => setAddForm({ ...addForm, source: e.target.value })}
                    >
                      <option value="直营">直营/到店</option>
                      {channelList.filter(c => c.name !== '直营' && c.name !== '到店').map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                      <option value="携程">携程</option>
                      <option value="美团">美团</option>
                      <option value="飞猪">飞猪</option>
                      <option value="抖音">抖音</option>
                      <option value="其他">其他</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* 标签 */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                  <Tag className="w-4 h-4 text-amber-500" />客户标签
                </h4>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      placeholder="输入标签，按回车添加"
                      value={addForm.tagInput}
                      onChange={(e) => setAddForm({ ...addForm, tagInput: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && addForm.tagInput.trim()) {
                          e.preventDefault();
                          if (!addForm.tags.includes(addForm.tagInput.trim())) {
                            setAddForm({ ...addForm, tags: [...addForm.tags, addForm.tagInput.trim()], tagInput: '' });
                          }
                        }
                      }}
                    />
                  </div>
                  {/* 快捷标签 */}
                  <div className="flex flex-wrap gap-1.5">
                    {['VIP', '常客', '新客', '商务客户', '家庭客户', '投诉敏感', '网红客', '待激活'].map((t) => (
                      <button
                        key={t}
                        className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                          addForm.tags.includes(t)
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                            : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                        }`}
                        onClick={() => {
                          setAddForm({
                            ...addForm,
                            tags: addForm.tags.includes(t) ? addForm.tags.filter((x: string) => x !== t) : [...addForm.tags, t],
                          });
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {/* 已选标签 */}
                  {addForm.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {addForm.tags.map((tag: string) => {
                        const colorCfg = tagColorMap[tag] || { bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200' };
                        return (
                          <span key={tag} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border ${colorCfg.bg} ${colorCfg.text} ${colorCfg.border}`}>
                            {tag}
                            <button onClick={() => setAddForm({ ...addForm, tags: addForm.tags.filter((x: string) => x !== tag) })}>
                              <X className="w-3 h-3 opacity-50 hover:opacity-100" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* 入住偏好 */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                  <Heart className="w-4 h-4 text-pink-500" />入住偏好
                </h4>
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      placeholder="输入偏好，按回车添加（如：高楼层、安静、远离电梯）"
                      value={addForm.preferenceInput}
                      onChange={(e) => setAddForm({ ...addForm, preferenceInput: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && addForm.preferenceInput.trim()) {
                          e.preventDefault();
                          if (!addForm.preferences.includes(addForm.preferenceInput.trim())) {
                            setAddForm({ ...addForm, preferences: [...addForm.preferences, addForm.preferenceInput.trim()], preferenceInput: '' });
                          }
                        }
                      }}
                    />
                  </div>
                  {/* 快捷偏好 */}
                  <div className="flex flex-wrap gap-1.5">
                    {['高楼层', '低楼层', '安静', '远离电梯', '需要大床', 'WiFi信号强', '朝南', '有书桌', '带阳台'].map((p) => (
                      <button
                        key={p}
                        className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                          addForm.preferences.includes(p)
                            ? 'bg-pink-50 border-pink-300 text-pink-700'
                            : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                        }`}
                        onClick={() => {
                          setAddForm({
                            ...addForm,
                            preferences: addForm.preferences.includes(p) ? addForm.preferences.filter((x: string) => x !== p) : [...addForm.preferences, p],
                          });
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  {/* 已选偏好 */}
                  {addForm.preferences.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {addForm.preferences.map((pref: string) => (
                        <span key={pref} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border bg-pink-50 text-pink-700 border-pink-200">
                          <Sparkles className="w-3 h-3" />{pref}
                          <button onClick={() => setAddForm({ ...addForm, preferences: addForm.preferences.filter((x: string) => x !== pref) })}>
                            <X className="w-3 h-3 opacity-50 hover:opacity-100" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 备注 */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-slate-400" />备注
                </h4>
                <textarea
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none"
                  rows={3}
                  placeholder="添加客户备注信息..."
                  value={addForm.remark}
                  onChange={(e) => setAddForm({ ...addForm, remark: e.target.value })}
                />
              </div>
            </div>

            {/* 底部 */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 flex-shrink-0">
              <div className="text-xs text-slate-400">
                <span className="text-red-400">*</span> 为必填项，其余入住时可补充
              </div>
              <div className="flex items-center gap-3">
                <button
                  className="px-5 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                  onClick={() => { setShowAdd(false); setAddErrors({}); }}
                >
                  取消
                </button>
                <button
                  className="px-6 py-2 bg-emerald-600 text-white text-sm rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                  disabled={!addForm.name.trim() || !addForm.phone.trim() || addSubmitting}
                  onClick={async () => {
                    // 表单校验
                    const errors: Record<string, string> = {};
                    const nameCheck = validateRequired(addForm.name, '客户姓名');
                    if (!nameCheck.valid) errors.name = nameCheck.error;
                    if (addForm.phone && !isValidPhone(addForm.phone)) {
                      errors.phone = '请输入正确的手机号';
                    }
                    if (!addForm.phone.trim()) {
                      errors.phone = '请输入手机号';
                    }
                    if (addForm.idCard && !isValidIdCard(addForm.idCard)) {
                      errors.idCard = '请输入正确的身份证号';
                    }
                    if (Object.keys(errors).length > 0) {
                      setAddErrors(errors);
                      return;
                    }
                    setAddErrors({});
                    setAddSubmitting(true);
                    try {
                      await apiPost('/api/customers', { action: 'addCustomer', ...addForm });
                      // 直接添加到列表
                      const newCustomer = {
                        id: 'c_new_' + addForm.phone.trim(),
                        name: addForm.name.trim(),
                        phone: addForm.phone.trim(),
                        gender: addForm.gender,
                        tags: addForm.tags.length > 0 ? addForm.tags : ['新客'],
                        source: addForm.source,
                        stayCount: 0,
                        totalSpent: 0,
                        avgSpent: 0,
                        lastStay: '-',
                        remark: addForm.remark,
                        preferences: addForm.preferences,
                        valueScore: 22,
                        birthday: addForm.birthday,
                        memberLevel: { key: 'silver', name: '银卡', discount: 100, icon: '🥈' },
                      };
                      setCustomers((prev: any[]) => [newCustomer, ...prev]);
                      setStats((prev: any) => prev ? { ...prev, total: prev.total + 1, newThisMonth: prev.newThisMonth + 1 } : prev);
                      setShowAdd(false);
                    } finally {
                      setAddSubmitting(false);
                    }
                  }}
                >
                  {addSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      提交中...
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      确认添加
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ 编辑客户弹窗 ============ */}
      {showEditCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowEditCustomer(false); setEditErrors({}); }}>
          <div className="bg-white rounded-2xl w-full max-w-[680px] h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* 头部 */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
              <div>
                <h3 className="text-lg font-semibold text-slate-800">编辑客户</h3>
                <p className="text-xs text-slate-400 mt-0.5">修改客户信息</p>
              </div>
              <button onClick={() => { setShowEditCustomer(false); setEditErrors({}); }} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            {/* 内容区 */}
            <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-5">
              {/* 基本信息 */}
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-3">基本信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">姓名 <span className="text-red-500">*</span></label>
                    <input value={editForm.name} onChange={e => { setEditForm({...editForm, name: e.target.value}); if (editErrors.name) setEditErrors(prev => { const next = { ...prev }; delete next.name; return next; }); }} className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${editErrors.name ? 'border-red-300' : 'border-slate-200'}`} />
                    {editErrors.name && <p className="text-red-500 text-xs mt-1">{editErrors.name}</p>}
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">手机号 <span className="text-red-500">*</span></label>
                    <input value={editForm.phone} onChange={e => { setEditForm({...editForm, phone: e.target.value}); if (editErrors.phone) setEditErrors(prev => { const next = { ...prev }; delete next.phone; return next; }); }} className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${editErrors.phone ? 'border-red-300' : 'border-slate-200'}`} />
                    {editErrors.phone && <p className="text-red-500 text-xs mt-1">{editErrors.phone}</p>}
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">性别</label>
                    <div className="flex gap-2">
                      {['男', '女'].map(g => (
                        <button key={g} onClick={() => setEditForm({...editForm, gender: g})} className={`flex-1 py-2 rounded-lg text-sm border transition-colors ${editForm.gender === g ? 'bg-emerald-50 border-emerald-500 text-emerald-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>{g}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">生日</label>
                    <input type="date" value={editForm.birthday} onChange={e => setEditForm({...editForm, birthday: e.target.value})} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">身份证号</label>
                    <input value={editForm.idCard} onChange={e => { setEditForm({...editForm, idCard: e.target.value}); if (editErrors.idCard) setEditErrors(prev => { const next = { ...prev }; delete next.idCard; return next; }); }} className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${editErrors.idCard ? 'border-red-300' : 'border-slate-200'}`} />
                    {editErrors.idCard && <p className="text-red-500 text-xs mt-1">{editErrors.idCard}</p>}
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">来源渠道</label>
                    <select value={editForm.source} onChange={e => setEditForm({...editForm, source: e.target.value})} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                      <option value="直营">直营/到店</option>
                      {channelList.filter(c => c.name !== '直营' && c.name !== '到店').map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              {/* 标签 */}
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-3">客户标签</h4>
                <div className="flex gap-2 mb-2">
                  <input value={editForm.tagInput} onChange={e => setEditForm({...editForm, tagInput: e.target.value})} onKeyDown={e => { if (e.key === 'Enter' && editForm.tagInput.trim()) { setEditForm({...editForm, tags: [...editForm.tags, editForm.tagInput.trim()], tagInput: ''}); } }} placeholder="输入标签后回车添加" className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {['VIP', '常客', '新客', '商务', '家庭', '投诉敏感', '网红', '待激活'].map(tag => (
                    <button key={tag} onClick={() => { if (!editForm.tags.includes(tag)) setEditForm({...editForm, tags: [...editForm.tags, tag]}); }} className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${editForm.tags.includes(tag) ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>{tag}</button>
                  ))}
                </div>
                {editForm.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {editForm.tags.map((tag, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {tag}
                        <button onClick={() => setEditForm({...editForm, tags: editForm.tags.filter((_: string, idx: number) => idx !== i)})} className="hover:text-red-500">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* 入住偏好 */}
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-3">入住偏好</h4>
                <div className="flex gap-2 mb-2">
                  <input value={editForm.preferenceInput} onChange={e => setEditForm({...editForm, preferenceInput: e.target.value})} onKeyDown={e => { if (e.key === 'Enter' && editForm.preferenceInput.trim()) { setEditForm({...editForm, preferences: [...editForm.preferences, editForm.preferenceInput.trim()], preferenceInput: ''}); } }} placeholder="输入偏好后回车添加" className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {['高楼层', '低楼层', '安静', '远离电梯', '需要大床', 'WiFi强', '朝南', '有书桌', '带阳台'].map(p => (
                    <button key={p} onClick={() => { if (!editForm.preferences.includes(p)) setEditForm({...editForm, preferences: [...editForm.preferences, p]}); }} className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${editForm.preferences.includes(p) ? 'bg-purple-50 border-purple-300 text-purple-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>{p}</button>
                  ))}
                </div>
                {editForm.preferences.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {editForm.preferences.map((pref, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-purple-50 text-purple-700 border border-purple-200">
                        <Sparkles className="w-3 h-3" />{pref}
                        <button onClick={() => setEditForm({...editForm, preferences: editForm.preferences.filter((_: string, idx: number) => idx !== i)})} className="hover:text-red-500">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* 备注 */}
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-3">备注</h4>
                <textarea value={editForm.remark} onChange={e => setEditForm({...editForm, remark: e.target.value})} rows={3} placeholder="客户备注信息..." className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" />
              </div>
            </div>
            {/* 底部 */}
            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
              <span className="text-xs text-slate-400">* 为必填项</span>
              <div className="flex gap-3">
                <button onClick={() => { setShowEditCustomer(false); setEditErrors({}); }} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 transition-colors">取消</button>
                <button onClick={async () => {
                  // 表单校验
                  const errors: Record<string, string> = {};
                  const nameCheck = validateRequired(editForm.name, '客户姓名');
                  if (!nameCheck.valid) errors.name = nameCheck.error;
                  if (editForm.phone && !isValidPhone(editForm.phone)) {
                    errors.phone = '请输入正确的手机号';
                  }
                  if (!editForm.phone.trim()) {
                    errors.phone = '请输入手机号';
                  }
                  if (editForm.idCard && !isValidIdCard(editForm.idCard)) {
                    errors.idCard = '请输入正确的身份证号';
                  }
                  if (Object.keys(errors).length > 0) {
                    setEditErrors(errors);
                    return;
                  }
                  setEditErrors({});
                  setEditSubmitting(true);
                  try {
                    await apiPost('/api/customers', { action: 'editCustomer', customerId: editForm.id, name: editForm.name, phone: editForm.phone, gender: editForm.gender, birthday: editForm.birthday, idCard: editForm.idCard });
                    setCustomers(prev => prev.map((c: any) => c.id === editForm.id ? { ...c, name: editForm.name, phone: editForm.phone, gender: editForm.gender, birthday: editForm.birthday, idCard: editForm.idCard, source: editForm.source, tags: editForm.tags, preferences: editForm.preferences, remark: editForm.remark } : c));
                    if (customerDetail?.id === editForm.id) {
                      setCustomerDetail((prev: any) => ({ ...prev, name: editForm.name, phone: editForm.phone, gender: editForm.gender, birthday: editForm.birthday, idCard: editForm.idCard, source: editForm.source, tags: editForm.tags, preferences: editForm.preferences, remark: editForm.remark }));
                    }
                    setShowEditCustomer(false);
                  } finally { setEditSubmitting(false); }
                }} disabled={editSubmitting || !editForm.name.trim() || !editForm.phone.trim()} className="px-6 py-2 bg-emerald-600 text-white rounded-xl text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {editSubmitting ? '保存中...' : '保存修改'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ 编辑标签弹窗 ============ */}
      {showEditTag && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowEditTag(false)}>
          <div className="bg-white rounded-2xl w-full max-w-[480px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-800">编辑标签</h3>
              <button onClick={() => setShowEditTag(false)} className="p-1.5 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">标签名称</label>
                <input value={editTagForm.name} onChange={e => setEditTagForm({ ...editTagForm, name: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">标签颜色</label>
                <div className="flex items-center gap-3">
                  <input type="color" value={editTagForm.color} onChange={e => setEditTagForm({ ...editTagForm, color: e.target.value })} className="w-10 h-10 rounded-lg border border-slate-200 cursor-pointer" />
                  <input value={editTagForm.color} onChange={e => setEditTagForm({ ...editTagForm, color: e.target.value })} className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">描述</label>
                <textarea value={editTagForm.description} onChange={e => setEditTagForm({ ...editTagForm, description: e.target.value })} rows={2} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" />
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-100">
              <button onClick={() => setShowEditTag(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl">取消</button>
              <button
                className="px-6 py-2 bg-emerald-600 text-white text-sm rounded-xl hover:bg-emerald-700 transition-colors"
                onClick={async () => {
                  await apiPost('/api/customers', { action: 'editTag', tagId: editTagForm.tagId, name: editTagForm.name, color: editTagForm.color, description: editTagForm.description });
                  setShowEditTag(false);
                  refreshTags();
                }}
              >
                保存修改
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 添加自动规则弹窗 ============ */}
      {showAddRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowAddRule(false)}>
          <div className="bg-white rounded-2xl w-full max-w-[560px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-800">添加自动打标规则</h3>
              <button onClick={() => setShowAddRule(false)} className="p-1.5 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">规则名称</label>
                <input value={addRuleForm.name} onChange={e => setAddRuleForm({ ...addRuleForm, name: e.target.value })} placeholder="如：高频商务客标记" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">触发条件</label>
                <input value={addRuleForm.rule} onChange={e => setAddRuleForm({ ...addRuleForm, rule: e.target.value })} placeholder="如：入住>10次 且 标签含商务客" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">匹配字段</label>
                <input value={addRuleForm.field} onChange={e => setAddRuleForm({ ...addRuleForm, field: e.target.value })} placeholder="如：totalStays + tags" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">自动打标签</label>
                <select value={addRuleForm.tag} onChange={e => setAddRuleForm({ ...addRuleForm, tag: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                  <option value="">选择标签</option>
                  {tags.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-100">
              <button onClick={() => setShowAddRule(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl">取消</button>
              <button
                className="px-6 py-2 bg-emerald-600 text-white text-sm rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!addRuleForm.name.trim() || !addRuleForm.rule.trim() || !addRuleForm.tag}
                onClick={async () => {
                  await apiPost('/api/customers', { action: 'addAutoRule', ...addRuleForm });
                  setShowAddRule(false);
                  refreshAutoRules();
                }}
              >
                添加规则
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 查看标签下客户弹窗 ============ */}
      {showTagCustomers && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowTagCustomers(false)}>
          <div className="bg-white rounded-2xl w-full max-w-[600px] max-h-[70vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
              <h3 className="text-lg font-semibold text-slate-800">标签「{tagCustomersList.tag}」下的客户</h3>
              <button onClick={() => setShowTagCustomers(false)} className="p-1.5 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {tagCustomersList.customers.length === 0 ? (
                <div className="py-8 text-center text-sm text-slate-400">暂无客户使用此标签</div>
              ) : (
                <div className="space-y-2">
                  {tagCustomersList.customers.map((c: any) => (
                    <div key={c.id} className="flex items-center gap-3 p-3 bg-slate-50/50 rounded-xl hover:bg-slate-50 cursor-pointer transition-colors" onClick={() => { setShowTagCustomers(false); openCustomerDetail(c); }}>
                      <div className="w-8 h-8 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center font-bold text-xs">{c.name[0]}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-800 text-sm">{c.name}</div>
                        <div className="text-xs text-slate-400">{c.phone} · {c.memberLevel?.name || '普通会员'}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-slate-700">¥{c.totalSpent?.toLocaleString() || 0}</div>
                        <div className="text-xs text-slate-400">{c.stayCount || c.totalStays || 0}次入住</div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
