'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { validateForm, commonRules, ValidationErrors } from '@/lib/utils/validation';
import { PLATFORM_REGISTER_URL } from '@/lib/constants';

export default function LoginPage() {
  const { login, sendSms } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [loginMode, setLoginMode] = useState<'password' | 'sms'>('password');
  const [codeSending, setCodeSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [loading, setLoading] = useState(false);
  const [greeting, setGreeting] = useState({ text: '你好', icon: '🌿' });

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) setGreeting({ text: '早上好', icon: '☀' });
    else if (hour >= 12 && hour < 18) setGreeting({ text: '下午好', icon: '🌤' });
    else setGreeting({ text: '晚上好', icon: '🌙' });
  }, []);

  // 发送验证码
  const handleSendCode = async () => {
    if (countdown > 0) return;
    if (!phone || phone.length < 11) {
      setError('请输入正确的手机号');
      return;
    }
    setError('');
    setCodeSending(true);
    try {
      await sendSms(phone);
      setCountdown(60);
      const timer = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) { clearInterval(timer); return 0; }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败');
    } finally {
      setCodeSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const fields: Record<string, any> = { phone };
    const rules: Record<string, any> = {
      phone: [commonRules.required('手机号'), commonRules.phone()],
    };

    if (loginMode === 'sms') {
      fields.code = code;
      rules.code = [commonRules.required('验证码'), commonRules.minLength(4, '验证码')];
    } else {
      fields.password = password;
      rules.password = [commonRules.required('密码'), commonRules.minLength(6, '密码')];
    }

    const validationErrors = validateForm(fields, rules);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setLoading(true);

    try {
      if (loginMode === 'sms') {
        await login(phone, undefined, code);
      } else {
        await login(phone, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const features = [
    { icon: '🏠', title: '智能房态', desc: '实时房态一目了然，入住退房一键操作' },
    { icon: '💰', title: 'AI智能定价', desc: '基于市场趋势自动推荐最优房价' },
    { icon: '📱', title: '全渠道直连', desc: '携程、美团、飞猪多平台同步管理' },
    { icon: '📊', title: '数据洞察', desc: '收入分析、客源画像，数据驱动决策' },
    { icon: '👥', title: '客户管理', desc: '标签分组、智能关怀，提升复购率' },
    { icon: '🤖', title: 'AI助手', desc: '24小时智能助手，运营问题随时问' },
  ];

  return (
    <div className="min-h-screen relative flex overflow-hidden bg-[#eef6e2]">
      {/* ====== 全屏统一背景 ====== */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#f4f9e8] via-[#e8f3d6] to-[#d8ecbe]" />

      {/* 柔光斑 */}
      <div className="absolute top-[-15%] left-[10%] w-[700px] h-[700px] rounded-full bg-[#fffde7]/70 blur-[150px]" />
      <div className="absolute top-[20%] right-[-5%] w-[500px] h-[500px] rounded-full bg-[#f1f8e9]/60 blur-[130px]" />
      <div className="absolute bottom-[-10%] left-[30%] w-[600px] h-[600px] rounded-full bg-[#dcedc8]/50 blur-[140px]" />

      {/* 极简叶子点缀 */}
      <svg className="absolute top-[8%] left-[5%] w-32 h-32 opacity-[0.10]" viewBox="0 0 120 120" fill="none">
        <ellipse cx="60" cy="50" rx="40" ry="20" fill="#4caf50" transform="rotate(-30 60 50)" />
        <line x1="60" y1="30" x2="60" y2="90" stroke="#4caf50" strokeWidth="1.5" />
      </svg>
      <svg className="absolute bottom-[12%] left-[12%] w-24 h-24 opacity-[0.08]" viewBox="0 0 100 100" fill="none">
        <ellipse cx="50" cy="40" rx="30" ry="15" fill="#66bb6a" transform="rotate(15 50 40)" />
        <line x1="50" y1="25" x2="50" y2="75" stroke="#66bb6a" strokeWidth="1.2" />
      </svg>
      <svg className="absolute top-[15%] right-[8%] w-20 h-20 opacity-[0.06]" viewBox="0 0 100 100" fill="none">
        <ellipse cx="50" cy="45" rx="28" ry="14" fill="#81c784" transform="rotate(-20 50 45)" />
      </svg>

      {/* ====== 左侧品牌+功能介绍 ====== */}
      <div className="hidden lg:flex lg:w-[55%] relative z-10 flex-col justify-center pl-[8%] pr-[4%]">
        {/* Logo */}
        <div className="flex items-center gap-4 mb-10">
          <div className="w-14 h-14 rounded-2xl bg-white/70 backdrop-blur-sm shadow-sm flex items-center justify-center border border-white/50">
            <svg className="w-7 h-7 text-green-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
            </svg>
          </div>
          <span className="text-green-800/60 text-2xl font-bold tracking-wide">民宿·AIPMS</span>
        </div>

        {/* 主标题 */}
        <h1 className="text-green-900/70 text-[2.8rem] font-bold leading-tight mb-4">
          AI赋能民宿管理
        </h1>
        <p className="text-green-800/35 text-lg leading-relaxed mb-12">
          让每一家民宿，都拥有智能管家
        </p>

        {/* 功能亮点 */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-6 max-w-lg">
          {features.map((f) => (
            <div key={f.title} className="flex gap-3">
              <span className="text-2xl mt-0.5 shrink-0">{f.icon}</span>
              <div>
                <div className="text-green-900/55 font-semibold text-[15px] mb-0.5">{f.title}</div>
                <div className="text-green-800/25 text-[13px] leading-snug">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ====== 右侧登录卡片 ====== */}
      <div className="w-full lg:w-[45%] relative z-10 flex items-center justify-center px-8 py-12 lg:py-0">
        <div className="w-full max-w-[480px]">
          <div className="bg-white/65 backdrop-blur-2xl rounded-2xl border border-white/70 shadow-2xl shadow-green-900/[0.06] p-10 sm:p-12">

            {/* 移动端 Logo */}
            <div className="lg:hidden mb-8 flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-xl bg-green-600/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-green-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                </svg>
              </div>
              <span className="text-green-800 text-lg font-bold">民宿·AIPMS</span>
            </div>

            {/* 问候语 */}
            <div className="mb-10">
              <h2 className="text-[2rem] font-bold text-green-900/80 tracking-tight">
                {greeting.text} {greeting.icon}
              </h2>
              <p className="text-green-800/30 mt-2 text-[15px]">
                登录民宿管理后台，轻松运营每一天
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* 登录方式切换 */}
              <div className="flex bg-green-50/50 rounded-lg p-1 gap-1">
                <button
                  type="button"
                  onClick={() => { setLoginMode('password'); setError(''); setErrors({}); }}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                    loginMode === 'password'
                      ? 'bg-white text-green-800 shadow-sm'
                      : 'text-green-800/40 hover:text-green-800/60'
                  }`}
                >密码登录</button>
                <button
                  type="button"
                  onClick={() => { setLoginMode('sms'); setError(''); setErrors({}); }}
                  className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
                    loginMode === 'sms'
                      ? 'bg-white text-green-800 shadow-sm'
                      : 'text-green-800/40 hover:text-green-800/60'
                  }`}
                >验证码登录</button>
              </div>

              {/* 错误提示 */}
              {error && (
                <div className="p-4 text-sm text-red-600 bg-red-50/80 border border-red-100 rounded-xl flex items-center gap-2">
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {error}
                </div>
              )}

              {/* 手机号 */}
              <div className="space-y-2.5">
                <label className="text-sm font-semibold text-green-900/50 tracking-wide">手机号</label>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500/50">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.888 4.444l.444-.222a2.667 2.667 0 012.372.06l.444.222a2.667 2.667 0 002.372.06l.444-.222a2.667 2.667 0 013.56 3.56l-.222.444a2.667 2.667 0 00-.06 2.372l.222.444a2.667 2.667 0 01-3.56 3.56l-.444-.222a2.667 2.667 0 00-2.372-.06l-.444.222a2.667 2.667 0 01-3.56-3.56l.222-.444a2.667 2.667 0 00.06-2.372l-.222-.444a2.667 2.667 0 013.56-3.56z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <Input
                    type="tel"
                    placeholder="请输入手机号"
                    value={phone}
                    onChange={(e) => { setPhone(e.target.value); setErrors(prev => ({ ...prev, phone: '' })); }}
                    className={`h-13 pl-12 bg-white/60 border-green-100/80 text-green-900 placeholder:text-green-900/15 rounded-xl focus:border-green-400 focus:ring-green-400/15 text-base ${errors.phone ? 'border-red-300/60' : ''}`}
                    required
                  />
                </div>
                {errors.phone && <p className="text-xs text-red-500 pl-1">{errors.phone}</p>}
              </div>

              {/* 验证码输入（短信登录模式） */}
              {loginMode === 'sms' && (
                <div className="space-y-2.5">
                  <label className="text-sm font-semibold text-green-900/50 tracking-wide">验证码</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500/50">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-3-3v6m8-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <Input
                        type="text"
                        placeholder="请输入验证码"
                        value={code}
                        onChange={(e) => { setCode(e.target.value); setErrors(prev => ({ ...prev, code: '' })); }}
                        className={`h-13 pl-12 bg-white/60 border-green-100/80 text-green-900 placeholder:text-green-900/15 rounded-xl focus:border-green-400 focus:ring-green-400/15 text-base ${errors.code ? 'border-red-300/60' : ''}`}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleSendCode}
                      disabled={codeSending || countdown > 0}
                      className="h-13 px-4 border-green-200 text-green-700 hover:bg-green-50 whitespace-nowrap rounded-xl"
                    >
                      {countdown > 0 ? `${countdown}s` : codeSending ? '发送中' : '获取验证码'}
                    </Button>
                  </div>
                  {errors.code && <p className="text-xs text-red-500 pl-1">{errors.code}</p>}
                </div>
              )}

              {/* 密码 */}
              <div className="space-y-2.5" style={{ display: loginMode === 'password' ? undefined : 'none' }}>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-green-900/50 tracking-wide">密码</label>
                  <span className="text-xs text-green-600/40 hover:text-green-600/60 cursor-pointer transition-colors">忘记密码?</span>
                </div>
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-green-500/50">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  </div>
                  <Input
                    type="password"
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setErrors(prev => ({ ...prev, password: '' })); }}
                    className={`h-13 pl-12 bg-white/60 border-green-100/80 text-green-900 placeholder:text-green-900/15 rounded-xl focus:border-green-400 focus:ring-green-400/15 text-base ${errors.password ? 'border-red-300/60' : ''}`}
                    required
                  />
                </div>
                {errors.password && <p className="text-xs text-red-500 pl-1">{errors.password}</p>}
              </div>

              {/* 登录按钮 */}
              <Button
                type="submit"
                className="w-full h-13 bg-gradient-to-r from-[#43a047] to-[#2e7d32] hover:from-[#66bb6a] hover:to-[#43a047] text-white shadow-lg shadow-green-700/20 rounded-xl text-base font-bold tracking-widest transition-all duration-300 hover:shadow-xl hover:shadow-green-600/25 hover:-translate-y-0.5 active:translate-y-0 mt-3"
                disabled={loading}
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    登录中...
                  </span>
                ) : '登 录'}
              </Button>
            </form>

            {/* 商户入驻入口 */}
            <p className="text-center text-[13px] text-green-900/30 mt-8">
              还没有账号？{' '}
              <a
                href={PLATFORM_REGISTER_URL}
                className="text-green-600/60 hover:text-green-600 underline underline-offset-2 transition-colors"
              >
                立即开通
              </a>
            </p>

            <p className="text-center text-[11px] text-green-900/10 mt-6 tracking-wider">
              © 2025 民宿·AIPMS · AI赋能民宿管理
            </p>
          </div>
        </div>
      </div>

      {/* 移动端顶部装饰条 */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-lime-300/80 via-green-400/80 to-emerald-300/80 z-50" />
    </div>
  );
}
