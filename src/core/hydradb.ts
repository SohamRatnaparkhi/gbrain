/**
 * HydraDB cloud memory: the client for api.hydradb.com and the per-brain
 * connection state. Opt-in only: until `gbrain cloud connect` writes
 * `hydradb.database`, nothing here makes a request.
 *
 * Custody (creds/vault.ts rules): the API key lives in the credential vault as
 * an `api_key` entry, or in HYDRA_DB_API_KEY, which wins; the config plane
 * holds only the vault id. `hydradb.*` is deliberately not a known config
 * prefix, so `gbrain config set` cannot turn the mirror on around the connect
 * disclosure.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { credentialId, openVault } from './creds/vault.ts';

const HYDRADB_PROVIDER = 'hydradb';
export const HYDRADB_API_KEY_ENV = 'HYDRA_DB_API_KEY';
export const HYDRADB_BASE_URL = 'https://api.hydradb.com';
export const HYDRADB_BASE_URL_ENV = 'HYDRA_DB_BASE_URL';
export const DEFAULT_HYDRADB_DATABASE = 'gbrain';

export const HYDRADB_CONFIG = {
  database: 'hydradb.database',
  baseUrl: 'hydradb.base_url',
  credentialId: 'hydradb.credential_id',
  /** 'true': HydraDB is this brain's search backend (search/hydra-primary.ts). */
  primary: 'hydradb.primary',
  /** Mirror keyset `{ updatedAt, slug }` over `updated_asc`, JSON. */
  pagesCursor: 'hydradb.pages_cursor',
  /** Soft-deletes after this instant are not yet removed from the cloud. */
  deletedSince: 'hydradb.deleted_since',
  /** Last successfully reconciled source archive states. */
  sourceStates: 'hydradb.source_states',
  lastPushAt: 'hydradb.last_push_at',
} as const;

export interface HydraConnection {
  database: string;
  apiKey: string;
  baseUrl?: string;
}

/** Credentials may only be sent to an HTTPS HydraDB endpoint. */
export function hydraBaseUrl(raw = HYDRADB_BASE_URL): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.hydradb.com') || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS HydraDB API origin, such as https://api.hydradb.com.');
  }
  return url.origin;
}

export class HydraDBError extends Error {
  constructor(readonly status: number, message: string) {
    super(`HydraDB ${status}: ${message}`);
    this.name = 'HydraDBError';
  }
}

/** One API call: bearer auth, API-Version 2, the `{ data, error }` envelope unwrapped; non-2xx throws. */
export async function hydraRequest<T>(conn: Pick<HydraConnection, 'apiKey' | 'baseUrl'>, method: string, path: string,
  opts: { query?: Record<string, string>; json?: unknown; form?: FormData; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const url = new URL(path, hydraBaseUrl(conn.baseUrl));
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { authorization: `Bearer ${conn.apiKey}`, 'api-version': '2' };
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const envelope = await res.json().catch(() => null) as { data?: T; error?: { message?: string } | string } | null;
  if (!res.ok) {
    const error = envelope?.error;
    throw new HydraDBError(res.status, (typeof error === 'string' ? error : error?.message) || res.statusText);
  }
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) throw new Error('HydraDB returned an invalid response.');
  return envelope.data as T;
}

/** The non-secret half of a `prefix.secret` key: the vault account, safe to print. */
export function apiKeyPrefix(apiKey: string): string {
  return apiKey.split('.')[0]!.slice(0, 16);
}

export async function saveHydraApiKey(apiKey: string): Promise<string> {
  const id = credentialId(HYDRADB_PROVIDER, apiKeyPrefix(apiKey));
  await openVault().put({
    id, provider: HYDRADB_PROVIDER, kind: 'api_key', client_ref: 'byo',
    secret: { token: apiKey },
    meta: { account: apiKeyPrefix(apiKey), connected_at: new Date().toISOString() },
  });
  vaultHasKey = undefined;
  return id;
}

