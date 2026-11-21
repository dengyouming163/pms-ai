'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { apiGet } from '@/lib/api-client';

export interface StoreOption {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  fullName: string; // e.g. "久栖·精品-杭州西湖店"
}

interface StoreContextType {
  currentStore: StoreOption | null;
  stores: StoreOption[];
  setCurrentStore: (store: StoreOption) => void;
  loading: boolean;
  error: string | null;
}

const StoreContext = createContext<StoreContextType>({
  currentStore: null,
  stores: [],
  setCurrentStore: () => {},
  loading: true,
  error: null,
});

export function useStore() {
  return useContext(StoreContext);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [currentStore, setCurrentStore] = useState<StoreOption | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ id: string; brandId: string; brandName: string; name: string }[]>('/api/stores')
      .then((data) => {
        const options: StoreOption[] = data.map(s => ({
          id: s.id,
          brandId: s.brandId,
          brandName: s.brandName,
          name: s.name,
          fullName: `${s.brandName}-${s.name}`,
        }));
        setStores(options);
        // 从 localStorage 恢复上次选中的门店，首次登录默认选第一个
        const saved = typeof window !== 'undefined' ? localStorage.getItem('currentStoreId') : null;
        const found = saved ? options.find(s => s.id === saved) : null;
        const selected = found || options[0] || null;
        if (selected && typeof window !== 'undefined') {
          localStorage.setItem('currentStoreId', selected.id);
        }
        setCurrentStore(selected);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[StoreProvider] 门店列表加载失败:', err);
        setError('门店列表加载失败，请刷新重试');
        setLoading(false);
      });
  }, []);

  const handleSetCurrentStore = useCallback((store: StoreOption) => {
    setCurrentStore(store);
    if (typeof window !== 'undefined') {
      localStorage.setItem('currentStoreId', store.id);
    }
  }, []);

  return (
    <StoreContext.Provider value={{ currentStore, stores, setCurrentStore: handleSetCurrentStore, loading, error }}>
      {children}
    </StoreContext.Provider>
  );
}
