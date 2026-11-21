'use client';
import { useState, useEffect } from 'react';
import { apiGet, apiPut, apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Save, Sparkles, ChevronDown, ChevronUp, AlertCircle, CheckCircle, XCircle, Loader2 } from 'lucide-react';

const REQUIRED_AI_FIELDS = ['name', 'region', 'address', 'description'];

const PRESET_TAGS = [
  '避暑', '古镇', '庭院', '宠物友好', '亲子', '康养',
  '数字游民', '山景', '湖景', '温泉', '茶园',
  '民族风情', '烧烤', '采摘', '垂钓', '摄影',
  '徒步', '骑行', '免费停车', '接站服务', '长住优惠',
];

export default function PropertyProfilePage() {
  const [profile, setProfile] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    basic: true, facilities: true, policies: false, dining: false, transport: false, tags: false,
  });
  const [aiWriting, setAiWriting] = useState<'desc' | 'full' | null>(null);
  const [aiModal, setAiModal] = useState<{ open: boolean; status: 'validating' | 'generating' | 'success' | 'error'; message: string; count?: number }>({ open: false, status: 'validating', message: '' });
  // ===== 实景路线 / 老板娘语音（media_assets，category=route/voice） =====
  const [routeVideo, setRouteVideo] = useState<{ url: string; name: string } | null>(null);
  const [ownerVoice, setOwnerVoice] = useState<{ url: string; name: string } | null>(null);
  const [routeUploading, setRouteUploading] = useState(false);
  const [voiceUploading, setVoiceUploading] = useState(false);

  useEffect(() => {
    Promise.all([
      apiGet('/api/stores/current'),
      apiGet('/api/settings?type=business'),
      apiGet('/api/settings/property-profile'),
    ]).then(([storeRes, bizRes, profileRes]) => {
      const store = (storeRes as any)?.data || {};
      const biz = (bizRes as any)?.data || {};
      const existing = (profileRes as any)?.data || {};

      setProfile({
        // Store data
        name: existing.name || store.name || '',
        short_name: existing.short_name || store.shortName || '',
        phone: store.phone || '',
        address: existing.address || store.address || '',
        logo: store.logo || '',
        description: existing.description || '',
        full_description: existing.full_description || '',
        // Business policy data
        check_in_time: existing.check_in_time || biz.checkIn?.standardTime || '14:00',
        check_out_time: existing.check_out_time || '12:00',
        deposit_amount: existing.deposit_amount || biz.checkIn?.depositAmount || 0,
        pet_friendly: existing.pet_friendly ?? biz.checkIn?.allowPet ?? false,
        cancel_policy: existing.cancel_policy || (biz.booking?.allowCancel ? '支持免费取消' : ''),
        // Facilities from business data
        id_required: existing.id_required ?? biz.checkIn?.idRequired ?? true,
        // Existing profile data overrides everything
        ...existing,
      });
    }).finally(() => setLoading(false));
    // 加载实景路线视频 / 老板娘语音（首次进入档案页即回显已有素材）
    loadRouteMedia();
    loadVoiceMedia();
  }, []);

  const setField = (field: string, value: any) => setProfile(p => ({ ...p, [field]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiPut('/api/settings/property-profile', profile);
      toast.success('民宿档案已保存');
    } catch { toast.error('保存失败'); }
    finally { setSaving(false); }
  };

  const toggleSection = (key: string) => setOpenSections(s => ({ ...s, [key]: !s[key] }));

  const handleAIGenerate = async () => {
    // Step 1: Validate
    const missing = REQUIRED_AI_FIELDS.filter(f => !profile[f]);
    if (missing.length > 0) {
      setAiModal({ open: true, status: 'validating', message: `请先完善以下必填信息：\n${missing.map(f => ({name:'民宿名称',region:'区域',address:'详细地址',description:'一句话描述'}[f]||f)).join('、')}` });
      return;
    }

    // Step 2: Confirm
    setAiModal({ open: true, status: 'generating', message: 'AI 正在根据民宿信息生成周边推荐，预计需要 10-30 秒，请耐心等待...' });

    try {
      const res = await apiPost('/api/kb/ai-generate', {});
      if ((res as any).success) {
        setAiModal({ open: true, status: 'success', message: (res as any).message || '周边推荐已生成', count: (res as any).count });
      } else {
        setAiModal({ open: true, status: 'error', message: (res as any).error || '生成失败，请稍后重试' });
      }
    } catch {
      setAiModal({ open: true, status: 'error', message: '生成超时或网络异常，请稍后重试。提示：生成过程约需 20-30 秒，如果频繁超时可联系技术支持。' });
    }
  };

  const handleAIWrite = async (field: 'desc' | 'full') => {
    if (!profile.name || !profile.region) {
      toast.error('请先填写民宿名称和区域');
      return;
    }
    setAiWriting(field);
    try {
      const res = await apiPost('/api/kb/ai-assist', {
        type: field === 'desc' ? 'description' : 'full_description',
        context: {
          name: profile.name,
          region: profile.region,
          address: profile.address,
          tags: profile.tags,
          landmarks: profile.landmarks,
        }
      });
      if ((res as any).success) {
        if (field === 'desc') setProfile(p => ({ ...p, description: (res as any).data.text }));
        else setProfile(p => ({ ...p, full_description: (res as any).data.text }));
        toast.success('已生成');
      }
    } catch { toast.error('生成失败'); }
    finally { setAiWriting(null); }
  };

  const handleAILandmarks = async () => {
    if (!profile.region || !profile.address) {
      toast.error('请先填写区域和地址');
      return;
    }
    try {
      const res = await apiPost('/api/kb/ai-assist', {
        type: 'landmarks',
        context: { name: profile.name, region: profile.region, address: profile.address, geo_lat: profile.geo_lat, geo_lng: profile.geo_lng }
      });
      if ((res as any).success) {
        setProfile(p => ({ ...p, landmarks: (res as any).data.text }));
        toast.success('已生成周边地标');
      }
    } catch { toast.error('生成失败'); }
  };

  // 加载实景路线视频（/api/assets 返回 { assets, total }，取 assets 列表；dataMask 只作用于 /api/internal/*，本接口不受影响）
  const loadRouteMedia = async () => {
    try {
      const res = await apiGet('/api/assets?category=route');
      const list = res?.assets || [];
      setRouteVideo(list[0] ? { url: list[0].url, name: list[0].name || '' } : null);
    } catch { setRouteVideo(null); }
  };
  // 加载老板娘语音（同上，category=voice）
  const loadVoiceMedia = async () => {
    try {
      const res = await apiGet('/api/assets?category=voice');
      const list = res?.assets || [];
      setOwnerVoice(list[0] ? { url: list[0].url, name: list[0].name || '' } : null);
    } catch { setOwnerVoice(null); }
  };

  // 上传实景路线视频：/api/upload 返回 { success, url }，再落库 media_assets（category=route）
  const uploadRouteMedia = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setRouteUploading(true);
    try {
      const token = localStorage.getItem('pms_auth_token') || '';
      const storeId = localStorage.getItem('currentStoreId') || '';
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST', body: fd,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(storeId ? { 'X-Store-Id': storeId } : {}),
        },
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || '上传失败');
      await apiPost('/api/assets', { url: d.url, name: file.name, mediaType: 'video', category: 'route', tags: [] });
      await loadRouteMedia();
      toast.success('实景路线视频已上传，入住指南页同步展示');
    } catch (err: any) {
      toast.error(err?.message || '实景视频上传失败');
    } finally { setRouteUploading(false); }
  };
  // 上传老板娘语音：同样先传文件再落库（category=voice）
  const uploadVoiceMedia = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setVoiceUploading(true);
    try {
      const token = localStorage.getItem('pms_auth_token') || '';
      const storeId = localStorage.getItem('currentStoreId') || '';
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST', body: fd,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(storeId ? { 'X-Store-Id': storeId } : {}),
        },
      });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || '上传失败');
      await apiPost('/api/assets', { url: d.url, name: file.name, mediaType: 'audio', category: 'voice', tags: [] });
      await loadVoiceMedia();
      toast.success('老板娘语音已上传，入住指南页同步展示');
    } catch (err: any) {
      toast.error(err?.message || '语音上传失败');
    } finally { setVoiceUploading(false); }
  };

  const aiDisabled = REQUIRED_AI_FIELDS.some(f => !profile[f]);

  if (loading) return <div className="p-8">加载中...</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">民宿档案</h1>
        <div className="flex gap-3">
          <Button onClick={handleAIGenerate} variant="outline" disabled={aiDisabled} title={aiDisabled ? '请先完善民宿基本信息' : ''}>
            <Sparkles className="w-4 h-4 mr-1" />AI 生成周边推荐
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="w-4 h-4 mr-1" />{saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>

      {/* 基本信息 */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => toggleSection('basic')}>
          <CardTitle className="flex justify-between text-base">
            基本信息 {openSections.basic ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </CardTitle>
        </CardHeader>
        {openSections.basic && (
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-sm">民宿名称</label><Input value={profile.name || ''} onChange={e => setField('name', e.target.value)} /></div>
              <div><label className="text-sm">简称</label><Input value={profile.short_name || ''} onChange={e => setField('short_name', e.target.value)} /></div>
            </div>
            <div><label className="text-sm">详细地址</label><Input value={profile.address || ''} onChange={e => setField('address', e.target.value)} /></div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className="text-sm">区域</label><Input value={profile.region || ''} placeholder="如：花溪区" onChange={e => setField('region', e.target.value)} /></div>
              <div><label className="text-sm">纬度</label><Input type="number" step="0.000001" value={profile.geo_lat || ''} onChange={e => setField('geo_lat', e.target.value)} /></div>
              <div><label className="text-sm">经度</label><Input type="number" step="0.000001" value={profile.geo_lng || ''} onChange={e => setField('geo_lng', e.target.value)} /></div>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <a
                href="https://api.map.baidu.com/lbsapi/getpoint/index.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-500 hover:text-blue-600 flex items-center gap-1"
              >
                📍 百度地图拾取坐标
              </a>
              <span className="text-xs text-gray-400">（在新窗口点击地图获取经纬度，手动填入上方）</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm">周边地标（多行）</label>
                <Button size="sm" variant="ghost" onClick={handleAILandmarks}>
                  <Sparkles className="w-3 h-3 mr-1" />AI获取周边地标
                </Button>
              </div>
              <Textarea rows={2} value={profile.landmarks || ''} onChange={e => setField('landmarks', e.target.value)} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm">一句话描述</label>
                <Button size="sm" variant="ghost" onClick={() => handleAIWrite('desc')} disabled={!!aiWriting}>
                  <Sparkles className="w-3 h-3 mr-1" />{aiWriting === 'desc' ? '生成中...' : 'AI帮写'}
                </Button>
              </div>
              <Input value={profile.description || ''} onChange={e => setField('description', e.target.value)} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm">详细介绍（AI上下文用）</label>
                <Button size="sm" variant="ghost" onClick={() => handleAIWrite('full')} disabled={!!aiWriting}>
                  <Sparkles className="w-3 h-3 mr-1" />{aiWriting === 'full' ? '生成中...' : 'AI帮写'}
                </Button>
              </div>
              <Textarea rows={3} value={profile.full_description || ''} onChange={e => setField('full_description', e.target.value)} />
            </div>
          </CardContent>
        )}
      </Card>

      {/* 设施服务 */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => toggleSection('facilities')}>
          <CardTitle className="flex justify-between text-base">设施服务 {openSections.facilities ? <ChevronUp /> : <ChevronDown />}</CardTitle>
        </CardHeader>
        {openSections.facilities && (
          <CardContent>
            <div className="grid grid-cols-4 gap-3">
              {['wifi','parking','laundry','pet_friendly','elevator','garden'].map(k => (
                <div key={k} className="flex items-center gap-2">
                  <Switch checked={!!profile[k]} onCheckedChange={v => setField(k, v)} />
                  <span className="text-sm">{{wifi:'WiFi',parking:'停车场',laundry:'洗衣',pet_friendly:'宠物友好',elevator:'电梯',garden:'庭院'}[k]}</span>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <label className="text-sm">餐食提供</label>
              <Input value={profile.meals_included || ''} placeholder="如：含三餐 / 含早餐" onChange={e => setField('meals_included', e.target.value)} />
            </div>
          </CardContent>
        )}
      </Card>

      {/* 入住政策 */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => toggleSection('policies')}>
          <CardTitle className="flex justify-between text-base">入住政策 {openSections.policies ? <ChevronUp /> : <ChevronDown />}</CardTitle>
        </CardHeader>
        {openSections.policies && (
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-sm">入住时间</label><Input value={profile.check_in_time || ''} placeholder="如：14:00" onChange={e => setField('check_in_time', e.target.value)} /></div>
              <div><label className="text-sm">退房时间</label><Input value={profile.check_out_time || ''} placeholder="如：12:00" onChange={e => setField('check_out_time', e.target.value)} /></div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={!!profile.pet_allowed} onCheckedChange={v => setField('pet_allowed', v)} />
              <span className="text-sm">允许携带宠物</span>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={!!profile.smoking_allowed} onCheckedChange={v => setField('smoking_allowed', v)} />
              <span className="text-sm">允许室内吸烟</span>
            </div>
            <div><label className="text-sm">其他政策说明</label><Textarea rows={2} value={profile.policy_notes || ''} placeholder="如：儿童政策、加床政策等" onChange={e => setField('policy_notes', e.target.value)} /></div>
          </CardContent>
        )}
      </Card>

      {/* 餐饮信息 */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => toggleSection('dining')}>
          <CardTitle className="flex justify-between text-base">餐饮信息 {openSections.dining ? <ChevronUp /> : <ChevronDown />}</CardTitle>
        </CardHeader>
        {openSections.dining && (
          <CardContent className="space-y-3">
            <div><label className="text-sm">早餐供应</label><Input value={profile.breakfast_info || ''} placeholder="如：中式早餐 8:00-10:00" onChange={e => setField('breakfast_info', e.target.value)} /></div>
            <div><label className="text-sm">餐厅介绍</label><Textarea rows={2} value={profile.dining_description || ''} placeholder="描述餐厅环境、特色菜品等" onChange={e => setField('dining_description', e.target.value)} /></div>
            <div><label className="text-sm">特色菜品推荐</label><Textarea rows={2} value={profile.specialty_dishes || ''} placeholder="多行输入，每行一个推荐菜品" onChange={e => setField('specialty_dishes', e.target.value)} /></div>
          </CardContent>
        )}
      </Card>

      {/* 交通指引 */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => toggleSection('transport')}>
          <CardTitle className="flex justify-between text-base">交通指引 {openSections.transport ? <ChevronUp /> : <ChevronDown />}</CardTitle>
        </CardHeader>
        {openSections.transport && (
          <CardContent className="space-y-3">
            <div><label className="text-sm">到达指引</label><Textarea rows={3} value={profile.transport_guide || ''} placeholder="如何到达民宿，含机场/火车站/自驾路线" onChange={e => setField('transport_guide', e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-sm">最近机场</label><Input value={profile.nearest_airport || ''} placeholder="如：贵阳龙洞堡机场" onChange={e => setField('nearest_airport', e.target.value)} /></div>
              <div><label className="text-sm">最近火车站</label><Input value={profile.nearest_station || ''} placeholder="如：贵阳北站" onChange={e => setField('nearest_station', e.target.value)} /></div>
            </div>
            <div><label className="text-sm">停车信息</label><Input value={profile.parking_info || ''} placeholder="如：免费停车 / 收费停车" onChange={e => setField('parking_info', e.target.value)} /></div>
          </CardContent>
        )}
      </Card>

      {/* 特色标签 */}
      <Card>
        <CardHeader className="cursor-pointer" onClick={() => toggleSection('tags')}>
          <CardTitle className="flex justify-between text-base">特色标签 {openSections.tags ? <ChevronUp /> : <ChevronDown />}</CardTitle>
        </CardHeader>
        {openSections.tags && (
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {PRESET_TAGS.map(tag => {
                const selected = (profile.tags || []).includes(tag);
                return (
                  <span
                    key={tag}
                    onClick={() => {
                      const tags: string[] = profile.tags || [];
                      setProfile(p => ({ ...p, tags: selected ? tags.filter(t => t !== tag) : [...tags, tag] }));
                    }}
                    className={`px-2.5 py-1 rounded-full text-xs cursor-pointer transition-colors ${
                      selected ? 'bg-indigo-100 text-indigo-700 border border-indigo-300' : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'
                    }`}
                  >
                    {tag}
                  </span>
                );
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {/* 实景路线 / 老板娘语音（入住指南调用） */}
      <div className="mt-6 rounded-xl border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-1">实景路线 & 老板娘语音</h3>
        <p className="text-xs text-gray-400 mb-3">上传后，客户在入住指南页可观看实景路线视频、收听老板娘语音导览（同门店仅展示最新一条，重复上传即更新）。</p>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-500 mb-1">实景路线视频（mp4/mov/webm，≤200MB）</div>
              {routeVideo ? (
                <div className="text-xs text-green-600 flex items-center gap-2">
                  <span className="truncate">{routeVideo.name}</span>
                  <button type="button" className="underline" onClick={() => document.getElementById('route-video-input')?.click()}>重新上传</button>
                </div>
              ) : (
                <div className="text-xs text-gray-400">尚未上传</div>
              )}
            </div>
            <input
              id="route-video-input"
              type="file"
              accept="video/*"
              className="hidden"
              disabled={routeUploading}
              onChange={uploadRouteMedia}
            />
            <button
              type="button"
              disabled={routeUploading}
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              onClick={() => document.getElementById('route-video-input')?.click()}
            >
              {routeUploading ? '上传中...' : (routeVideo ? '更换视频' : '上传视频')}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-500 mb-1">老板娘语音（mp3/wav/m4a，≤20MB）</div>
              {ownerVoice ? (
                <div className="text-xs text-green-600 flex items-center gap-2">
                  <span className="truncate">{ownerVoice.name}</span>
                  <button type="button" className="underline" onClick={() => document.getElementById('owner-voice-input')?.click()}>重新上传</button>
                </div>
              ) : (
                <div className="text-xs text-gray-400">尚未上传</div>
              )}
            </div>
            <input
              id="owner-voice-input"
              type="file"
              accept="audio/*"
              className="hidden"
              disabled={voiceUploading}
              onChange={uploadVoiceMedia}
            />
            <button
              type="button"
              disabled={voiceUploading}
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              onClick={() => document.getElementById('owner-voice-input')?.click()}
            >
              {voiceUploading ? '上传中...' : (ownerVoice ? '更换语音' : '上传语音')}
            </button>
          </div>
        </div>
      </div>

      {/* AI 生成进度弹窗 */}
      <Dialog open={aiModal.open} onOpenChange={(open) => setAiModal(p => ({ ...p, open }))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {aiModal.status === 'validating' && <><AlertCircle className="w-5 h-5 text-amber-500" /> 信息不完整</>}
              {aiModal.status === 'generating' && <><Loader2 className="w-5 h-5 text-indigo-500 animate-spin" /> 正在生成周边推荐</>}
              {aiModal.status === 'success' && <><CheckCircle className="w-5 h-5 text-green-500" /> 生成完成</>}
              {aiModal.status === 'error' && <><XCircle className="w-5 h-5 text-red-500" /> 生成失败</>}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-gray-600 whitespace-pre-line">{aiModal.message}</p>
            {aiModal.status === 'generating' && (
              <div className="mt-4 space-y-2">
                <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div className="bg-indigo-500 h-2 rounded-full animate-pulse" style={{ width: '60%' }} />
                </div>
                <p className="text-xs text-gray-400 text-center">正在调用 AI 模型分析民宿信息...</p>
              </div>
            )}
          </div>
          <DialogFooter>
            {aiModal.status === 'validating' && (
              <Button onClick={() => setAiModal(p => ({ ...p, open: false }))}>知道了，去完善</Button>
            )}
            {aiModal.status === 'success' && (
              <Button onClick={() => { setAiModal(p => ({ ...p, open: false })); window.location.href = '/kb-guides'; }}>
                去审核发布 ({aiModal.count || 0} 条)
              </Button>
            )}
            {aiModal.status === 'error' && (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setAiModal(p => ({ ...p, open: false }))}>关闭</Button>
                <Button onClick={() => { setAiModal(p => ({ ...p, open: false })); setTimeout(handleAIGenerate, 500); }}>重试</Button>
              </div>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
