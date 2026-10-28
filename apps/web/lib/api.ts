/**
 * Client API (same-origin via le proxy Next.js /api/v1 -> NestJS).
 * Session : cookie HttpOnly ; mutations : en-tête x-csrf-token (double-submit).
 * L'UI ne fait qu'indiquer les droits : le serveur reste l'unique autorité.
 */
export const API_BASE = '/api/v1';

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
  }

  /** Erreurs de validation champ par champ (format renvoyé par l'API : [{path, message}]) */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path?: string; message?: string }[]) {
        if (d?.path) out[d.path] = d.message ?? 'Valeur invalide';
      }
    }
    return out;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export function toQuery(params?: Query): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface RequestOptions {
  query?: Query;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET') {
    const csrf = readCookie('amc_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(`${API_BASE}${path}${toQuery(opts.query)}`, {
    method,
    headers,
    body: payload,
    credentials: 'same-origin',
    signal: opts.signal,
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const b = (data ?? {}) as Partial<ApiErrorBody>;
    const err = new ApiError(res.status, b.code ?? 'ERROR', b.message ?? `Erreur ${res.status}`, b.details, b.requestId);
    if (typeof window !== 'undefined') {
      if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new CustomEvent('amc:unauthenticated'));
      if (b.code === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new CustomEvent('amc:password-change-required'));
    }
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

// ---------------------------------------------------------------------------
// Fichiers (MinIO via l'API)
// ---------------------------------------------------------------------------

export interface StoredFileDto {
  id: string;
  originalName: string;
  mimeType: string;
  kind: 'PDF' | 'EXCEL' | 'IMAGE' | 'ZIP' | 'CSV' | 'WORD' | 'OTHER';
  extension: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED' | 'ERROR';
  context: string;
  vesselId: string | null;
  width: number | null;
  height: number | null;
  pageCount: number | null;
  hasThumbnail: boolean;
  attached: boolean;
  createdAt: string;
}

export interface FileLink {
  url: string;
  expiresAt: string;
  fileName: string;
  mimeType: string;
  disposition: 'inline' | 'attachment';
}

/** Dépôt avec progression (XHR : fetch n'expose pas la progression d'upload). */
export function uploadFile(
  file: File,
  context: string,
  vesselId?: string | null,
  onProgress?: (percent: number) => void,
): Promise<StoredFileDto> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('context', context);
    if (vesselId) form.append('vesselId', vesselId);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/files`);
    xhr.withCredentials = true;
    const csrf = readCookie('amc_csrf');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: unknown;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as StoredFileDto);
      else {
        const b = data as Partial<ApiErrorBody>;
        reject(new ApiError(xhr.status, b.code ?? 'ERROR', b.message ?? `Échec du dépôt (${xhr.status})`, b.details, b.requestId));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Connexion interrompue pendant le dépôt'));
    xhr.send(form);
  });
}

/** Demande un lien éphémère (60 s) après contrôle des droits côté serveur. */
export function fileLink(fileId: string, mode: 'preview' | 'download' | 'thumbnail'): Promise<FileLink> {
  return api.get<FileLink>(`/files/${fileId}/${mode}`);
}

/** Ouvre un téléchargement (le lien signé expire rapidement : on le demande au clic). */
export async function downloadFile(fileIdOrPath: string, isPath = false) {
  const link = isPath ? await api.get<FileLink>(fileIdOrPath) : await fileLink(fileIdOrPath, 'download');
  const a = document.createElement('a');
  a.href = link.url;
  a.rel = 'noopener';
  a.download = link.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Erreur inattendue';
}
