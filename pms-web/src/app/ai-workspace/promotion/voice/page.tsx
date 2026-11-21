'use client';
import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { AssetPicker } from '@/components/promotion/asset-picker';
import { showToast, ToastContainer } from '@/components/promotion/toast';

function QRCodeBox({ text }: { text: string }) {
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=5&data=${encodeURIComponent(text)}`;
  return <img src={qrSrc} className="mx-auto rounded-xl w-[180px] h-[180px]" alt="QR" />;
}

interface DemoItem { text: string; audioUrl?: string; }
interface IMSVoice { voiceId: string; voiceName: string; gender: string; type: string; }

export default function IMSVoiceClonePage() {
  const [tab, setTab] = useState<'ims' | 'bailian'>('bailian');

  // ====== 百炼克隆状态 ======
  const [blName, setBlName] = useState('');
  const [blAudioUrl, setBlAudioUrl] = useState('');
  const [blLoading, setBlLoading] = useState(false);
  const [blVoices, setBlVoices] = useState<any[]>([]);
  const loadBlVoices = () => {
    apiGet('/api/voice/list').then((d: any) => { if (d.success) setBlVoices((d.data||[]).filter((v:any)=>v.source!=='ims')); }).catch(() => {});
  };
  useEffect(() => { loadBlVoices(); }, []);
  const handleBailianClone = async () => {
    if (!blName || !blAudioUrl) { showToast('请填写音色名称并上传音频', 'error'); return; }
    setBlLoading(true);
    try {
      const r = await apiPost('/api/voice/create', { name: blName, sampleUrl: blAudioUrl });
      if (r.success) { showToast('✅ ' + r.message, 'success'); setBlName(''); setBlAudioUrl(''); loadBlVoices(); }
      else showToast(r.error || '克隆失败', 'error');
    } catch { showToast('请求失败', 'error'); }
    setBlLoading(false);
  };

  // VoiceId 随机生成，避免门店间重复（IMS 要求 ≤32 字符，仅字母数字）
  const newVoiceId = () => {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    return `pms${ts}${rnd}`;
  };
  const [voiceId, setVoiceId] = useState(newVoiceId);
  const [voiceName, setVoiceName] = useState('');
  const [gender, setGender] = useState<'female' | 'male'>('female');
  // scenario 固定为 story（有声书），适配民宿口播配音场景
  const [jobId, setJobId] = useState('');
  const [demos, setDemos] = useState<DemoItem[]>([]);
  const [recordings, setRecordings] = useState<Record<number, string>>({});
  const [detectResults, setDetectResults] = useState<Record<number, { passed: boolean; reason?: string }>>({});
  const [detecting, setDetecting] = useState<Record<number, boolean>>({});
  const [trainingStatus, setTrainingStatus] = useState('');
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [imsList, setImsList] = useState<IMSVoice[]>([]);
  const [uploadIdx, setUploadIdx] = useState(-1);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [qrModal, setQrModal] = useState<{ show: boolean; sentence: string; index: number }>({ show: false, sentence: '', index: 0 });
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<any>(null);
  const [statusModal, setStatusModal] = useState<{ show: boolean; data: any }>({ show: false, data: null });
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  // 音色库
  const [libraryVoices, setLibraryVoices] = useState<any[]>([]);
  const [previewVoice, setPreviewVoice] = useState<any>(null);
  const [previewText, setPreviewText] = useState('');
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'submitting' | 'processing' | 'done'>('idle');
  const [previewAudioUrl, setPreviewAudioUrl] = useState('');
  const [previewMsg, setPreviewMsg] = useState('');

  // 快捷试听文案
  const QUICK_TEXTS = [
    '欢迎来到智宿管家，我是您的专属管家，很高兴为您服务。',
    '这间行政套房，全屋智能控制，窗外就是城市夜景，今晚就住这儿吧。',
    '周末特惠来袭！连住两晚直接打八折，还送双人早餐和下午茶。',
    '晚安，愿您在这个温馨的房间里，卸下所有疲惫，做个好梦。',
  ];
  const detectCount = Object.values(detectResults).filter(r => r.passed).length;
  const allDetected = demos.length > 0 && detectCount >= demos.length;

  const loadTasks = () => {
    apiGet('/api/voice/ims/list').then((d: any) => { if (d.success) setImsList(d.data || []); }).catch(() => {});
  };
  // 回填任务数据到表单
  const resumeTask = (t: any) => {
    setVoiceId(t.voiceId);
    setVoiceName(t.voiceName || '');
    setGender(t.gender || 'female');
    if (t.demos?.length) setDemos(t.demos);
    if (t.recordings) setRecordings(t.recordings);
    if (t.detectResults) setDetectResults(t.detectResults);
    if (t.jobId) setJobId(t.jobId);
    setCurrentStep(t.currentStep || 1);
    setTrainingStatus(t.status || '');
  };

  // 从 DB 恢复当前任务进度（页面刷新后保持状态）
  const loadCurrentTask = () => {
    if (!voiceId) return;
    apiGet('/api/voice/ims/list').then((d: any) => {
      if (d.success) {
        setImsList(d.data || []);
        const t = (d.data || []).find((t: any) => t.voiceId === voiceId);
        if (t) {
          resumeTask(t);
        }
      }
    }).catch(() => {});
  };
  useEffect(() => { loadCurrentTask(); }, [voiceId]);

  // 手机录音轮询
  useEffect(() => {
    if (!voiceId) return;
    const timer = setInterval(async () => {
      try {
        const res = await apiGet(`/api/voice/ims/recordings?voiceId=${voiceId}`);
        if (res.success && res.data) {
          const bindings: Record<string, string> = res.data;
          let updated = false;
          setRecordings(prev => {
            const newRecs = { ...prev };
            Object.entries(bindings).forEach(([k, v]) => {
              const ki = parseInt(k);
              if (v && prev[ki] !== v) { newRecs[ki] = v as string; updated = true; }
            });
            return updated ? newRecs : prev;
          });
          if (updated) setDetectResults(prev => {
            const nd = { ...prev };
            Object.keys(bindings).forEach(k => delete nd[parseInt(k)]);
            return nd;
          });
        }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [voiceId]);

  // ====== 加载音色库 ======
  const loadLibrary = () => {
    apiGet('/api/voice/list').then((d: any) => {
      if (d.success) setLibraryVoices(d.data || []);
    }).catch(() => {});
  };
  useEffect(() => { loadLibrary(); }, []);

  // ====== 设为默认音色 ======
  const handleSetDefault = async (id: string) => {
    const r = await apiPost(`/api/voice/${id}/set-default`, {});
    if (r.success) { showToast(r.message, 'success'); loadLibrary(); }
    else showToast(r.error || '操作失败', 'error');
  };

  // ====== 提交试听 ======
  const handlePreviewSubmit = async () => {
    if (!previewVoice || !previewText.trim()) return;
    setPreviewStatus('submitting');
    try {
      const r = await apiPost('/api/voice/preview', { voiceId: previewVoice.aliyunVoiceId, text: previewText.trim() });
      if (!r.success) { setPreviewMsg('❌ ' + (r.error || '提交失败')); setPreviewStatus('idle'); return; }

      const jobId = r.data.jobId;
      setPreviewStatus('processing');
      setPreviewMsg('⏳ 合成中，大约需要30秒...');

      // 轮询直到完成
      const poll = setInterval(async () => {
        try {
          const s = await apiGet(`/api/voice/preview-status?jobId=${jobId}`);
          if (s.success) {
            if (s.data.status === 'completed' && s.data.audioUrl) {
              clearInterval(poll);
              setPreviewAudioUrl(s.data.audioUrl);
              setPreviewStatus('done');
              setPreviewMsg('');
              new Audio(s.data.audioUrl).play();
            } else if (s.data.status === 'failed') {
              clearInterval(poll);
              setPreviewMsg('❌ 合成失败，请重试');
              setPreviewStatus('idle');
            }
          }
        } catch {}
      }, 2000);
      setTimeout(() => clearInterval(poll), 120000); // 2分钟超时
    } catch { setPreviewMsg('❌ 请求失败'); setPreviewStatus('idle'); }
  };

  const handleNewTask = () => setShowResetConfirm(true);
  const confirmNewTask = () => {
    setVoiceId(newVoiceId()); setVoiceName(''); setGender('female');
    setJobId(''); setDemos([]); setRecordings({}); setDetectResults({});
    setTrainingStatus(''); setCurrentStep(1); setMsg(''); setShowResetConfirm(false);
  };

  const handleCreate = async () => {
    const cleanId = voiceId.trim();
    if (!cleanId || !gender) return;
    setVoiceId(cleanId);
    setLoading(true);
    try {
      const res = await apiPost('/api/voice/ims/create', { voiceId: cleanId, voiceName: voiceName.trim() || cleanId, gender, scenario: 'story' });
      if (res.success) { setJobId(res.data.jobId); setCurrentStep(2); setMsg('✅ 任务创建成功'); }
      else {
        const errMsg = res.error || '';
        if (errMsg.includes('AlreadyExists') || errMsg.includes('already exists'))
          setMsg(`⚠️ VoiceId "${voiceId}" 已存在，请换一个名称`);
        else setMsg('❌ ' + errMsg);
      }
    } catch { setMsg('创建失败'); }
    setLoading(false);
  };

  const handleGetDemo = async () => {
    setLoading(true);
    try {
      const res = await apiGet(`/api/voice/ims/demo?voiceId=${voiceId}`);
      if (res.success) { setDemos(res.data.demonstrations || []); setCurrentStep(3); }
      else setMsg('❌ ' + res.error);
    } catch { setMsg('获取失败'); }
    setLoading(false);
  };

  const handleUpload = (index: number) => { setUploadIdx(index); setAssetPickerOpen(true); };

  const handleDetect = async (index: number) => {
    const audioUrl = recordings[index]; if (!audioUrl) return;
    setDetecting(p => ({ ...p, [index]: true }));
    try {
      const res = await apiPost('/api/voice/ims/detect', { voiceId, index, audioUrl });
      if (res.success) {
        setDetectResults(p => { const n = { ...p, [index]: res.data }; return n; });
        if (!res.data.passed) {
          setRecordings(p => { const n = { ...p }; delete n[index]; return n; });
          setMsg(`第${index+1}句未通过，请重新录制`);
        }
      }
    } catch {}
    setDetecting(p => ({ ...p, [index]: false }));
  };

  const handleDetectAll = async () => {
    for (let i = 0; i < demos.length; i++)
      if (recordings[i] && !detectResults[i]) await handleDetect(i);
    setCurrentStep(4);
  };

  const startPolling = (jId: string, vid: string) => {
    const timer = setInterval(async () => {
      try {
        const s = await apiGet(`/api/voice/ims/status?jobId=${jId}`);
        if (s.success) {
          setTrainingStatus(s.data.status);
          if (s.data.status === 'Success') { clearInterval(timer); setImsList(p => [...p, { voiceId: vid, voiceName: voiceName || vid, gender, type: 'Basic' }]); }
          if (s.data.status === 'Fail') clearInterval(timer);
        }
      } catch {}
    }, 5000);
  };

  const handleSubmitTraining = async () => {
    setLoading(true);
    try {
      const res = await apiPost('/api/voice/ims/submit', { voiceId });
      if (res.success) { setCurrentStep(5); startPolling(res.data?.jobId || jobId, voiceId); }
      else setMsg('❌ ' + res.error);
    } catch { setMsg('提交失败'); }
    setLoading(false);
  };

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-violet-50 flex flex-col">
      <div className="flex items-center justify-between px-6 py-2 bg-white/90 backdrop-blur border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center text-lg shadow-md">🎤</div>
          {/* IMS克隆入口暂时隐藏，仅显示百炼复刻 */}
          {/* <div className="flex gap-1 mr-4">
            <button onClick={() => setTab('ims')} className={...}>📡 IMS克隆</button>
            <button onClick={() => setTab('bailian')} className={...}>⚡ 百炼复刻</button>
          </div> */}
          <div><h1 className="text-sm font-bold text-slate-800">百炼声音复刻</h1><p className="text-[10px] text-slate-400">即时版 · 3-30秒音频</p></div>
        </div>
        <div className="flex items-center gap-3">
          {msg && <span className="text-xs text-slate-500">{msg}</span>}
          <a href="/voice-record" target="_blank" className="text-xs px-3 py-1 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100">📱 手机录音</a>
          {currentStep > 1 && (
            <button onClick={handleNewTask} className="text-xs px-3 py-1 bg-slate-100 text-slate-500 rounded-lg hover:bg-red-50 hover:text-red-500">+ 新任务</button>
          )}
        </div>
      </div>

      <div className="flex-1 flex gap-5 p-5 min-h-0" style={{display: tab === 'ims' ? 'flex' : 'none'}}>
        {/* Left */}
        <div className="flex-1 flex flex-col gap-4 min-h-0">
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex-shrink-0">
            <div className="flex items-end gap-4">
              <div className="flex-1 grid grid-cols-4 gap-3">
                <div><label className="text-xs text-slate-400 block mb-1">① VoiceId</label><div className="w-full px-3 py-2 border rounded-lg text-sm bg-slate-50 text-slate-500 font-mono text-xs truncate" title={voiceId}>{voiceId}</div></div>
                <div><label className="text-xs text-slate-400 block mb-1">中文名</label><input value={voiceName} onChange={e => setVoiceName(e.target.value)} placeholder="我的声音" className="w-full px-3 py-2 border rounded-lg text-sm" disabled={currentStep > 1} /></div>
                <div><label className="text-xs text-slate-400 block mb-1">性别</label><select value={gender} onChange={e => setGender(e.target.value as any)} className="w-full px-3 py-2 border rounded-lg text-sm" disabled={currentStep > 1}><option value="female">女</option><option value="male">男</option></select></div>
                <div><label className="text-xs text-slate-400 block mb-1">场景</label><div className="w-full px-3 py-2 border rounded-lg text-sm bg-slate-50 text-slate-600">📖 有声书</div></div>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={handleCreate} disabled={!voiceId || loading || currentStep > 1} className="px-5 py-2 bg-violet-500 text-white rounded-lg text-sm font-bold disabled:opacity-50">① 创建</button>
                {currentStep >= 2 && <button onClick={handleGetDemo} disabled={demos.length > 0} className="px-5 py-2 bg-violet-50 text-violet-600 rounded-lg text-sm font-bold">② 获取文本</button>}
              </div>
            </div>
          </div>
          {currentStep >= 2 && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between mb-3 flex-shrink-0">
                <h3 className="text-sm font-bold text-slate-700">③④ 录制 & 检测（{detectCount}/{demos.length} 通过）</h3>
                <div className="flex gap-2">
                  {currentStep >= 3 && (<>
                    <button onClick={handleDetectAll} disabled={!Object.keys(recordings).length} className="px-4 py-1.5 bg-violet-50 text-violet-600 rounded-lg text-xs font-bold">全部检测</button>
                    <button onClick={handleSubmitTraining} disabled={!allDetected || currentStep >= 5} className={`px-4 py-1.5 rounded-lg text-xs font-bold ${currentStep >= 5 ? 'bg-green-100 text-green-600' : 'bg-violet-500 text-white'} disabled:opacity-50`}>{currentStep >= 5 ? '⑤ 已提交 ✓' : '⑤ 提交训练'}</button>
                  </>)}
                </div>
              </div>
              {currentStep >= 5 && (
                <div className={`mb-3 px-3 py-2 rounded-lg text-xs font-medium flex-shrink-0 ${trainingStatus === 'Success' ? 'bg-green-50 text-green-700' : trainingStatus === 'Fail' ? 'bg-red-50 text-red-600' : 'bg-violet-50 text-violet-600'}`}>
                  ⑥ {trainingStatus || '处理中...'}{trainingStatus === 'Success' && ` · VoiceId: ${voiceId} 可在混剪/模板中使用`}
                </div>
              )}
              {demos.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">点击上方「获取文本」拿到20句示范文案</p>
              ) : (
                <div className="flex-1 overflow-y-auto custom-scroll grid grid-cols-2 gap-x-6 gap-y-1.5 auto-rows-min content-start">
                  {demos.map((d, i) => (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <span className="text-xs text-slate-400 w-5 flex-shrink-0">{i + 1}</span>
                      <span className="text-xs text-slate-600 truncate flex-1" title={d.text}>{d.text}</span>
                      {recordings[i] ? (<>
                        <button onClick={() => { const a = new Audio(recordings[i]); a.play(); }} className="text-[11px] px-1.5 py-1 bg-green-50 text-green-600 rounded flex-shrink-0" title="试听">▶</button>
                        {detectResults[i] ? (
                          <span className={`text-xs flex-shrink-0 ${detectResults[i].passed ? 'text-green-600' : 'text-red-500'}`}>{detectResults[i].passed ? '✅' : '❌'}</span>
                        ) : (
                          <button onClick={() => handleDetect(i)} className="text-[11px] px-2 py-1 bg-violet-50 text-violet-600 rounded flex-shrink-0">检测</button>
                        )}
                        <button onClick={() => handleUpload(i)} className="text-[11px] px-2 py-1 bg-slate-50 text-slate-400 rounded flex-shrink-0 hover:text-slate-600">重传</button>
                      </>) : (
                        <button onClick={() => handleUpload(i)} className="text-[11px] px-2 py-1 bg-amber-50 text-amber-600 rounded flex-shrink-0">选择</button>
                      )}
                      <button onClick={() => setQrModal({ show: true, sentence: d.text, index: i })} className="text-[11px] px-1.5 py-1 bg-sky-50 text-sky-600 rounded flex-shrink-0" title="手机扫码录音">📱</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {/* Right */}
        <div className="w-[300px] flex-shrink-0 space-y-4 flex flex-col">
          {/* 🎤 我的音色库 */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-400">🎤 我的音色库 ({libraryVoices.length})</h3>
              <button onClick={loadLibrary} className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-lg hover:bg-slate-200">🔄</button>
            </div>
            {libraryVoices.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">暂无音色，训练成功后点击「+音色库」添加</p>
            ) : (
              <div className="space-y-1.5">
                {libraryVoices.map((v: any) => (
                  <div key={v.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg text-xs">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-slate-700 truncate block">{v.name}</span>
                      <code className="text-[10px] text-slate-400">{v.aliyunVoiceId}</code>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      {!v.isDefault && (
                        <button onClick={() => handleSetDefault(v.id)} className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded hover:bg-amber-100">默认</button>
                      )}
                      {v.isDefault && <span className="text-[10px] px-1.5 py-0.5 bg-green-50 text-green-600 rounded">默认</span>}
                      <button onClick={() => { setPreviewVoice(v); setPreviewText(''); setPreviewStatus('idle'); setPreviewAudioUrl(''); setPreviewMsg(''); }}
                        className="text-[10px] px-1.5 py-0.5 bg-violet-50 text-violet-600 rounded hover:bg-violet-100">试听</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex-shrink-0">
            <h3 className="text-xs font-semibold text-slate-400 mb-3">📋 步骤</h3>
            <div className="space-y-2">
              {['创建任务','获取示范文本','录制音频','逐句检测','提交训练','训练完成'].map((label, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${currentStep > i+1 ? 'bg-green-100 text-green-600' : currentStep === i+1 ? 'bg-violet-100 text-violet-600' : 'bg-slate-100 text-slate-400'}`}>{currentStep > i+1 ? '✓' : i+1}</span>
                  <span className={`text-xs ${currentStep >= i+1 ? 'text-slate-700 font-medium' : 'text-slate-400'}`}>{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <h3 className="text-xs font-semibold text-slate-400">🎤 任务列表</h3>
              <button onClick={loadTasks} className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded">🔄 刷新</button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scroll space-y-1.5">
              {imsList.length === 0 ? <p className="text-xs text-slate-400 text-center py-4">暂无任务</p> :
                imsList.map((t: any) => (
                  <div key={t.id} onClick={() => { if (t.status !== 'Success') setResumeTarget(t); }}
                    className={`text-xs p-2 rounded-lg border cursor-pointer transition-colors ${t.status === 'Success' || t.status === 'Trained' ? 'bg-green-50 border-green-100' : t.status === 'Fail' ? 'bg-red-50 border-red-100 hover:bg-red-100' : 'bg-amber-50 border-amber-100 hover:bg-amber-100'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-700">{t.voiceName || t.voiceId}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        t.status === 'Success' ? 'bg-green-100 text-green-600' :
                        t.status === 'Fail' ? 'bg-red-100 text-red-500' :
                        'bg-amber-100 text-amber-600'
                      }`}>
                        {t.status === 'Success' ? '✅ 完成' : t.status === 'Fail' ? '❌ 失败' : `步骤${t.currentStep||1}`}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <code className="text-[10px] text-slate-400">{t.voiceId}</code>
                      <div className="flex gap-1">
                        {t.jobId && <button onClick={(e) => { e.stopPropagation();
                          const jId = t.trainingJobId || t.jobId;  // 优先用训练 JobId
                          apiGet(`/api/voice/ims/status?jobId=${jId}`).then((r: any) => {
                            if (r.success) setStatusModal({ show: true, data: { ...r.data, voiceId: t.voiceId, voiceName: t.voiceName } });
                          });
                        }} className="text-[9px] text-slate-400 hover:text-sky-500">查状态</button>}
                        {t.status === 'Success' && (
                          <button onClick={async (e) => { e.stopPropagation();
                            const r = await apiPost('/api/voice/library/add', { voiceId: t.voiceId });
                            if (r.success) { loadTasks(); showToast('✅ 已添加到音色库', 'success'); }
                            else showToast(r.error || '添加失败', 'error');
                          }} className="text-[9px] text-violet-500 hover:text-violet-700">+音色库</button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(t); }} className="text-[9px] text-slate-400 hover:text-red-500">删除</button>
                      </div>
                    </div>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      </div>
      {tab === 'bailian' && (
        <div className="flex-1 flex items-center justify-center p-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm max-w-md w-full text-center space-y-5">
            <div className="w-16 h-16 rounded-2xl bg-sky-100 flex items-center justify-center mx-auto">
              <span className="text-3xl">⚡</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">百炼声音复刻</h2>
              <p className="text-xs text-slate-400 mt-1">上传 3-30 秒清晰录音，即刻克隆音色，兼容百炼 TTS</p>
            </div>
            <div className="text-left space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">音色名称</label>
                <input value={blName} onChange={e => setBlName(e.target.value)} placeholder="例如：老板本人"
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">录音音频</label>
                {blAudioUrl ? (
                  <div className="flex items-center gap-2 p-3 bg-sky-50 rounded-xl">
                    <span className="text-xs text-sky-600 flex-1 truncate">✅ 已选择</span>
                    <button onClick={() => setBlAudioUrl('')} className="text-[10px] text-red-400">清除</button>
                  </div>
                ) : (
                  <label className="block w-full py-8 border-2 border-dashed border-slate-200 rounded-xl text-center cursor-pointer hover:border-sky-300">
                    <input type="file" accept="audio/*" className="hidden" onChange={async (e) => {
                      const file = e.target.files?.[0]; if (!file) return;
                      const fd = new FormData(); fd.append('file', file);
                      const token = localStorage.getItem('pms_auth_token') || '';
                      try {
                        const r = await fetch('/api/voice/ims/upload', { method: 'POST', body: fd, headers: token ? { Authorization: 'Bearer ' + token } : {} });
                        const d = await r.json();
                        if (d.success) setBlAudioUrl(d.url); else showToast('上传失败', 'error');
                      } catch { showToast('上传失败', 'error'); }
                    }} />
                    <p className="text-xl mb-1">🎙️</p>
                    <p className="text-xs text-slate-500">点击上传录音（wav/mp3）</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">3-30秒，单人普通话</p>
                  </label>
                )}
              </div>
            </div>
            <button onClick={handleBailianClone} disabled={!blName || !blAudioUrl || blLoading}
              className="w-full py-3 bg-gradient-to-r from-sky-500 to-blue-500 text-white rounded-xl text-sm font-bold shadow-md disabled:opacity-50">
              {blLoading ? '⏳ 克隆中...' : '⚡ 开始声音复刻'}
            </button>
            {blVoices.length > 0 && (
              <div className="text-left border-t border-slate-100 pt-4">
                <p className="text-xs font-semibold text-slate-400 mb-2">🎤 已复刻 ({blVoices.length})</p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {blVoices.map((v: any) => (
                    <div key={v.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg text-xs">
                      <span className="font-medium text-slate-700">{v.name}</span>
                      <div className="flex items-center gap-1">
                      <button onClick={async () => {
                        const texts = ['欢迎来到智宿管家，我是您的专属管家，很高兴为您服务。', '这间行政套房，全屋智能控制，窗外就是城市夜景。', '周末特惠来袭，连住两晚直接打八折，还送双人早餐。'];
                        const text = texts[Math.floor(Math.random() * texts.length)];
                        try {
                          const r = await apiPost('/api/voice/tts', { voiceId: v.aliyunVoiceId, text });
                          if (r.success && r.data.audioUrl) { new Audio(r.data.audioUrl).play(); showToast('▶ ' + text.slice(0, 25) + '...', 'success'); }
                          else showToast(r.error || '试听失败', 'error');
                        } catch { showToast('试听失败', 'error'); }
                      }} className="text-[10px] px-2 py-0.5 bg-sky-50 text-sky-600 rounded hover:bg-sky-100">▶ 试听</button>
                        <button onClick={() => setDeleteTarget(v)} className="text-[10px] px-1.5 py-0.5 text-slate-400 hover:text-red-500">×</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {qrModal.show && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={() => setQrModal({ show: false, sentence: '', index: 0 })}>
          <div className="bg-white rounded-2xl p-6 shadow-xl max-w-xs w-full mx-4 text-center" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-bold text-slate-700 mb-1">📱 手机扫码录音</p>
            <p className="text-[11px] text-slate-400 mb-2">第 {qrModal.index + 1} 句</p>
            <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-2 mb-4 line-clamp-2">{qrModal.sentence}</p>
            <QRCodeBox text={`https://pms.kyyp.cn/voice-record.html?voiceId=${voiceId}&index=${qrModal.index}&total=${demos.length}`} />
            <p className="text-[10px] text-slate-400 mt-3">扫码后用手机录音 · 自动同步</p>
            <button onClick={() => setQrModal({ show: false, sentence: '', index: 0 })} className="mt-3 px-6 py-2 bg-slate-100 text-slate-600 rounded-xl text-sm">关闭</button>
          </div>
        </div>
      )}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowResetConfirm(false)}>
          <div className="bg-white rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <p className="text-2xl text-center mb-2">🗑️</p>
            <h3 className="text-sm font-bold text-slate-800 text-center mb-1">确认清空任务？</h3>
            <p className="text-xs text-slate-500 text-center mb-5">当前草稿进度将被清除，无法恢复</p>
            <div className="flex gap-2">
              <button onClick={() => setShowResetConfirm(false)} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200">取消</button>
              <button onClick={confirmNewTask} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600">确认清空</button>
            </div>
          </div>
        </div>
      )}
      {/* 回填任务确认弹窗 */}
      {resumeTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm" onClick={() => setResumeTarget(null)}>
          <div className="bg-white rounded-2xl p-6 shadow-2xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="text-center mb-4">
              <div className="w-14 h-14 rounded-2xl bg-violet-100 flex items-center justify-center mx-auto mb-3">
                <span className="text-2xl">📋</span>
              </div>
              <h3 className="text-base font-bold text-slate-800">继续未完成的任务？</h3>
              <p className="text-xs text-slate-400 mt-1">将加载此任务的全部进度</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 mb-5 space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-slate-400">名称</span><span className="font-medium text-slate-700">{resumeTarget.voiceName || resumeTarget.voiceId}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">VoiceId</span><code className="text-[11px] text-slate-500">{resumeTarget.voiceId}</code></div>
              <div className="flex justify-between"><span className="text-slate-400">进度</span><span className="font-medium text-amber-600">步骤 {resumeTarget.currentStep || 1}/6</span></div>
              <div className="flex justify-between"><span className="text-slate-400">检测</span><span className="font-medium text-slate-700">{Object.values(resumeTarget.detectResults || {}).filter((v:any) => v.passed).length}/{resumeTarget.demos?.length || 20} 通过</span></div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setResumeTarget(null)} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200">取消</button>
              <button onClick={() => { resumeTask(resumeTarget); setResumeTarget(null); }} className="flex-1 py-2.5 bg-violet-500 text-white rounded-xl text-sm font-medium hover:bg-violet-600">📥 加载任务</button>
            </div>
          </div>
        </div>
      )}
      {/* 训练状态弹窗 */}
      {statusModal.show && statusModal.data && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm" onClick={() => setStatusModal({ show: false, data: null })}>
          <div className="bg-white rounded-2xl p-6 shadow-2xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="text-center mb-4">
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3 ${
                statusModal.data.status === 'Success' ? 'bg-green-100' :
                statusModal.data.status === 'Fail' ? 'bg-red-100' : 'bg-violet-100'
              }`}>
                <span className="text-2xl">{statusModal.data.status === 'Success' ? '✅' : statusModal.data.status === 'Fail' ? '❌' : '⏳'}</span>
              </div>
              <h3 className="text-base font-bold text-slate-800">{statusModal.data.voiceName || statusModal.data.voiceId}</h3>
              <p className="text-xs text-slate-400 mt-1">训练状态</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 mb-5 space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-slate-400">状态</span>
                <span className={`font-semibold ${
                  statusModal.data.status === 'Success' ? 'text-green-600' :
                  statusModal.data.status === 'Fail' ? 'text-red-500' : 'text-violet-600'
                }`}>{statusModal.data.status || '未知'}</span>
              </div>
              {statusModal.data.message && <div className="flex justify-between"><span className="text-slate-400">信息</span><span className="text-slate-600">{statusModal.data.message}</span></div>}
              {statusModal.data.voiceId && <div className="flex justify-between"><span className="text-slate-400">VoiceId</span><code className="text-[11px] text-slate-500">{statusModal.data.voiceId}</code></div>}
            </div>
            <button onClick={() => setStatusModal({ show: false, data: null })} className="w-full py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200">关闭</button>
          </div>
        </div>
      )}
      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl p-6 shadow-2xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="text-center mb-4">
              <div className="w-14 h-14 rounded-2xl bg-red-100 flex items-center justify-center mx-auto mb-3">
                <span className="text-2xl">🗑️</span>
              </div>
              <h3 className="text-base font-bold text-slate-800">确认删除？</h3>
              <p className="text-xs text-slate-400 mt-1">{deleteTarget.voiceId ? '将同时删除云端 IMS 音色' : '将从音色库中移除'}</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 mb-5 text-xs space-y-1.5">
              <div className="flex justify-between"><span className="text-slate-400">名称</span><span className="font-medium text-slate-700">{deleteTarget.voiceName || deleteTarget.name}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">ID</span><code className="text-[11px] text-slate-500">{deleteTarget.voiceId || deleteTarget.aliyunVoiceId}</code></div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200">取消</button>
              <button onClick={async () => {
                const t = deleteTarget; setDeleteTarget(null);
                if (t.voiceId) {
                  // IMS 克隆任务
                  await apiPost('/api/voice/ims/delete', { id: t.id });
                  loadTasks();
                  if (voiceId === t.voiceId) confirmNewTask();
                } else {
                  // 百炼音色
                  const token = localStorage.getItem('pms_auth_token') || '';
                  await fetch('/api/voice/' + t.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
                  loadBlVoices();
                }
              }} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600">确认删除</button>
            </div>
          </div>
        </div>
      )}
      {/* 试听弹窗 */}
      {previewVoice && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm" onClick={() => setPreviewVoice(null)}>
          <div className="bg-white rounded-2xl p-6 shadow-2xl max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="text-center mb-4">
              <div className="w-14 h-14 rounded-2xl bg-violet-100 flex items-center justify-center mx-auto mb-3">
                <span className="text-2xl">🎤</span>
              </div>
              <h3 className="text-base font-bold text-slate-800">{previewVoice.name}</h3>
              <p className="text-[11px] text-slate-400 mt-1">{previewVoice.aliyunVoiceId}</p>
            </div>

            {/* 文案输入 */}
            <div className="mb-3">
              <label className="text-xs text-slate-400 block mb-1.5">试听文案</label>
              <textarea value={previewText} onChange={e => setPreviewText(e.target.value)}
                placeholder="输入文案后点击合成试听..."
                className="w-full p-3 border border-slate-200 rounded-xl text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500/20" />
            </div>

            {/* 快捷文案 */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {QUICK_TEXTS.map((t, i) => (
                <button key={i} onClick={() => setPreviewText(t)}
                  className="text-[10px] px-2 py-1 bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 truncate max-w-[140px]">
                  {t.slice(0, 10)}...
                </button>
              ))}
            </div>

            {/* 合成按钮 + 状态 */}
            {previewStatus === 'done' && previewAudioUrl ? (
              <div className="space-y-2">
                <audio controls src={previewAudioUrl} className="w-full h-10" autoPlay />
                <div className="flex gap-2">
                  <button onClick={() => { setPreviewStatus('idle'); setPreviewAudioUrl(''); }}
                    className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-medium">重新合成</button>
                  <button onClick={() => setPreviewVoice(null)}
                    className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-medium">关闭</button>
                </div>
              </div>
            ) : (
              <button onClick={handlePreviewSubmit}
                disabled={!previewText.trim() || previewStatus === 'processing' || previewStatus === 'submitting'}
                className="w-full py-2.5 bg-gradient-to-r from-violet-500 to-purple-500 text-white rounded-xl text-sm font-bold shadow-md disabled:opacity-50 hover:shadow-lg transition-all">
                {previewStatus === 'submitting' ? '⏳ 提交中...' :
                 previewStatus === 'processing' ? '⏳ 合成中...' : '🎙️ 开始合成'}
              </button>
            )}
            {previewMsg && <p className="text-xs text-slate-500 text-center mt-2">{previewMsg}</p>}
          </div>
        </div>
      )}
      <ToastContainer />
      <AssetPicker open={assetPickerOpen} onClose={() => { setAssetPickerOpen(false); setUploadIdx(-1); }} type="audio" multi={false}
        onSelect={assets => {
          if (assets.length > 0 && uploadIdx >= 0) {
            setRecordings(p => ({ ...p, [uploadIdx]: assets[0].url }));
            setDetectResults(p => { const n = { ...p }; delete n[uploadIdx]; return n; });
          }
          setAssetPickerOpen(false); setUploadIdx(-1);
        }} />
      <style jsx global>{`.custom-scroll::-webkit-scrollbar{width:3px}.custom-scroll::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:2px}`}</style>
    </div>
  );
}
