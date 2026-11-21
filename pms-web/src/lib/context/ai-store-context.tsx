'use client';

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useStore } from '@/lib/context/store-context';

interface AiStoreContextType {
  selectedStoreId: string;
  setSelectedStoreId: (id: string) => void;
  storeNames: Record<string, string>;
  stores: Array<{ id: string; name: string }>;
}

const AiStoreContext = createContext<AiStoreContextType>({
  selectedStoreId: '',
  setSelectedStoreId: () => {},
  storeNames: {},
  stores: [],
});

export function AiStoreProvider({ children }: { children: ReactNode }) {
  const { currentStore, stores: storeOptions, setCurrentStore } = useStore();
  const [selectedStoreId, setSelectedStoreId] = useState('');

  // 从 StoreContext 的 currentStore 同步
  useEffect(() => {
    if (currentStore) {
      setSelectedStoreId(currentStore.id);
    }
  }, [currentStore]);

  const storeNames: Record<string, string> = {};
  const stores = storeOptions.map(s => {
    storeNames[s.id] = s.name;
    return { id: s.id, name: s.name };
  });

  const handleSetStore = (id: string) => {
    const store = storeOptions.find(s => s.id === id);
    if (store) {
      setCurrentStore(store);
      setSelectedStoreId(id);
    }
  };

  return (
    <AiStoreContext.Provider value={{
      selectedStoreId: selectedStoreId || currentStore?.id || '',
      setSelectedStoreId: handleSetStore,
      storeNames,
      stores,
    }}>
      {children}
    </AiStoreContext.Provider>
  );
}

export function useAiStore() {
  return useContext(AiStoreContext);
}
