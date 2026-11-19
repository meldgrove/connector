import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import type {
  ContextRequest,
  ContextResponse,
  Item,
  RecentResponse,
  SearchResponse,
} from "@connector/shared/api/search";
import type { SourceSummary } from "@connector/shared/api/sources";
import { api } from "@/lib/api";

/** The sources the signed-in person may use. */
export const sourcesQuery = {
  queryKey: ["sources"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) =>
    api.get<{ items: SourceSummary[] }>("/sources", undefined, signal),
  staleTime: 60_000,
};

export function useSources() {
  return useQuery(sourcesQuery);
}

export function useSearch(q: string, sources: string[]) {
  return useQuery({
    queryKey: ["search", q, sources],
    queryFn: ({ signal }) =>
      api.get<SearchResponse>("/search", { q, sources: sources.join(",") || undefined, limit: 30 }, signal),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useItem(id: string | null) {
  return useQuery({
    queryKey: ["item", id],
    queryFn: ({ signal }) => api.get<Item>(`/items/${encodeURIComponent(id!)}`, undefined, signal),
    enabled: id !== null,
  });
}

export function useRecent(days: number) {
  return useQuery({
    queryKey: ["recent", days],
    queryFn: ({ signal }) => api.get<RecentResponse>("/recent", { days, limit: 15 }, signal),
    staleTime: 60_000,
  });
}

export function useContextBrief() {
  return useMutation({
    mutationFn: (input: Pick<ContextRequest, "topic">) => api.post<ContextResponse>("/context", input),
  });
}
