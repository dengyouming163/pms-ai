'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function StoresPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/staff'); }, []);
  return <div className="p-8 text-center text-slate-400">正在跳转...</div>;
}
