/**
 * `entity` with `names`: resolve a list of names, codes and aliases in one
 * call, the way a reader resolves the account codes and nicknames a batch of
 * handoff mails names. Each name resolves exactly as `entity name:` does
 * (the card's candidate selection, `selectEntityCandidates`: alias, slug,
 * title and suffix arms; private and quarantined pages, siblings included,
 * hidden from remote callers) and returns a compact row: the page, its names,
 * the opening lines of its body (`lead`, from the candidate row) and its
 * identity siblings with theirs. No card is assembled (no references, facts or
 * open threads: a full card per name is `entity name:`), and the private-page
 * setting, mention policy and source pack are read once per batch.
 *
 * Bounded: at most ENTITY_NAMES_MAX names, ENTITY_LEAD_CHARS per lead,
 * duplicates resolved once.
 */
import type { BrainEngine } from '../engine.ts';
import { entityLookupScope, readAka, selectEntityCandidates, type EntityLookupScope } from './entity-card.ts';
import { readSiblingIdentity } from './entity-card-identity.ts';
import { boundedProjectedPrefix } from '../page-window/document.ts';
import { boundedPrefixSql, overlaidBoundedRows } from '../page-window/bounded-lead.ts';
import { redactFindings } from '../secret-scan.ts';

export const ENTITY_NAMES_MAX = 50;
export const ENTITY_LEAD_CHARS = 200;
const CONCURRENCY = 8;

export interface EntityNamePage { slug: string; title: string; type: string | null; aka: string[]; lead: string }
export type EntityNameRow =
  | ({ name: string; found: true } & EntityNamePage & { siblings?: EntityNamePage[] })
  | { name: string; found: false; suggestions?: Array<{ slug: string; title: string }> };

/** The opening prose of a page body: fences and secrets removed, headings, markers and table rows dropped, up to `max` characters. */
export function pageLead(body: string | null, max = ENTITY_LEAD_CHARS): string {
  const text = redactFindings(boundedProjectedPrefix(body), { highEntropy: true }).text
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('<!--') && !l.startsWith('|'))
    .join(' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function lookupEntityNames(engine: BrainEngine, sourceId: string, names: string[],
  opts: { remote: boolean }): Promise<{ results: EntityNameRow[]; found: number; missing: number }> {
  const unique = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  const scope = await entityLookupScope(engine, sourceId, opts.remote);
  const rows = new Map<string, EntityNameRow>();
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    await Promise.all(unique.slice(i, i + CONCURRENCY).map(async name => rows.set(name, await lookupOne(engine, sourceId, name, scope, opts))));
  }
  const results = unique.map(n => rows.get(n)!);
  const found = results.filter(r => r.found).length;
  return { results, found, missing: results.length - found };
}

async function lookupOne(engine: BrainEngine, sourceId: string, name: string, scope: EntityLookupScope,
  opts: { remote: boolean }): Promise<EntityNameRow> {
  const selected = await selectEntityCandidates(engine, sourceId, name, scope, { omitQuarantined: opts.remote });
  if (selected.kind !== 'hit') {
    const suggestions = (selected.kind === 'miss' ? selected.suggestions : []).slice(0, 3).map(s => ({ slug: s.slug, title: s.title }));
    return { name, found: false, ...(suggestions.length ? { suggestions } : {}) };
  }
  const { row } = selected;
  const aka = await readAka(engine, sourceId, row.slug);
  const { identity_siblings } = await readSiblingIdentity(engine, sourceId, row,
    { excludePrivate: scope.excludePrivate, excludeQuarantined: opts.remote, policy: scope.policy, pack: scope.pack });
  const siblingPages = identity_siblings?.pages ?? [];
  const bodies = new Map<string, string | null>([[row.slug, row.compiled_truth]]);
  if (siblingPages.length) {
    const sib = await engine.executeRaw<{ slug: string; source_id: string; compiled_truth: string | null }>(
      `SELECT slug, source_id, ${boundedPrefixSql('compiled_truth')} AS compiled_truth FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`,
      [sourceId, siblingPages.map(p => p.slug)]).catch(() => []);
    for (const s of await overlaidBoundedRows(engine, sib)) bodies.set(s.slug, s.compiled_truth);
  }
  return {
    name, found: true, slug: row.slug, title: row.title ?? row.slug, type: row.type ?? null, aka, lead: pageLead(bodies.get(row.slug) ?? null),
    ...(siblingPages.length ? { siblings: siblingPages.map(p => ({ slug: p.slug, title: p.title, type: p.type, aka: p.aka, lead: pageLead(bodies.get(p.slug) ?? null) })) } : {}),
  };
}
