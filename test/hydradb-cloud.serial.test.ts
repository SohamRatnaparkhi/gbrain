/**
 * HydraDB as storage and search backend (src/core/hydradb*.ts,
 * search/hydra-primary.ts, commands/cloud.ts) against an in-process fake of
 * api.hydradb.com: the mirror sends the embedding projection (no private pages,
 * private fact rows or secrets), resumes from its cursor, removes soft-deleted
 * pages, keeps the cursor on failure, and a committed write is pushed; search
 * is byte-identical and makes no request when off, primary is off, or HydraDB
 * fails, and otherwise follows HydraDB's order as local page rows under the
 * caller's read policy (unheld pages as cloud rows, deleted and private ones
 * dropped, unsupported filters searched locally); `gbrain cloud` refuses
 * without consent and connect/status/primary/disconnect round-trip. Serial:
 * replaces global fetch and process env. PGLite, keyword-only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { HYDRADB_API_KEY_ENV, HYDRADB_CONFIG, hydraDocId, resolveHydraConnection, saveHydraApiKey } from '../src/core/hydradb.ts';
import { hydraPrimarySearch } from '../src/core/search/hydra-primary.ts';
import { mirrorBrain } from '../src/core/hydradb-mirror.ts';
import { runCloud } from '../src/commands/cloud.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { drainAllBackgroundWorkForCliExit } from '../src/core/background-work.ts';
import type { SearchResult } from '../src/core/types.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

interface CloudDoc { id: string; title: string; markdown: string; meta: { gbrain_source: string; gbrain_slug: string; gbrain_type?: string } }
const cloud = {
  database: null as string | null,
  docs: new Map<string, CloudDoc>(),
  calls: [] as string[],
  queries: [] as Array<Record<string, unknown>>,
  fail: false,
};
const realFetch = globalThis.fetch;
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 300, data }), { status, headers: { 'content-type': 'application/json' } });

async function fakeHydra(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  cloud.calls.push(`${method} ${url.pathname}`);
  if (cloud.fail) return reply(null, 503);
  const json = () => JSON.parse(String(init!.body));
  switch (`${method} ${url.pathname}`) {
    case 'POST /databases':
      if (cloud.database) return reply(null, 409);
      cloud.database = json().database;
      return reply({});
    case 'GET /databases/status':
      return reply({ infra: { ready_for_ingestion: true } });
    case 'DELETE /databases':
      cloud.database = null;
      cloud.docs.clear();
      return reply({});
    case 'POST /context/ingest': {
      const form = init!.body as FormData;
      const files = form.getAll('documents') as File[];
      const items = JSON.parse(String(form.get('document_metadata')));
      if (files.length !== items.length) return reply(null, 400);
      for (const [i, item] of items.entries()) {
        cloud.docs.set(item.id, { id: item.id, title: files[i]!.name.replace(/\.md$/, ''), markdown: await files[i]!.text(), meta: item.additional_metadata });
      }
      return reply({ failed_count: 0, results: items.map((item: { id: string }) => ({ id: item.id, status: 'queued' })) }, 202);
    }
    case 'GET /context/status':
      return reply({ statuses: (url.searchParams.get('ids') ?? '').split(',').map(id => ({ id, indexing_status: 'completed' })) });
    case 'DELETE /context': {
      const ids = json().ids as string[];
      for (const id of ids) cloud.docs.delete(id);
      return reply({ deleted_count: ids.length, results: ids.map(id => ({ id, deleted: true })) });
    }
    case 'POST /query': {
      const body = json();
      cloud.queries.push(body);
      const allowed: string[] | undefined = body.metadata_filters?.additional_metadata?.gbrain_source;
      const types: string[] | undefined = body.metadata_filters?.additional_metadata?.gbrain_type;
      const chunks = [...cloud.docs.values()].filter(d => (!allowed || allowed.includes(d.meta.gbrain_source)) && (!types || types.includes(d.meta.gbrain_type ?? '')))
        .map(d => ({ id: d.id, source_title: d.title, chunk_content: d.markdown, additional_metadata: d.meta }));
      return reply({ chunks });
    }
    default:
      return reply(null, 404);
  }
}

let engine: PGLiteEngine;
let sourceId: string;
let otherSource: string;
const Q = 'Where is the Forge offsite booked?';
const FENCE = [
  '## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Founded Acme in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |',
  '| 2 | Prefers async over meetings | preference | 0.85 | private | medium | 2026-04-29 |  | 1:1 notes |  |',
  '<!--- gbrain:facts:end -->',
].join('\n');

const query = async (params: Record<string, unknown> = {}) =>
  await handleToolCall(engine, 'query', { query: Q, expand: false, use_cache: false, source_id: sourceId, limit: 8, ...params }) as SearchResult[];
const settle = (slug?: string) => engine.executeRaw(
  `UPDATE pages SET updated_at = now() - interval '1 minute' WHERE source_id = ANY($1::text[])${slug ? ' AND slug = $2' : ''}`,
  slug ? [[sourceId, otherSource], slug] : [[sourceId, otherSource]]);
const disconnectAll = async () => { for (const key of Object.values(HYDRADB_CONFIG)) await engine.unsetConfig(key); };
const connectAll = async () => {
  cloud.database = 'gbrain';
  await engine.setConfig(HYDRADB_CONFIG.database, 'gbrain');
  await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
};
const conn = { database: 'gbrain', apiKey: 'hk_test.secret' };
const cloudDoc = (source: string, slug: string, markdown: string) =>
  cloud.docs.set(hydraDocId(source, slug), { id: hydraDocId(source, slug), title: slug, markdown, meta: { gbrain_source: source, gbrain_slug: slug } });

beforeAll(async () => {
  globalThis.fetch = fakeHydra as typeof fetch;
  process.env[HYDRADB_API_KEY_ENV] = conn.apiKey;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  otherSource = await newSource(engine);
  await putPage(engine, sourceId, 'notes/forge-offsite', page('note', 'Forge offsite', 'The Forge offsite is booked in Santa Fe.'));
  await putPage(engine, sourceId, 'people/acme-founder', page('person', 'Acme founder', `Builds widgets.\n\n${FENCE}`));
  await putPage(engine, sourceId, 'notes/diary', page('note', 'Diary', 'A private entry about the Forge offsite.', 'visibility: private\n'));
  await putPage(engine, sourceId, 'notes/garden', page('note', 'Garden', 'Tomatoes need water. CI token ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8.'));
  await putPage(engine, otherSource, 'notes/elsewhere', page('note', 'Elsewhere', 'Another source.'));
  await putPage(engine, sourceId, 'notes/retired', page('note', 'Retired', 'An old Forge offsite plan.'));
  await engine.softDeletePage('notes/retired', { sourceId });
  await settle();
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete process.env[HYDRADB_API_KEY_ENV];
  await engine?.disconnect();
}, 60_000);

beforeEach(async () => {
  cloud.database = null;
  cloud.docs.clear();
  cloud.calls = [];
  cloud.queries = [];
  cloud.fail = false;
  await disconnectAll();
  _resetCliExitVerdictForTests();
});

describe('mirror', () => {
  test('sends the embedding projection: no private page, no private fact row, no secret', async () => {
    const r = await mirrorBrain(engine, conn);
    expect(r.upserted).toBe(4);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/diary'))).toBe(false);
    const founder = cloud.docs.get(hydraDocId(sourceId, 'people/acme-founder'))!;
    expect(founder.markdown).toContain('Founded Acme in 2017');
    expect(founder.markdown).not.toContain('Prefers async');
    expect(founder.meta).toMatchObject({ gbrain_source: sourceId, gbrain_slug: 'people/acme-founder', gbrain_type: 'person' });
    const garden = cloud.docs.get(hydraDocId(sourceId, 'notes/garden'))!.markdown;
    expect(garden).toContain('Tomatoes need water.');
    expect(garden).not.toContain('ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  });

  test('resumes from the cursor and keeps it when HydraDB fails', async () => {
    await mirrorBrain(engine, conn);
    cloud.calls = [];
    expect((await mirrorBrain(engine, conn)).upserted).toBe(0);
    expect(cloud.calls.filter(c => c === 'POST /context/ingest')).toHaveLength(0);

    await putPage(engine, sourceId, 'notes/new-idea', page('note', 'New idea', 'Ship the cloud arm.'));
    await settle('notes/new-idea');
    const cursor = await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
    cloud.fail = true;
    await expect(mirrorBrain(engine, conn)).rejects.toThrow('HydraDB 503');
    expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).toBe(cursor);
    cloud.fail = false;
    expect((await mirrorBrain(engine, conn)).upserted).toBe(1);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/new-idea'))).toBe(true);
  });

  test('a page soft-deleted since the last run is removed from the cloud', async () => {
    await mirrorBrain(engine, conn);
    await putPage(engine, sourceId, 'notes/doomed', page('note', 'Doomed', 'Delete me.'));
    await settle('notes/doomed');
    await mirrorBrain(engine, conn);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/doomed'))).toBe(true);
    await engine.setConfig(HYDRADB_CONFIG.deletedSince, '2000-01-01T00:00:00.000000Z');
    await engine.softDeletePage('notes/doomed', { sourceId });
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '1 minute' WHERE source_id = $1 AND slug = 'notes/doomed'`, [sourceId]);
    expect((await mirrorBrain(engine, conn)).removed).toBe(1);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/doomed'))).toBe(false);
  });
});

describe('HydraDB as primary search', () => {
  const pages = (rows: SearchResult[]): unknown[] => rows.filter(r => r.result_type !== 'fact').map(r => [r.result_type ?? 'page', r.slug ?? null, r.source_id]);

  test('off, primary off, or HydraDB down: no change from local search', async () => {
    const off = await query();
    expect(cloud.calls).toEqual([]);
    await connectAll();
    cloudDoc(sourceId, 'notes/remote-only', 'The Forge offsite moved to Missoula.');
    await engine.setConfig(HYDRADB_CONFIG.primary, 'false');
    expect(JSON.stringify(await query())).toBe(JSON.stringify(off));
    await engine.setConfig(HYDRADB_CONFIG.primary, 'true');
    cloud.fail = true;
    expect(JSON.stringify(await query())).toBe(JSON.stringify(off));
  });

  test('on: rows follow HydraDB order as local page rows; unheld pages are cloud rows; deleted pages dropped', async () => {
    await connectAll();
    cloudDoc(sourceId, 'notes/garden', 'Tomatoes need water.');
    cloudDoc(sourceId, 'notes/remote-only', 'The Forge offsite moved to Missoula.');
    cloudDoc(sourceId, 'notes/retired', 'An old Forge offsite plan.');
    cloudDoc(sourceId, 'notes/forge-offsite', 'The Forge offsite is booked in Santa Fe.');
    cloudDoc(otherSource, 'notes/elsewhere', 'Another source.');
    const on = await query();
    expect(pages(on)).toEqual([['page', 'notes/garden', sourceId], ['cloud', null, sourceId], ['page', 'notes/forge-offsite', sourceId]]);
    expect(on.find(r => r.slug === 'notes/garden')!.page_id).toBeGreaterThan(0);
    expect(on.find(r => r.result_type === 'cloud')!.chunk_text).toBe('The Forge offsite moved to Missoula.');
    expect(cloud.queries.at(-1)!.metadata_filters).toEqual({ additional_metadata: { gbrain_source: [sourceId] } });
  });

  test('a remote caller gets only its sources and never a private page', async () => {
    await connectAll();
    cloudDoc(sourceId, 'notes/diary', 'A private entry about the Forge offsite.');
    cloudDoc(sourceId, 'notes/remote-only', 'The Forge offsite moved to Missoula.');
    cloudDoc(otherSource, 'notes/elsewhere', 'The Forge offsite budget lives elsewhere.');
    const auth = { token: 't', clientId: 'cloud-probe', scopes: ['read'], sourceId, allowedSources: [sourceId] };
    const r = await dispatchToolCall(engine, 'query', { query: Q, expand: false, limit: 8 },
      { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
    const text = r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('moved to Missoula');
    expect(text).not.toContain('budget lives elsewhere');
    expect(text).not.toContain('private entry');
  });

  test('pagination keeps HydraDB ranking instead of switching to local search', async () => {
    await connectAll();
    cloudDoc(sourceId, 'notes/garden', 'Tomatoes need water.');
    cloudDoc(sourceId, 'notes/forge-offsite', 'The Forge offsite is booked in Santa Fe.');
    expect(pages(await query({ offset: 1 }))).toEqual([['page', 'notes/forge-offsite', sourceId]]);
    expect(cloud.queries).toHaveLength(1);
  });

  test('a committed page write is pushed to HydraDB', async () => {
    await connectAll();
    await putPage(engine, sourceId, 'notes/kiln', page('note', 'Kiln', 'Ship the kiln scheduler.'));
    await drainAllBackgroundWorkForCliExit();
    expect(cloud.docs.get(hydraDocId(sourceId, 'notes/kiln'))?.markdown).toContain('Ship the kiln scheduler.');
  });
});

describe('gbrain cloud', () => {
  const quiet = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_NON_INTERACTIVE: '1' }, fn);

  test('connect without consent writes nothing and calls nothing', async () => {
    await quiet(() => runCloud(engine, ['connect']));
    expect(currentExitCode()).toBe(1);
    expect(await engine.getConfig(HYDRADB_CONFIG.database)).toBeNull();
    expect(cloud.calls).toEqual([]);
  });

  test('connect --yes creates the database, mirrors and makes HydraDB primary; primary off; disconnect --purge-cloud deletes it', async () => {
    await quiet(() => runCloud(engine, ['connect', '--yes']));
    expect(currentExitCode()).toBe(0);
    expect(cloud.database).toBe('gbrain');
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/forge-offsite'))).toBe(true);
    expect(await engine.getConfig(HYDRADB_CONFIG.primary)).toBe('true');

    await quiet(() => runCloud(engine, ['primary', 'off']));
    expect(await engine.getConfig(HYDRADB_CONFIG.primary)).toBe('false');

    await quiet(() => runCloud(engine, ['disconnect', '--purge-cloud', '--yes']));
    expect(cloud.calls).toContain('DELETE /databases');
    expect(cloud.database).toBeNull();
    for (const key of Object.values(HYDRADB_CONFIG)) expect(await engine.getConfig(key)).toBeNull();
  });

  test('connect reuses an existing database, so a second device joins it', async () => {
    cloud.database = 'gbrain';
    await quiet(() => runCloud(engine, ['connect', '--yes', '--no-push']));
    expect(currentExitCode()).toBe(0);
    expect(await engine.getConfig(HYDRADB_CONFIG.database)).toBe('gbrain');
    expect(cloud.calls).not.toContain('POST /context/ingest');
  });

  test('a vault key is used when the environment has none', async () => {
    await withEnv({ [HYDRADB_API_KEY_ENV]: undefined }, async () => {
      await engine.setConfig(HYDRADB_CONFIG.database, 'gbrain');
      expect(await resolveHydraConnection(engine)).toBeNull();
      await engine.setConfig(HYDRADB_CONFIG.credentialId, await saveHydraApiKey('hk_vault.secret'));
      expect(await resolveHydraConnection(engine)).toEqual({ database: 'gbrain', apiKey: 'hk_vault.secret' });
    });
  });
});


test('archiving and restoring an already mirrored source reconciles unchanged pages', async () => {
  await mirrorBrain(engine, conn);
  const cursor = await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
  try {
    await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', [sourceId]);
    cloud.fail = true;
    await expect(mirrorBrain(engine, conn)).rejects.toThrow('HydraDB 503');
    cloud.fail = false;
    await mirrorBrain(engine, conn);
    expect(cloud.docs.has(hydraDocId(sourceId, 'notes/forge-offsite'))).toBe(false);
    expect(cloud.docs.has(hydraDocId(otherSource, 'notes/elsewhere'))).toBe(true);
    expect(await engine.getConfig(HYDRADB_CONFIG.pagesCursor)).toBe(cursor);
    await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [sourceId]);
    await mirrorBrain(engine, conn);
    expect(cloud.docs.get(hydraDocId(sourceId, 'notes/forge-offsite'))?.markdown).toContain('Santa Fe');
  } finally {
    cloud.fail = false;
    await engine.executeRaw('UPDATE sources SET archived = false WHERE id = $1', [sourceId]);
  }
});

test('cloud type aliases admit both held and remote-only initiative pages', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hydra-alias-'));
  const dir = join(home, '.gbrain', 'schema-packs', 'hydra-alias-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ api_version: 'gbrain-schema-pack-v1', name: 'hydra-alias-test',
    version: '1.0.0', extends: 'gbrain-base', page_types: [{ name: 'initiative', primitive: 'entity', aliases: ['company'], path_prefixes: ['initiatives/'] }] }));
  await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
    await engine.setConfig(`schema_pack.source.${sourceId}`, 'hydra-alias-test');
    try {
      await putPage(engine, sourceId, 'initiatives/alias-held', page('initiative', 'Held initiative', 'Forge initiative in Santa Fe.'));
      await connectAll();
      await mirrorBrain(engine, conn, { full: true });
      cloud.docs.set('remote-alias', { id: 'remote-alias', title: 'Remote initiative', markdown: 'Remote Forge initiative.',
        meta: { gbrain_source: sourceId, gbrain_slug: 'initiatives/alias-remote', gbrain_type: 'initiative' } });
      for (const filters of [{ type: 'company' }, { types: ['company'] }]) {
        const rows = 'type' in filters ? (await hydraPrimarySearch(engine, Q, { ...filters, sourceId }, 8))! : await query(filters);
        expect(rows.some(row => row.slug === 'initiatives/alias-held')).toBe(true);
        expect(rows.some(row => row.result_type === 'cloud' && row.chunk_text.includes('Remote Forge'))).toBe(true);
        expect((cloud.queries.at(-1) as any).metadata_filters.additional_metadata.gbrain_type).toEqual(['company', 'initiative']);
      }
      cloud.queries = [];
      expect(await hydraPrimarySearch(engine, Q, { sourceId, type: 'company', types: ['note'] }, 8)).toEqual([]);
      expect(cloud.queries).toHaveLength(0);
    } finally { await engine.unsetConfig(`schema_pack.source.${sourceId}`); }
  });
  rmSync(home, { recursive: true, force: true });
});

test('disconnecting one brain preserves a shared vault key for another brain', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hydra-shared-vault-'));
  const other = new PGLiteEngine();
  await other.connect({}); await other.initSchema();
  try {
    await withEnv({ GBRAIN_HOME: home, [HYDRADB_API_KEY_ENV]: undefined }, async () => {
      const key = 'hk_shared.synthetic';
      const id = await saveHydraApiKey(key);
      expect(await saveHydraApiKey(key)).toBe(id);
      for (const brain of [engine, other]) {
        await brain.setConfig(HYDRADB_CONFIG.database, 'gbrain');
        await brain.setConfig(HYDRADB_CONFIG.credentialId, id);
      }
      await runCloud(engine, ['disconnect']);
      expect(await resolveHydraConnection(engine)).toBeNull();
      expect(await resolveHydraConnection(other)).toEqual({ database: 'gbrain', apiKey: key });
    });
  } finally { await other.disconnect(); rmSync(home, { recursive: true, force: true }); }
}, 120_000);
