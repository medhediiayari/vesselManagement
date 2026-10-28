'use client';

import { useQuery } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { api, type FileLink } from '@/lib/api';
import { cn } from '@/lib/format';

/** Image servie par URL signée éphémère (miniature MinIO), renouvelée avant expiration. */
export function SecureImage({
  fileId,
  alt,
  className,
  variant = 'thumbnail',
}: {
  fileId: string;
  alt: string;
  className?: string;
  variant?: 'thumbnail' | 'preview';
}) {
  const q = useQuery({
    queryKey: ['file-link', fileId, variant],
    queryFn: () => api.get<FileLink>(`/files/${fileId}/${variant}`),
    staleTime: 45_000,
    refetchInterval: 50_000,
  });
  if (q.error) {
    return (
      <div className={cn('flex items-center justify-center bg-navy-50 text-ink-soft', className)} role="img" aria-label={`${alt} (indisponible)`}>
        <ImageOff className="h-6 w-6" aria-hidden />
      </div>
    );
  }
  if (!q.data) return <div className={cn('animate-pulse bg-navy-50', className)} aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={q.data.url} alt={alt} className={cn('object-cover', className)} />;
}
