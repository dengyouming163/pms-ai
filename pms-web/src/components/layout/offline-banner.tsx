'use client';

import { useEffect, useState } from 'react';

/** 在线状态枚举 */
type OnlineStatus = 'online' | 'offline' | 'recovered';

/**
 * 全局离线/在线状态提示横幅
 * - 监听浏览器 online/offline 事件
 * - 离线时显示黄色警告横幅
 * - 恢复在线时显示绿色提示横幅，3 秒后自动消失
 */
export function OfflineBanner() {
  const [status, setStatus] = useState<OnlineStatus>(
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'online',
  );

  useEffect(() => {
    const handleOffline = () => setStatus('offline');
    const handleOnline = () => setStatus('recovered');

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // 恢复在线后 3 秒自动隐藏提示
  useEffect(() => {
    if (status !== 'recovered') return;
    const timer = setTimeout(() => setStatus('online'), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  if (status === 'online') return null;

  const isOffline = status === 'offline';

  return (
    <div
      className={
        'fixed top-0 left-0 right-0 z-[9999] text-center text-sm font-medium py-2 px-4 transition-colors ' +
        (isOffline
          ? 'bg-amber-500 text-white'
          : 'bg-emerald-500 text-white')
      }
      role="alert"
    >
      {isOffline ? '网络连接已断开，请检查网络设置' : '网络已恢复'}
    </div>
  );
}
