// 已由 /pricing-center 替代，待清理
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAiStore } from '@/lib/context/ai-store-context';
import { Button } from '@/components/ui/button';
import {
  getSuggestion, confirmAuth, getTodayAuth,
  fuseAuth, getTasks, getRobotStats,
  getPlan, updatePlanPrice, confirmPlan,
} from '@/lib/price-robot-api';

interface SuggestionItem { roomTypeId: string; roomType: string; basePrice: number; suggestedFloor: number; remaining: number; total: number; occupancy: number; strategy: string; enabled: boolean; }
interface AuthItem { id: string; roomTypeId: string; floorPrice: number; strategy: string; status: string; }
interface TaskItem { id: string; slot: string; roomTypeName: string; channel: string; targetPrice: number; status: string; verifiedPrice: number | null; error: string | null; }
interface PlanItem { id: string; planDate: string; roomTypeId: string; roomTypeName: string; price: number; predictedOccupancy: number; status: string; }

const STRATEGY_OPTIONS = [
  { value: 'aggressive', label: '激进', desc: '多留利润' },
  { value: 'standard', label: '标准', desc: '均衡' },
  { value: 'conservative', label: '保守', desc: '快速清房' },
];

export default function PriceRobotPage() {
  const router = useRouter();
  const { selectedStoreId } = useAiStore();
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  // floors 存字符串，允许清空输入；提交时对空/非法值回退建议底价
  const [floors, setFloors] = useState<Record<string, string>>({});
  const [strategies, setStrategies] = useState<Record<string, string>>({});
  const [todayAuth, setTodayAuth] = useState<AuthItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [confirming, setConfirming] = useState(false);
  const [fusing, setFusing] = useState(false);
  const [msg, setMsg] = useState('');
  // 未来价格日历：14 天计划 + 可编辑计划价输入 + 确认执行
  const [plans, setPlans] = useState<PlanItem[]>([]);
  // planEdits 存字符串，允许清空输入；key = `${planDate}_${roomTypeId}`
  const [planEdits, setPlanEdits] = useState<Record<string, string>>({});
  const [savingPlan, setSavingPlan] = useState<Record<string, boolean>>({});
  const [planConfirming, setPlanConfirming] = useState(false);
  // 防止 onBlur 与「保存」按钮双触发重复提交
  const savingKeys = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, t, st, p] = await Promise.all([
        getSuggestion(), getTodayAuth(), getTasks(), getRobotStats(), getPlan(),
      ]);
      const list = (s?.data?.suggestions || []) as SuggestionItem[];
      setSuggestions(list);
      // 以服务端计划价为种子初始化可编辑输入
      const planList = (p?.data || []) as PlanItem[];
      const pe: Record<string, string> = {};
      planList.forEach(x => { pe[`${x.planDate}_${x.roomTypeId}`] = String(x.price); });
      setPlans(planList); setPlanEdits(pe);
      // 以已确认授权（今日 floorPrice）为种子，避免「更新今日计划」把已确认底价静默改回 AI 建议价
      const authByRoom: Record<string, AuthItem> = {};
      (a?.data || []).forEach((x: AuthItem) => { if (x.status === 'confirmed') authByRoom[x.roomTypeId] = x; });
      const f: Record<string, string> = {}; const str: Record<string, string> = {};
      list.forEach(i => {
        f[i.roomTypeId] = authByRoom[i.roomTypeId] ? String(authByRoom[i.roomTypeId].floorPrice) : String(i.suggestedFloor);
        str[i.roomTypeId] = authByRoom[i.roomTypeId] ? (authByRoom[i.roomTypeId].strategy || i.strategy) : i.strategy;
      });
      setFloors(f); setStrategies(str);
      setTodayAuth(a?.data || []);
      setTasks((t?.data || []).filter((x: TaskItem) => x.slot !== ''));
      setStats(st?.data || null);
    } catch {} finally { setLoading(false); }
  }, [selectedStoreId]);

  useEffect(() => { load(); }, [load]);

  const confirmedRooms = todayAuth.filter(a => a.status === 'confirmed');
  const isFused = todayAuth.some(a => a.status === 'fused');
  // 底价是否非法：非空且 ≤0（或非数字）视为非法，提交时回退建议底价
  const invalidFloor = (s: SuggestionItem): boolean => {
    const v = floors[s.roomTypeId];
    if (v == null || v.trim() === '') return false;
    return !(Number(v) > 0);
  };

  const handleConfirm = async () => {
    setConfirming(true); setMsg('');
    try {
      const rooms = suggestions.map(s => {
        // 空/非法输入回退建议底价，避免 0 被后端静默跳过
        const v = Number(floors[s.roomTypeId]);
        const floorPrice = Number.isFinite(v) && v > 0 ? v : s.suggestedFloor;
        return {
          roomTypeId: s.roomTypeId,
          floorPrice,
          strategy: strategies[s.roomTypeId] || 'standard',
        };
      });
      const res = await confirmAuth(rooms);
      setMsg(`✅ 已确认 ${res?.data?.confirmed ?? 0} 个房型的今日执行计划`);
      await load();
    } catch { setMsg('❌ 确认失败'); } finally { setConfirming(false); }
  };

  const handleFuse = async () => {
    // 后端按门店+日期熔断今日全部授权，传任一授权 id 即可
    const auth = todayAuth.find(a => a.status === 'confirmed');
    if (!auth) return;
    if (!window.confirm('熔断将作废今日全部自动改价，确定吗？')) return;
    setFusing(true); setMsg('');
    try { await fuseAuth(auth.id); setMsg('🛑 已熔断今日自动改价'); await load(); }
    catch { setMsg('❌ 熔断失败'); } finally { setFusing(false); }
  };

  // 保存某天某房型的计划价：非法/空输入回退原价并还原输入框
  const handlePlanSave = async (p: PlanItem) => {
    const k = `${p.planDate}_${p.roomTypeId}`;
    if (savingKeys.current.has(k)) return; // 防止 onBlur + 按钮双触发
    const v = Number(planEdits[k]);
    if (!(Number.isFinite(v) && v > 0)) {
      setPlanEdits(prev => ({ ...prev, [k]: String(p.price) }));
      return;
    }
    if (v === p.price) return; // 未改动，跳过
    savingKeys.current.add(k);
    setSavingPlan(prev => ({ ...prev, [k]: true }));
    try {
      await updatePlanPrice({ planDate: p.planDate, roomTypeId: p.roomTypeId, price: v });
      setMsg(`✅ 已更新 ${p.planDate} ${p.roomTypeName} 计划价 ¥${v}`);
      // 同步本地计划价，避免依赖重载
      setPlans(prev => prev.map(x =>
        (x.planDate === p.planDate && x.roomTypeId === p.roomTypeId) ? { ...x, price: v } : x,
      ));
    } catch { setMsg('❌ 改价失败'); }
    finally {
      savingKeys.current.delete(k);
      setSavingPlan(prev => { const n = { ...prev }; delete n[k]; return n; });
    }
  };

  // 确认近端 3 天执行（空数组 = 后端默认近端 3 天）
  const handleConfirmPlan = async () => {
    setPlanConfirming(true); setMsg('');
    try {
      const res = await confirmPlan([]);
      setMsg(`✅ 已确认近端 3 天执行（确认 ${res?.data?.confirmed ?? 0} 天，生成 ${res?.data?.tasksGenerated ?? 0} 个任务）`);
      await load();
    } catch { setMsg('❌ 确认执行失败'); }
    finally { setPlanConfirming(false); }
  };

  const authStatus = isFused ? '熔断' : (confirmedRooms.length > 0 ? '已确认' : '未确认');
  // 未来计划按日期分组（后端已按日期排序，这里防御性再排一次）
  const planGroups = [...plans]
    .sort((a, b) => (a.planDate < b.planDate ? -1 : a.planDate > b.planDate ? 1 : 0))
    .reduce<{ date: string; items: PlanItem[] }[]>((acc, p) => {
      const last = acc[acc.length - 1];
      if (last && last.date === p.planDate) last.items.push(p);
      else acc.push({ date: p.planDate, items: [p] });
      return acc;
    }, []);

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50 flex flex-col">
      {/* 顶部状态卡 */}
      <div className="flex items-center justify-between px-6 py-3 bg-white/90 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-xl shadow-md">💰</div>
          <div>
            <h1 className="text-base font-bold text-slate-800">自动收益管家</h1>
            <p className={`text-xs ${isFused ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
              今日状态: 【{authStatus}】 {stats?.executedCount ?? 0} 次执行 · 均价 ¥{stats?.avgPrice ?? '-'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {confirmedRooms.length > 0 && !isFused && (
            <Button onClick={handleFuse} disabled={fusing} className="bg-red-500 hover:bg-red-600 text-white text-xs">
              {fusing ? '熔断中...' : '🛑 立即熔断'}
            </Button>
          )}
          <button onClick={() => router.back()} className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-400 hover:text-slate-600">← 返回</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 custom-scroll max-w-4xl mx-auto w-full space-y-4">
        {loading ? <div className="text-center py-12 text-slate-400">加载中...</div> : (<>
          {msg && <div className="bg-white rounded-xl border border-emerald-200 p-3 text-sm text-emerald-700">{msg}</div>}

          {/* 今日底价确认 */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h3 className="font-semibold text-slate-700 mb-3">📋 今日底价确认 <span className="text-[10px] text-slate-400 font-normal">每日 16:00 提醒 · 未确认则不执行</span></h3>
            <div className="space-y-2">
              {suggestions.map(s => (
                <div key={s.roomTypeId} className="flex items-center gap-3 p-2 rounded-xl bg-slate-50">
                  <span className="w-24 text-sm font-medium text-slate-700">{s.roomType}</span>
                  <span className="text-[11px] text-slate-400 w-14">建议 ¥{s.suggestedFloor}</span>
                  <input
                    type="number" value={floors[s.roomTypeId] ?? String(s.suggestedFloor)}
                    onChange={e => setFloors(prev => ({ ...prev, [s.roomTypeId]: e.target.value }))}
                    className={`w-24 px-2 py-1 border rounded-lg text-sm ${invalidFloor(s) ? 'border-red-300 text-red-500' : 'border-slate-200'}`}
                  />
                  {invalidFloor(s) && <span className="text-[11px] text-red-500">底价需大于 0</span>}
                  <select
                    value={strategies[s.roomTypeId] || 'standard'}
                    onChange={e => setStrategies(prev => ({ ...prev, [s.roomTypeId]: e.target.value }))}
                    className="px-2 py-1 border border-slate-200 rounded-lg text-xs"
                  >
                    {STRATEGY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${s.remaining >= s.total * 0.5 ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-600'}`}>
                    剩 {s.remaining}/{s.total}间
                  </span>
                  <span className="text-[11px] text-slate-400">预测入住率 {s.occupancy}%</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button onClick={handleConfirm} disabled={confirming || isFused}
                className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-xs">
                {confirming ? '确认中...' : confirmedRooms.length > 0 ? '🔄 更新今日计划' : '✅ 一键确认今日执行计划'}
              </Button>
              {confirmedRooms.length > 0 && <span className="text-[11px] text-slate-400">已授权，17:00 起自动改价</span>}
            </div>
          </div>

          {/* 执行时间轴 */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h3 className="font-semibold text-slate-700 mb-3">🕐 执行时间轴</h3>
            {['17:00', '19:00', '21:00'].map(slot => {
              const slotTasks = tasks.filter(t => t.slot === slot);
              const done = slotTasks.filter(t => t.status === 'success').length;
              return (
                <div key={slot} className="flex items-center gap-3 py-2 border-b border-slate-50 last:border-0">
                  <span className="w-12 font-bold text-slate-600">{slot}</span>
                  {slotTasks.length === 0
                    ? <span className="text-xs text-slate-400">待授权或未生成任务</span>
                    : (
                      <div className="flex-1 flex flex-wrap gap-2">
                        {slotTasks.map(t => (
                          <span key={t.id} className={`text-[11px] px-2 py-1 rounded-lg ${statusColor(t.status)}`}>
                            {t.channel} ¥{t.targetPrice} {statusIcon(t.status)}
                          </span>
                        ))}
                      </div>
                    )}
                  {done > 0 && <span className="text-[11px] text-emerald-500 font-medium">{done} 成功</span>}
                </div>
              );
            })}
          </div>

          {/* 未来价格日历 */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <h3 className="font-semibold text-slate-700 mb-3">
              📅 未来价格日历 <span className="text-[10px] text-slate-400 font-normal">14 天预览 · 确认后近端 3 天自动执行 · 每日 6:00 生成</span>
            </h3>
            {plans.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-400">暂无计划，每日 6:00 自动生成</div>
            ) : (
              <div className="space-y-2">
                {planGroups.map(g => (
                  <div key={g.date} className="rounded-xl border border-slate-100 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-bold text-slate-700">{formatPlanDate(g.date)}</span>
                      <span className="text-[11px] text-slate-400">{formatPlanWeekday(g.date)}</span>
                    </div>
                    <div className="space-y-1.5">
                      {g.items.map(p => (
                        <div key={p.id} className="flex items-center gap-3">
                          <span className="w-20 text-xs text-slate-600 truncate">{p.roomTypeName}</span>
                          <span className="text-[11px] text-slate-400 w-20">入住率 {p.predictedOccupancy ?? '-'}%</span>
                          <input
                            type="number"
                            value={planEdits[`${p.planDate}_${p.roomTypeId}`] ?? String(p.price)}
                            onChange={e => setPlanEdits(prev => ({ ...prev, [`${p.planDate}_${p.roomTypeId}`]: e.target.value }))}
                            onBlur={() => handlePlanSave(p)}
                            className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-sm"
                          />
                          <Button size="sm" variant="ghost" className="text-xs" onClick={() => handlePlanSave(p)}>
                            {savingPlan[`${p.planDate}_${p.roomTypeId}`] ? '保存中...' : '保存'}
                          </Button>
                          <span className={`text-[11px] px-2 py-0.5 rounded-full ${planStatusStyle(p.status)}`}>{planStatusText(p.status)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3">
              <Button onClick={handleConfirmPlan} disabled={isFused || planConfirming || plans.length === 0}
                className="bg-gradient-to-r from-blue-500 to-indigo-500 text-white text-xs">
                {planConfirming ? '确认中...' : '✅ 确认近端 3 天执行'}
              </Button>
              {isFused && <span className="ml-2 text-[11px] text-red-500">已熔断，无法确认新计划</span>}
            </div>
          </div>

          {/* 今日效果 */}
          <div className="bg-gradient-to-r from-emerald-50 to-teal-50 rounded-2xl border border-emerald-200 p-4">
            <h3 className="font-semibold text-emerald-800">📈 今日效果</h3>
            <p className="text-sm text-emerald-600 mt-1">
              执行 {stats?.executedCount ?? 0} 次 · 平均售价 ¥{stats?.avgPrice ?? '-'} · 今日售出 {stats?.soldToday ?? 0} 间
            </p>
          </div>
        </>)}
      </div>
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:4px}.custom-scroll::-webkit-scrollbar-track{background:transparent}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:4px}`}</style>
    </div>
  );
}

function statusColor(s: string): string {
  switch (s) {
    case 'success': return 'bg-emerald-50 text-emerald-600';
    case 'rolled_back': return 'bg-amber-50 text-amber-600';
    case 'failed': return 'bg-red-50 text-red-500';
    case 'skipped': return 'bg-slate-100 text-slate-400';
    default: return 'bg-slate-50 text-slate-500';
  }
}
function statusIcon(s: string): string {
  switch (s) {
    case 'success': return '✓'; case 'rolled_back': return '↩'; case 'failed': return '✕'; case 'skipped': return '·'; default: return '…';
  }
}
// 未来计划状态标签：pending=灰、confirmed=蓝、applied=绿
function planStatusStyle(s: string): string {
  switch (s) {
    case 'confirmed': return 'bg-blue-50 text-blue-600';
    case 'applied': return 'bg-emerald-50 text-emerald-600';
    default: return 'bg-slate-100 text-slate-500';
  }
}
function planStatusText(s: string): string {
  switch (s) {
    case 'confirmed': return '已确认';
    case 'applied': return '已执行';
    default: return '待确认';
  }
}
// 日期 "YYYY-MM-DD" → "MM-DD"，非法输入原样返回
function formatPlanDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}
// 日期 "YYYY-MM-DD" → 周几
function formatPlanWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}