/**
 * Whether this machine holds a HydraDB key at all (env, or a vault entry; the
 * vault is re-read at most every 30 s). Searches and writes check this first,
 * so a machine that never connected pays no database read for the feature.
 */
let vaultHasKey: { at: number; has: boolean } | undefined;
export async function hasHydraKey(): Promise<boolean> {
  if (process.env[HYDRADB_API_KEY_ENV]) return true;
  if (!vaultHasKey || Date.now() - vaultHasKey.at > 30_000) {
    vaultHasKey = { at: Date.now(), has: (await openVault().list({ provider: HYDRADB_PROVIDER }).catch(() => [])).length > 0 };
  }
  return vaultHasKey.has;
}

/** The connected database and its key, or null when this brain never connected (or its key is gone). */
export async function resolveHydraConnection(engine: Pick<BrainEngine, 'getConfig'>): Promise<HydraConnection | null> {
  const database = await engine.getConfig(HYDRADB_CONFIG.database);
  if (!database) return null;
  const storedUrl = await engine.getConfig(HYDRADB_CONFIG.baseUrl);
  const endpoint = storedUrl ? { baseUrl: hydraBaseUrl(storedUrl) } : {};
  const fromEnv = process.env[HYDRADB_API_KEY_ENV];
  if (fromEnv) return { database, apiKey: fromEnv, ...endpoint };
  const id = await engine.getConfig(HYDRADB_CONFIG.credentialId);
  const token = id ? (await openVault().get(id))?.secret.token : undefined;
  return token ? { database, apiKey: token, ...endpoint } : null;
}

/** Stable cloud id of a page: its (source, slug) identity, opaque so any slug is a valid id. */
export function hydraDocId(sourceId: string, slug: string): string {
  return `gbrain-${createHash('sha256').update(`${sourceId}\u0000${slug}`).digest('hex').slice(0, 32)}`;
}

/**
 * The `additional_metadata` the mirror writes on every page: its gbrain
 * identity, under gbrain-prefixed names because HydraDB reserves system names
 * such as `source_id`.
 */
export function hydraDocMetadata(sourceId: string, slug: string, page?: { type: string; effective_date?: Date | null }): Record<string, string> {
  return { gbrain_source: sourceId, gbrain_slug: slug, ...(page ? { gbrain_type: page.type,
    ...(page.effective_date ? { gbrain_date: new Date(page.effective_date).toISOString() } : {}) } : {}) };
}

export interface HydraHit {
  title: string;
  text: string;
  sourceId: string;
  slug: string;
  metadata: Record<string, unknown>;
}

/**
 * Ranked mirrored passages for `query`, best first. `sources` scopes the
 * search server-side by the source each page was mirrored with
 * (hydraDocMetadata); a hit without that metadata (not written by the mirror)
 * is dropped.
 */
export async function queryHydra(conn: HydraConnection, query: string, opts: { sources?: string[]; types?: string[]; maxResults: number; timeoutMs?: number }): Promise<HydraHit[]> {
  const data = await hydraRequest<{ chunks?: Array<{ source_title?: string; chunk_content?: string; additional_metadata?: Record<string, unknown> }> }>(
    conn, 'POST', '/query', {
      json: {
        database: conn.database, query, type: 'knowledge', mode: 'fast', max_results: opts.maxResults,
        ...(opts.sources || opts.types ? { metadata_filters: { additional_metadata: {
          ...(opts.sources ? { gbrain_source: opts.sources } : {}), ...(opts.types ? { gbrain_type: opts.types } : {}),
        } } } : {}),
      },
      timeoutMs: opts.timeoutMs,
    });
  return (data?.chunks ?? []).flatMap((c) => {
    const { gbrain_source: sourceId, gbrain_slug: slug } = c.additional_metadata ?? {};
    if (typeof sourceId !== 'string' || typeof slug !== 'string' || !c.chunk_content) return [];
    return [{ title: c.source_title?.replace(/\.md$/, '') || slug, text: c.chunk_content, sourceId, slug, metadata: c.additional_metadata ?? {} }];
  });
}
