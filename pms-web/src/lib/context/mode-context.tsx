'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { AI_MODE_URL } from '@/lib/constants';

type SystemMode = 'saas' | 'ai_agent' | 'hybrid';

interface ModuleModes {
  pricing: boolean;
  customer: boolean;
  housekeeping: boolean;
  ota_bridge: boolean;
  report: boolean;
  chat: boolean;
}

interface ModeContextValue {
  systemMode: SystemMode;
  moduleModes: ModuleModes;
  isAIMode: boolean;
  isModuleAI: (module: keyof ModuleModes) => boolean;
  isAnyModuleAI: boolean;
  switchMode: (mode: SystemMode) => Promise<void>;
  toggleModule: (module: keyof ModuleModes) => Promise<void>;
  loading: boolean;
}

const defaultModuleModes: ModuleModes = {
  pricing: false, customer: false, housekeeping: false,
  ota_bridge: false, report: false, chat: false,
};

const ModeContext = createContext<ModeContextValue>({
  systemMode: 'saas',
  moduleModes: defaultModuleModes,
  isAIMode: false,
  isModuleAI: () => false,
  isAnyModuleAI: false,
  switchMode: async () => {},
  toggleModule: async () => {},
  loading: true,
});

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [systemMode, setSystemMode] = useState<SystemMode>('saas');
  const [moduleModes, setModuleModes] = useState<ModuleModes>(defaultModuleModes);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<{ systemMode: SystemMode; modules: ModuleModes }>(AI_MODE_URL)
      .then(data => { setSystemMode(data.systemMode); setModuleModes(data.modules); })
      .catch(() => setSystemMode('saas'))
      .finally(() => setLoading(false));
  }, []);

  const isAIMode = systemMode === 'ai_agent' || systemMode === 'hybrid';
  const isModuleAI = useCallback((module: keyof ModuleModes) => isAIMode && moduleModes[module], [isAIMode, moduleModes]);
  const isAnyModuleAI = Object.values(moduleModes).some(Boolean);

  const switchMode = useCallback(async (mode: SystemMode) => {
    await apiPost(`${AI_MODE_URL}/switch`, { mode });
    setSystemMode(mode);
  }, []);

  const toggleModule = useCallback(async (module: keyof ModuleModes) => {
    const newValue = !moduleModes[module];
    await apiPost(`${AI_MODE_URL}/module`, { module, enabled: newValue });
    setModuleModes(prev => ({ ...prev, [module]: newValue }));
  }, [moduleModes]);

  return (
    <ModeContext.Provider value={{ systemMode, moduleModes, isAIMode, isModuleAI, isAnyModuleAI, switchMode, toggleModule, loading }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode() { return useContext(ModeContext); }
