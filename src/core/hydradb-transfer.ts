/** Verify per-document acceptance, indexing, and deletion before advancing a mirror cursor. */
import { hydraRequest, type HydraConnection } from './hydradb.ts';

interface Item { id: string; status?: string; error?: string | null }
interface IngestReceipt { failed_count?: number; results?: Item[] }
const INDEX_TIMEOUT_MS = 600_000;

export async function ingestHydra(conn: HydraConnection, form: FormData, ids: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const receipt = await hydraRequest<IngestReceipt>(conn, 'POST', '/context/ingest', { form, signal, timeoutMs: 120_000 });
  if (!receipt?.results || receipt.failed_count || ids.some(id => !receipt.results!.some(r => r.id === id && !r.error && ['queued', 'processing', 'completed'].includes(r.status ?? '')))) {
    throw new Error('HydraDB did not accept every page; the mirror will retry this batch.');
  }
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  while (true) {
    signal?.throwIfAborted();
    const data = await hydraRequest<{ statuses?: Array<{ id: string; indexing_status: string }> }>(conn, 'GET', '/context/status',
      { signal, query: { database: conn.database, ids: ids.join(',') }, timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())) });
    if (data?.statuses?.some(s => s.indexing_status === 'failed')) throw new Error('HydraDB indexing failed; the mirror will retry this batch.');
    if (ids.every(id => data?.statuses?.some(s => s.id === id && s.indexing_status === 'completed'))) return;
    if (Date.now() >= deadline) throw new Error('HydraDB indexing is still pending; the mirror will retry this batch.');
    await new Promise(r => setTimeout(r, 1_000));
  }
}

export async function deleteHydra(conn: HydraConnection, ids: string[], signal?: AbortSignal): Promise<void> {
  const data = await hydraRequest<{ results?: Array<{ id: string; deleted: boolean; error?: string }> }>(conn, 'DELETE', '/context',
    { signal, json: { database: conn.database, type: 'knowledge', ids } });
  // An absent document is already removed. Every other per-id failure must remain retryable.
  if (!data?.results || ids.some(id => !data.results!.some(r => r.id === id && (r.deleted || /not found|does not exist/i.test(r.error ?? ''))))) {
    throw new Error('HydraDB did not remove every page; the mirror will retry these deletions.');
  }
}
