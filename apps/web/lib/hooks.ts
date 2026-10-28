'use client';

import { useInfiniteQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage, type Page } from './api';

/** Liste paginée par curseur (pagination serveur). `X` : champs additionnels renvoyés avec chaque page. */
export function useCursorList<T, X extends object = object>(key: QueryKey, path: string, params: Record<string, unknown> = {}, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: [...key, params],
    queryFn: ({ pageParam }) =>
      api.get<Page<T> & X>(path, { query: { ...(params as Record<string, string>), limit: 50, cursor: pageParam ?? undefined } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
  return {
    rows: q.data?.pages.flatMap((p) => p.items),
    total: q.data?.pages[0]?.total,
    firstPage: q.data?.pages[0],
    loading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
    hasMore: !!q.hasNextPage,
    loadMore: () => q.fetchNextPage(),
    loadingMore: q.isFetchingNextPage,
  };
}

/** Mutation avec toasts de succès / erreur et invalidation de requêtes. */
export function useAction<TVars, TRes = unknown>(
  fn: (vars: TVars) => Promise<TRes>,
  opts: { success?: string | ((res: TRes) => string); invalidate?: QueryKey[]; onSuccess?: (res: TRes, vars: TVars) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (res, vars) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(res) : opts.success);
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      opts.onSuccess?.(res, vars);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
