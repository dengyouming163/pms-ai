'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { TOKEN_KEY } from '@/lib/constants';
import { apiGet, apiPost } from '@/lib/api-client';

export interface AuthUser {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  avatar: string | null;
  department: string | null;
  position: string | null;
  roleName: string;
  roleId: string;
  scope: string;
  stores: string[];
  permissions: string[];
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (phone: string, password?: string, code?: string) => Promise<void>;
  /** 发送短信验证码 */
  sendSms: (phone: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // 初始化：从 localStorage 恢复 token
  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY);
    if (savedToken) {
      setToken(savedToken);
      fetchUser();
    } else {
      setLoading(false);
    }
  }, []);

  const fetchUser = async (t?: string) => {
    try {
      // 如果传入新 token，先确保它已存入 localStorage，apiGet 会自动读取
      if (t) {
        localStorage.setItem(TOKEN_KEY, t);
      }
      const data = await apiGet<{ success: boolean; data: AuthUser & { role?: { permissions?: string[] } | null } }>('/api/auth/me');
      if (data.success) {
        let permissions = data.data.role?.permissions || (data.data as any).permissions || [];
        // 兼容旧格式：bare module name → module:view（跳过 'all'/'*'）
        if (permissions.length > 0 && !permissions[0].includes(':') && permissions[0] !== 'all' && permissions[0] !== '*') {
          permissions = permissions.map((p: string) => `${p}:view`);
        }
        setUser({ ...data.data, permissions });
      } else {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      }
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const login = useCallback(async (phone: string, password?: string, code?: string) => {
    const data = await apiPost<{ success: boolean; data: { token: string } }>(
      '/api/auth/login',
      code ? { phone, code } : { phone, password },
    );

    if (!data.success) {
      throw new Error((data as any).error || '登录失败');
    }

    const newToken = data.data.token;
    setToken(newToken);

    // 通过 /me 接口获取完整用户信息
    await fetchUser(newToken);
    router.push('/dashboard');
  }, [router]);

  const sendSms = useCallback(async (phone: string) => {
    const data = await apiPost<{ success: boolean; message?: string }>(
      '/api/auth/send-sms',
      { phone },
    );
    if (!data.success) {
      throw new Error((data as any).error || '发送失败');
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, sendSms, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

export function useHasPermission(required: string): boolean {
  const { user } = useAuth();
  if (!user) return false;
  if (user.permissions.length === 0) return true;
  if (user.permissions.includes('all') || user.permissions.includes('*')) return true;
  return user.permissions.includes(required);
}
