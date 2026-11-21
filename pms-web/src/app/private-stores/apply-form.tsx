'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { CheckCircle, Upload, ChevronRight, ChevronLeft, Loader2 } from 'lucide-react';
import type { ApplicationData } from './types';

const STEPS = ['主体信息', '经营信息', '结算账户', '联系人'];

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-slate-200 p-5 ${className}`}>{children}</div>;
}

function FormLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <label className={`block text-sm font-medium text-slate-700 mb-2 ${className}`}>{children}</label>;
}

function FormInput({ 
  value, onChange, type = 'text', placeholder = '', disabled = false, className = '', maxLength 
}: { 
  value: string | number; 
  onChange: (v: string) => void; 
  type?: string; 
  placeholder?: string; 
  disabled?: boolean;
  className?: string;
  maxLength?: number;
}) {
  return (
    <input 
      type={type} 
      value={value} 
      onChange={e => onChange(e.target.value)} 
      placeholder={placeholder} 
      disabled={disabled} 
      maxLength={maxLength}
      className={`w-full px-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition ${disabled ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''} ${className}`} 
    />
  );
}

function PrimaryBtn({ children, onClick, disabled = false, loading = false, className = '', type = 'button' }: { 
  children: React.ReactNode; 
  onClick: () => void; 
  disabled?: boolean; 
  loading?: boolean; 
  className?: string;
  type?: 'button' | 'reset' | 'submit';
}) {
  return (
    <button 
      type={type}
      onClick={onClick} 
      disabled={disabled || loading} 
      className={`px-5 py-2.5 text-sm text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors flex items-center gap-1.5 ${className}`}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

function OutlineBtn({ children, onClick, className = '', disabled = false }: { 
  children: React.ReactNode; 
  onClick: () => void; 
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={`px-5 py-2.5 text-sm rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 ${className}`}>
      {children}
    </button>
  );
}

export function ApplyForm({ initialData, onSubmit, saving }: {
  initialData?: ApplicationData;
  onSubmit: (data: ApplicationData) => Promise<void>;
  saving: boolean;
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    // Step 1: 主体信息
    licenseNumber: '', merchantName: '', legalPersonName: '',
    licenseImage: '', licenseImageUrl: '',
    // 法人身份证
    idCardName: '', idCardNumber: '',
    idCardFront: '', idCardFrontUrl: '',
    idCardBack: '', idCardBackUrl: '',
    // Step 2: 经营信息
    merchantShortname: '', servicePhone: '', businessAddress: '',
    // Step 3: 结算账户
    accountType: 'personal', bankName: '', accountName: '', accountNumber: '',
    // Step 4: 联系人
    contactName: '', contactPhone: '', contactEmail: '',
  });

  const [uploading, setUploading] = useState('');

  useEffect(() => {
    if (initialData) {
      setForm(f => ({
        ...f,
        licenseNumber: initialData.businessLicense?.number || '',
        merchantName: initialData.businessLicense?.name || '',
        licenseImageUrl: initialData.businessLicense?.imageUrl || '',
        legalPersonName: initialData.legalPerson?.name || '',
        idCardNumber: initialData.legalPerson?.idNumber || '',
        idCardFrontUrl: initialData.legalPerson?.idFrontUrl || '',
        idCardBackUrl: initialData.legalPerson?.idBackUrl || '',
        accountName: initialData.settlementAccount?.accountName || '',
        accountNumber: initialData.settlementAccount?.accountNumber || '',
        bankName: initialData.settlementAccount?.bankName || '',
        contactName: initialData.contact?.name || '',
        contactPhone: initialData.contact?.phone || '',
      }));
    }
  }, [initialData]);

  // Draft auto-save
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem('wechat_apply_draft', JSON.stringify(form)); } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [form]);

  useEffect(() => {
    if (!initialData) {
      try {
        const draft = localStorage.getItem('wechat_apply_draft');
        if (draft) { const d = JSON.parse(draft); setForm(f => ({ ...f, ...d })); toast.info('已恢复草稿'); }
      } catch {}
    }
  }, [initialData]);

  async function uploadImage(field: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/bmp';
    input.onchange = async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast.error('图片不能超过2MB'); return; }
      setUploading(field);
      try {
        const fd = new FormData(); fd.append('file', file);
        const token = localStorage.getItem('pms_auth_token') || '';
        const res = await fetch('/api/upload', { method: 'POST', body: fd, headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const data = await res.json();
        if (data.success) {
          setForm(f => ({ ...f, [field + 'Url']: data.url, [field]: data.url }));
          toast.success('上传成功');
        } else { toast.error(data.error || '上传失败'); }
      } catch { toast.error('上传失败'); }
      setUploading('');
    };
    input.click();
  }

  function canNext(): boolean {
    if (step === 0) return !!form.licenseNumber && !!form.merchantName && !!form.legalPersonName && !!form.idCardName && !!form.idCardNumber;
    if (step === 1) return !!form.merchantShortname && !!form.servicePhone;
    if (step === 2) return !!form.accountName && !!form.accountNumber && !!form.bankName;
    if (step === 3) return !!form.contactName && !!form.contactPhone;
    return true;
  }

  async function handleSubmit() {
    const data = {
      businessLicense: { number: form.licenseNumber, name: form.merchantName, imageUrl: form.licenseImageUrl },
      legalPerson: { name: form.legalPersonName, idNumber: form.idCardNumber, idFrontUrl: form.idCardFrontUrl, idBackUrl: form.idCardBackUrl },
      settlementAccount: { bankName: form.bankName, accountName: form.accountName, accountNumber: form.accountNumber },
      contact: { name: form.contactName, phone: form.contactPhone },
    };
    await onSubmit(data);
    localStorage.removeItem('wechat_apply_draft');
  }

  const imgBtn = (field: string, url: string, label: string) => (
    <div>
      <FormLabel>{label}</FormLabel>
      <div className="flex items-center gap-4">
        <div className="w-40 h-24 border-2 border-dashed border-slate-200 rounded-xl flex items-center justify-center bg-slate-50">
          {url ? (
            <img src={url} alt="" className="w-full h-full object-cover rounded-xl" />
          ) : (
            <Upload className="w-6 h-6 text-slate-400" />
          )}
        </div>
        <PrimaryBtn type="button" onClick={() => uploadImage(field)} disabled={uploading === field} className="px-4 py-2.5">
          {uploading === field ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {url ? '重新上传' : '上传图片'}
        </PrimaryBtn>
        {url && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle className="w-3 h-3" />已上传</span>}
      </div>
    </div>
  );

  return (
    <Card>
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((s, i) => (
          <div 
            key={s} 
            className={`flex items-center gap-2 text-sm px-4 py-2 rounded-xl transition-colors ${
              i === step 
                ? 'bg-emerald-100 text-emerald-700 font-medium' 
                : i < step 
                  ? 'bg-slate-100 text-slate-600' 
                  : 'bg-slate-100 text-slate-400'
            }`}
          >
            {i < step ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <span className="w-5 h-5 rounded-full bg-white flex items-center justify-center text-xs font-medium">
                {i + 1}
              </span>
            )}
            {s}
          </div>
        ))}
      </div>

      <div className="space-y-4 w-[65%] min-w-[500px] mx-auto">
        {/* Step 0: 主体信息 */}
        {step === 0 && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FormLabel>统一社会信用代码 <span className="text-red-500">*</span></FormLabel>
                <FormInput 
                  value={form.licenseNumber} 
                  onChange={v => setForm(f => ({ ...f, licenseNumber: v }))} 
                  placeholder="18位信用代码" 
                />
              </div>
              <div>
                <FormLabel>商户名称 <span className="text-red-500">*</span></FormLabel>
                <FormInput 
                  value={form.merchantName} 
                  onChange={v => setForm(f => ({ ...f, merchantName: v }))} 
                  placeholder="营业执照上的商户名称" 
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FormLabel>法人姓名 <span className="text-red-500">*</span></FormLabel>
                <FormInput 
                  value={form.legalPersonName} 
                  onChange={v => setForm(f => ({ ...f, legalPersonName: v }))} 
                />
              </div>
            </div>
            {imgBtn('licenseImage', form.licenseImageUrl, '营业执照照片')}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FormLabel>身份证姓名 <span className="text-red-500">*</span></FormLabel>
                <FormInput 
                  value={form.idCardName} 
                  onChange={v => setForm(f => ({ ...f, idCardName: v }))} 
                />
              </div>
              <div>
                <FormLabel>身份证号 <span className="text-red-500">*</span></FormLabel>
                <FormInput 
                  value={form.idCardNumber} 
                  onChange={v => setForm(f => ({ ...f, idCardNumber: v }))} 
                  maxLength={18} 
                />
              </div>
            </div>
            {imgBtn('idCardFront', form.idCardFrontUrl, '身份证人像面')}
            {imgBtn('idCardBack', form.idCardBackUrl, '身份证国徽面')}
          </>
        )}

        {/* Step 1: 经营信息 */}
        {step === 1 && (
          <>
            <div>
              <FormLabel>商户简称 <span className="text-red-500">*</span></FormLabel>
              <FormInput 
                value={form.merchantShortname} 
                onChange={v => setForm(f => ({ ...f, merchantShortname: v }))} 
                placeholder="支付时显示的名称，最多20字" 
                maxLength={20} 
              />
            </div>
            <div>
              <FormLabel>客服电话 <span className="text-red-500">*</span></FormLabel>
              <FormInput 
                value={form.servicePhone} 
                onChange={v => setForm(f => ({ ...f, servicePhone: v }))} 
                placeholder="对外展示的联系电话" 
                maxLength={20} 
              />
            </div>
            <div>
              <FormLabel>经营地址</FormLabel>
              <FormInput 
                value={form.businessAddress} 
                onChange={v => setForm(f => ({ ...f, businessAddress: v }))} 
                placeholder="实际经营地址" 
              />
            </div>
          </>
        )}

        {/* Step 2: 结算账户 */}
        {step === 2 && (
          <>
            <div>
              <FormLabel>账户类型</FormLabel>
              <select 
                className="w-full px-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition"
                value={form.accountType} 
                onChange={e => setForm(f => ({ ...f, accountType: e.target.value }))} 
              >
                <option value="personal">个人账户</option>
                <option value="corporate">对公账户</option>
              </select>
            </div>
            <div>
              <FormLabel>开户银行 <span className="text-red-500">*</span></FormLabel>
              <FormInput 
                value={form.bankName} 
                onChange={v => setForm(f => ({ ...f, bankName: v }))} 
                placeholder="例：中国工商银行" 
              />
            </div>
            <div>
              <FormLabel>开户名称 <span className="text-red-500">*</span></FormLabel>
              <FormInput 
                value={form.accountName} 
                onChange={v => setForm(f => ({ ...f, accountName: v }))} 
                placeholder="银行开户名" 
              />
            </div>
            <div>
              <FormLabel>银行账号 <span className="text-red-500">*</span></FormLabel>
              <FormInput 
                value={form.accountNumber} 
                onChange={v => setForm(f => ({ ...f, accountNumber: v }))} 
                placeholder="银行卡号" 
              />
            </div>
          </>
        )}

        {/* Step 3: 联系人 */}
        {step === 3 && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FormLabel>联系人姓名 <span className="text-red-500">*</span></FormLabel>
                <FormInput 
                  value={form.contactName} 
                  onChange={v => setForm(f => ({ ...f, contactName: v }))} 
                />
              </div>
              <div>
                <FormLabel>手机号 <span className="text-red-500">*</span></FormLabel>
                <FormInput 
                  value={form.contactPhone} 
                  onChange={v => setForm(f => ({ ...f, contactPhone: v }))} 
                  maxLength={11} 
                />
              </div>
            </div>
            <div>
              <FormLabel>邮箱</FormLabel>
              <FormInput 
                value={form.contactEmail} 
                onChange={v => setForm(f => ({ ...f, contactEmail: v }))} 
                placeholder="contact@example.com" 
              />
            </div>
          </>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-5 border-t border-slate-100">
          <OutlineBtn onClick={() => setStep(s => s - 1)} disabled={step === 0}>
            <ChevronLeft className="w-4 h-4" />上一步
          </OutlineBtn>
          {step < 3 ? (
            <PrimaryBtn onClick={() => setStep(s => s + 1)} disabled={!canNext()}>
              下一步
              <ChevronRight className="w-4 h-4" />
            </PrimaryBtn>
          ) : (
            <PrimaryBtn onClick={handleSubmit} disabled={saving || !canNext()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}提交审核
            </PrimaryBtn>
          )}
        </div>
      </div>
    </Card>
  );
}
