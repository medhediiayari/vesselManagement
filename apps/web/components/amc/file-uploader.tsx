'use client';

import { FILE_ACCEPT, FILE_SCAN_LABELS, type FileContextKey } from '@amc/types';
import { FileText, FileSpreadsheet, Image as ImageIcon, UploadCloud, X } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';
import { ApiError, errorMessage, uploadFile, type StoredFileDto } from '@/lib/api';
import { cn, fmtBytes } from '@/lib/format';
import { Badge } from '@/components/ui/badge';

interface UploadItem {
  key: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  result?: StoredFileDto;
}

export function fileIcon(kind: string | undefined) {
  if (kind === 'IMAGE') return <ImageIcon className="h-4 w-4 text-teal-700" aria-hidden />;
  if (kind === 'EXCEL' || kind === 'CSV') return <FileSpreadsheet className="h-4 w-4 text-ok" aria-hidden />;
  return <FileText className="h-4 w-4 text-action" aria-hidden />;
}

/**
 * Dépôt glisser-déposer avec barre de progression (CDC V1 §6.4).
 * Le serveur contrôle le type réel, la taille, le SHA-256 et l'antivirus : l'attribut
 * `accept` n'est qu'une aide à la sélection.
 */
export function FileUploader({
  context,
  vesselId,
  multiple = false,
  onUploaded,
  label = 'Déposer un fichier',
  hint,
  disabled,
}: {
  context: FileContextKey;
  vesselId?: string | null;
  multiple?: boolean;
  onUploaded: (file: StoredFileDto) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);

  const start = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files).slice(0, multiple ? 20 : 1);
      for (const f of list) {
        const key = `${f.name}-${f.size}-${Date.now()}-${Math.random()}`;
        setItems((prev) => [...(multiple ? prev : []), { key, name: f.name, size: f.size, progress: 0, status: 'uploading' }]);
        uploadFile(f, context, vesselId, (p) =>
          setItems((prev) => prev.map((it) => (it.key === key ? { ...it, progress: p } : it))),
        )
          .then((res) => {
            setItems((prev) => prev.map((it) => (it.key === key ? { ...it, status: 'done', progress: 100, result: res } : it)));
            onUploaded(res);
          })
          .catch((e: unknown) => {
            const msg =
              e instanceof ApiError && e.details && typeof e.details === 'object' && 'allowed' in (e.details as object)
                ? `${e.message}`
                : errorMessage(e);
            setItems((prev) => prev.map((it) => (it.key === key ? { ...it, status: 'error', error: msg } : it)));
          });
      }
    },
    [context, vesselId, multiple, onUploaded],
  );

  return (
    <div>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled && e.dataTransfer.files.length) start(e.dataTransfer.files);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragOver ? 'border-action bg-action-50' : 'border-line-strong bg-canvas/60 hover:border-action/60',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <UploadCloud className="mb-2 h-6 w-6 text-action" aria-hidden />
        <span className="text-sm font-medium text-navy">{label}</span>
        <span className="mt-0.5 text-xs text-ink-muted">
          Glissez-déposez ou cliquez — {hint ?? FILE_ACCEPT[context].replaceAll(',', ' ')}
        </span>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={FILE_ACCEPT[context]}
          multiple={multiple}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.files?.length) start(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-live="polite">
          {items.map((it) => (
            <li key={it.key} className="rounded-md border border-line bg-white px-3 py-2">
              <div className="flex items-center gap-2">
                {fileIcon(it.result?.kind)}
                <span className="min-w-0 flex-1 truncate text-sm">{it.name}</span>
                <span className="text-xs tabular text-ink-muted">{fmtBytes(it.size)}</span>
                {it.status !== 'uploading' && (
                  <button
                    type="button"
                    className="rounded p-0.5 text-ink-muted hover:bg-navy-50"
                    aria-label={`Retirer ${it.name} de la liste`}
                    onClick={() => setItems((prev) => prev.filter((x) => x.key !== it.key))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {it.status === 'uploading' && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-navy-50" role="progressbar" aria-valuenow={it.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Dépôt de ${it.name}`}>
                  <div className="h-full bg-action transition-all" style={{ width: `${it.progress}%` }} />
                </div>
              )}
              {it.status === 'done' && it.result && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <Badge tone={it.result.scanStatus === 'CLEAN' ? 'ok' : it.result.scanStatus === 'PENDING' ? 'info' : 'neutral'}>
                    {FILE_SCAN_LABELS[it.result.scanStatus]}
                  </Badge>
                  {it.result.pageCount ? <span>{it.result.pageCount} page(s)</span> : null}
                  {it.result.width ? <span>{it.result.width}×{it.result.height}px</span> : null}
                  <span className="truncate" title={`SHA-256 ${it.result.sha256}`}>
                    SHA-256 {it.result.sha256.slice(0, 12)}…
                  </span>
                </div>
              )}
              {it.status === 'error' && (
                <p className="mt-1 text-xs font-medium text-danger" role="alert">
                  {it.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
