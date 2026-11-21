'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ShieldCheck } from 'lucide-react';

const STATUS_MAP: Record<string, string> = {
  reviewing: '平台审核中',
  wx_submitted: '已提交微信',
  wx_verifying: '待账户验证',
  wx_signing: '待签约',
  finished: '已完成',
  rejected: '平台驳回',
  wx_rejected: '微信驳回',
};

export default function PlatformPage() {
  const [applications, setApplications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [rejectForm, setRejectForm] = useState<{ id: string; reason: string; show: boolean }>({ id: '', reason: '', show: false });
  const [finishForm, setFinishForm] = useState<{ id: string; subMchid: string; show: boolean }>({ id: '', subMchid: '', show: false });
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : '';
      const data = await apiGet(`/api/platform/applications${qs}`);
      setApplications(data || []);
    } catch (err: any) {
      setMsg(err?.error || '加载失败（需要平台运营权限）');
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [statusFilter]);

  async function review(id: string, action: string, extra?: Record<string, any>) {
    setMsg('');
    try {
      await apiPost('/api/platform/applications/review', { id, action, ...(extra || {}) });
      setMsg('操作成功');
      load();
    } catch (err: any) {
      setMsg(err?.error || '操作失败');
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="平台运营" subtitle="进件审核与商家管理" icon={<ShieldCheck className="w-5 h-5" />} />

      {msg && (
        <div className={`mx-6 mt-2 px-4 py-2 rounded text-sm ${msg.includes('成功') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg}
        </div>
      )}

      <div className="px-6 py-2 flex gap-2 flex-wrap">
        {['', 'reviewing', 'wx_submitted', 'finished', 'rejected'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded text-sm border ${statusFilter === s ? 'bg-slate-700 text-white border-slate-700' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            {s ? STATUS_MAP[s] : '全部'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-6 text-slate-500">加载中...</div>
      ) : (
        <div className="overflow-x-auto p-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-600">
                <th className="text-left px-4 py-3 font-medium">门店</th>
                <th className="text-left px-4 py-3 font-medium">联系人</th>
                <th className="text-left px-4 py-3 font-medium">状态</th>
                <th className="text-left px-4 py-3 font-medium">特约商户号</th>
                <th className="text-left px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {applications.map((a: any) => (
                <tr key={a.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{a.storeName}</div>
                    <div className="text-xs text-slate-400">{a.storeId}</div>
                  </td>
                  <td className="px-4 py-3">{a.contact?.name} {a.contact?.phone}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      a.status === 'finished' ? 'bg-green-100 text-green-700' :
                      a.status === 'rejected' || a.status === 'wx_rejected' ? 'bg-red-100 text-red-700' :
                      'bg-amber-100 text-amber-700'
                    }`}>{STATUS_MAP[a.status] || a.status}</span>
                    {a.rejectReason && <div className="text-xs text-red-500 mt-0.5">{a.rejectReason}</div>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{a.subMchid || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 flex-wrap">
                      {a.status === 'reviewing' && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => review(a.id, 'approve')}>通过</Button>
                          <Button size="sm" variant="outline" className="text-red-500" onClick={() => setRejectForm({ id: a.id, reason: '', show: true })}>驳回</Button>
                        </>
                      )}
                      {(a.status === 'wx_submitted' || a.status === 'wx_verifying' || a.status === 'wx_signing') && (
                        <Button size="sm" variant="outline" className="text-green-600" onClick={() => setFinishForm({ id: a.id, subMchid: a.subMchid || '', show: true })}>
                          回填商户号
                        </Button>
                      )}
                      {a.status === 'wx_rejected' && (
                        <Button size="sm" variant="outline" onClick={() => review(a.id, 'approve')}>重新提交</Button>
                      )}
                      {a.status === 'finished' && (
                        <span className="text-xs text-slate-400">已完成</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {applications.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">暂无进件申请</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 驳回弹窗 */}
      {rejectForm.show && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setRejectForm({ ...rejectForm, show: false })}>
          <div className="bg-white rounded-xl p-6 w-96 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-medium mb-3">驳回申请</h3>
            <textarea className="w-full border rounded p-2 text-sm" rows={3} placeholder="填写驳回原因..."
              value={rejectForm.reason} onChange={e => setRejectForm({ ...rejectForm, reason: e.target.value })} />
            <div className="flex gap-2 mt-3 justify-end">
              <Button size="sm" variant="outline" onClick={() => setRejectForm({ id: '', reason: '', show: false })}>取消</Button>
              <Button size="sm" onClick={() => { review(rejectForm.id, 'reject', { rejectReason: rejectForm.reason }); setRejectForm({ id: '', reason: '', show: false }); }} disabled={!rejectForm.reason.trim()}>确认驳回</Button>
            </div>
          </div>
        </div>
      )}

      {/* 回填商户号弹窗 */}
      {finishForm.show && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setFinishForm({ ...finishForm, show: false })}>
          <div className="bg-white rounded-xl p-6 w-96 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-medium mb-3">完成进件——回填特约商户号</h3>
            <input className="w-full border rounded p-2 text-sm" placeholder="sub_mchid（微信服务商后台获取）"
              value={finishForm.subMchid} onChange={e => setFinishForm({ ...finishForm, subMchid: e.target.value })} />
            <div className="flex gap-2 mt-3 justify-end">
              <Button size="sm" variant="outline" onClick={() => setFinishForm({ id: '', subMchid: '', show: false })}>取消</Button>
              <Button size="sm" onClick={() => { review(finishForm.id, 'finish', { subMchid: finishForm.subMchid }); setFinishForm({ id: '', subMchid: '', show: false }); }} disabled={!finishForm.subMchid.trim()}>确认完成</Button>
            </div>
          </div>
        </div>
      )}

      {/* 分账监控（M3 MVP：佣金记录概览，实际分账为人工代付模式） */}
      <div className="px-6 pb-6 mt-8">
        <h3 className="text-sm font-medium text-slate-700 mb-2">💰 分销佣金监控</h3>
        <p className="text-xs text-slate-400 mb-3">M3 MVP 阶段：佣金解冻后由平台运营人工转账，正式版对接微信分账 API</p>
        <div className="text-sm text-slate-500">
          佣金数据请通过商家侧「私域门店 → 分销管理」查看各推广员明细。
        </div>
      </div>
    </div>
  );
}
