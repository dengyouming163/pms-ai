'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseDataOptions<T> {
  initialData: T;
  fetchFn: () => Promise<T>;
  deps?: unknown[];
}

interface UseDataResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useData<T>({ initialData, fetchFn, deps = [] }: UseDataOptions<T>): UseDataResult<T> {
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const currentId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      // 仅当没有更新的请求时才更新状态，防止竞态条件
      if (currentId === fetchIdRef.current) {
        setData(result);
        setLoading(false);
      }
    } catch (err) {
      if (currentId === fetchIdRef.current) {
        setError(err instanceof Error ? err.message : '加载失败');
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
