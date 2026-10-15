# What belongs in shared memory

**Say to your agent:** *"Remember my preference for short recommendations, but keep this session's setup and credentials out of shared memory."*

GBrain can carry durable facts and preferences between agents that have access to
the same brain and source. It does not replace the harness's identity,
instructions, configuration, or permission controls.

## Durable knowledge versus runtime state

Save explicit requests to remember with provenance: preferences, corrections,
decisions, commitments, and facts the user wants available later. For example,
"I want meeting briefs in three bullets" is useful shared knowledge. Recall it
before the next brief, and verify corrections against the stored record.

Keep current task progress, temporary tool output, local paths, enabled plugins,
MCP connection settings, credentials, and harness activation state in the
appropriate local configuration or session state. A remembered preference does
not install a skill, change an authorization grant, or override higher-priority
instructions. Do not put secrets in memory pages. A durable decision about a
setup can be recorded without copying its credentials or assuming that setup is
active in another harness.

Automatic capture is opt-in. Installing the harness hooks opts into the
compaction and SessionEnd capture lanes; `gbrain config set
memory.auto_writeback off` stops every capture lane, and `gbrain bootstrap
harness --remove` stops the hooks from banking session text at all (see
[ambient writeback](ambient-writeback.md#capture-lanes-and-the-off-switch)).
Time-limited facts need an explicit TTL; ordinary
saved facts do not expire just because they describe a temporary situation.
`forget` withdraws a fact from active recall, not from all source material,
history, or private backups. To remove the text itself from live stores, the
owner runs a [purge](#purge) on the brain host. See [ambient writeback](ambient-writeback.md).

## What a write costs

Saving text or a fact never waits on a generative model: a write is
acknowledged and keyword-queryable without one. Embeddings are the configured
feature (`remember` embeds before saving to detect near-duplicates; pages embed
just after the save, and a page over 1 MiB embeds later through the stale
sweep: see [large pages](#large-pages)). With default settings each saved page of an
extraction-eligible type (note, meeting, email and similar) also gets one facts
extraction call after it is saved; it runs as a queued job, is attributed to the
write that caused it, and stops with `gbrain config set facts.extraction_enabled
false`.
`gbrain config set facts.page_write_notability_filter medium-and-up` keeps
only high- and medium-notability facts from page writes (`high-only` keeps the
high tier, as sync does; `all`, the default, keeps every tier). Image OCR, when turned on (`embedding_image_ocr`), runs before the save.
Set `GBRAIN_AI_CALL_LOG=<path>` to record every model call a process makes (kind,
model, tokens, duration, and the write request, job or cycle phase it served; no
prompt or response text).

## Page writes and the graph are separate outcomes

| Write path | Graph behavior |
|---|---|
| Trusted local `put_page` / capture | Extracts supported page references without an LLM when auto-linking is enabled. |
| MCP `put_page` / capture / `edit_page`, including stdio | Saves body references as text; no inline graph extraction. The receipt reports `auto_links.skipped: remote`. |
| Post-commit `links` effect of an MCP page write | Adds untyped `mentions` edges (`link_source: mcp-remote-mention`) for the body's markdown links, `[[wikilinks]]` and page-path mentions whose target already exists in the same source, is not deleted, is visible to the writer and is inside its slug grant. No typed, frontmatter, timeline or cross-source edges and no new pages. The receipt reports `auto_links.mention_links: queued`; `get_write_request` lists the effect with `added`/`removed` counts. `gbrain config set mcp.remote_auto_links off` (or `auto_link off`) disables it. |
| Stdio `gbrain serve` | Has bounded, best-effort startup and idle maintenance sweeps, unless disabled. This is eventual maintenance, not a guarantee that a remote write immediately has edges. |
| `gbrain serve --http` | Does not self-sweep. The host must run maintenance explicitly. |

For an HTTP brain, ask the host operator to run `gbrain sweep --once` (it can
delegate to the live server over local IPC), or explicitly extract links and
timeline entries for the intended source. Use an authorized `add_link` operation
for an edge needed immediately, then verify it with `get_links` or a graph query.
Check the write receipt and the graph separately; a saved page is not proof of
graph reconciliation. See [graph setup](../../INSTALL_FOR_AGENTS.md#step-45-wire-the-knowledge-graph).

A timeline entry has no update or remove operation: `add_timeline_entry`
returns the rendered bullet, and editing or deleting that bullet in the page's
Timeline section through `edit_page` (with `expected_revision`) refreshes or
removes its row, because the page is the system of record for timeline rows.

<a id="large-pages"></a>
## Large pages

**Say to your agent:** *"Import this long conversation export as one page and
make it searchable. Tell me what embedding it will cost before you spend
anything."* The agent imports the file on the brain host with
`gbrain import <file>`, checks that keyword search finds it, and asks before
running `gbrain embed`.

**Say to your agent:** *"I upgraded gbrain. Which of my big pages couldn't be
found before, and what would it cost to embed them now?"* The agent runs
`gbrain reindex --oversized --dry-run --json` and `gbrain doctor --json`, then
asks before `gbrain embed --held --max-usd <N>`.

A page stays one page whatever its size: one slug, one title, one set of
links. Size no longer decides whether search can find it. Every Markdown page
up to 24 MiB (25,165,824 bytes) is stored, chunked and keyword-indexed when it
is written, on every engine. Don't split a page by hand to make it searchable.

| Page body | Keyword search | Meaning (vector) search |
| --- | --- | --- |
| Up to 1 MiB | right after the write | right after the write |
| Over 1 MiB, up to 24 MiB (a *large* page) | right after the write | after the write commits, when the stale sweep embeds it (`gbrain embed --stale`, sync's embed pass, autopilot) |
| Over 24 MiB | refused with [`file_too_large`](write-refusals.md#file_too_large); nothing is stored | — |

Code files keep a lower limit; see [limits per entry point](#large-page-limits).

A large page commits without vectors, so a big write never waits on the
embedding provider. It also differs from a small page in three ways. Its
chunks use the free title context tier, never a per-chunk model synopsis.
Before it is embedded, the junk check samples its head, middle and tail
instead of reading the whole body. And gbrain keeps a bounded number of
version snapshots of it, so a page appended to every day doesn't store its
whole body again in history on every write.

An operator who set a lower `content_sanity.bytes_block` (the
`GBRAIN_PAGE_BLOCK_BYTES` env var, the config file, or the database config)
stops embedding above that value: such a page is stored with an `embed_skip`
marker and gets no vectors, but it is still chunked, so keyword search finds
it. The same holds for any page with an `embed_skip` marker. The default is
the 24 MiB ceiling, so nothing is skipped for size unless someone lowered it.

**What a write says about size.** `put_page`, `remember` and sync receipts
carry the same field for a large or `embed_skip` page, so the writer learns on
the write itself, without reading the sync log. `size_state` on a page receipt
(and on `remember` when it appended to such a page) is
`{ embedding, reason, bytes }`; a sync receipt has `size_states`:
`{ total, pages }` with the first 50 pages, each with its `slug`, `path` (a
managed sync) and the same fields, and the sync output prints a line per page.
An ordinary page carries no field.

| `embedding` | `reason` | What happened |
| --- | --- | --- |
| `deferred` | `large_page` | Over 1 MiB: committed with chunks and no vectors; the embedding sweep embeds it after the commit, under `embed.max_usd_per_page`. |
| `partial` | `spend_cap` | The per-page cap stopped embedding; the rest stays keyword-only. |
| `held` | e.g. `upgrade_backfill` | Embedding waits for the user's approval of the previewed cost (`gbrain embed --held`). |
| `skipped` | `oversized` | Over the operator's `bytes_block`: chunked and keyword-searchable, never embedded. |
| `skipped` | `operator_marker` | Another `embed_skip` marker: chunked and keyword-searchable, never embedded. |

A body over the 24 MiB ceiling has no receipt: the write is refused as
`request_too_large`.

<a id="large-page-limits"></a>
### Limits per entry point

The page ceiling applies everywhere, but some transports carry less. When one
of them refuses a page under 24 MiB, send the page by file instead: nothing is
wrong with the page.

| Entry point | Limit | What to do above it today |
| --- | --- | --- |
| Markdown import and sync (`gbrain import`, `gbrain sync`, the managed sync blob read) | 24 MiB | — |
| CLI stdin (`gbrain put`, `gbrain capture --stdin`) | 24 MiB (was 5 MB) | — |
| MCP stdio (local agents, `gbrain serve`) | 64 MiB per JSON-RPC message (the MCP SDK default of 10 MiB is raised), so a JSON-escaped page at the ceiling fits | — |
| MCP over HTTP (`gbrain serve --http`) | 4 MiB request body (the MCP SDK default) | the same: sync or the CLI on the brain host (chunked uploads arrive in a later release) |
| Legacy HTTP transport | 1 MiB (`GBRAIN_HTTP_MAX_BODY_BYTES`) | the same |
| `put_pages` batch | 8 MiB per batch | send large pages one per `put_page`, or by file |
| Persistence journal | 64 MiB of outstanding JSON-escaped write intent per principal (was 32 MiB), 256 MiB per brain | nothing: a second large write waits for the first |
| Local persistence socket (IPC) | 32 MiB per frame, JSON-escaped | nothing for ordinary text; only a pathological page (mostly quotes or backslashes) reaches it below the ceiling |
| Pre-push secret scan | 25 MiB per file; gbrain never writes a canonical file over it | — |
| GitHub | warns at 50 MB, rejects at 100 MB | — |
| Export | aborts on a page over 32 MiB, which the 24 MiB ceiling makes unreachable | — |
| Company-brain inspection | 5 MB per file | unchanged |
| Transcript ingest input (Claude Code `.jsonl`) | 10 MiB by default, 50 MiB hard cap | unchanged |
| Code files | 5 MB | unchanged |

**Reading a large page.** Large reads come back in windows, not as one
response, because agent transports and harness result caps can't carry tens of
megabytes. The [`get_page` reference](../mcp/TOOL_REFERENCE.md#get_page)
describes how to read the next window.

**Cost.** Chunking and keyword indexing run locally and cost nothing.
Embedding a large page costs about $0.15 per 10 MB at the default embedding
model, so a page at the 24 MiB ceiling costs about $0.40. Each page has a paid
spend cap, `embed.max_usd_per_page` (default $2), covering its embedding at
every paid entry point (the stale sweep, `gbrain embed`, the post-write
embedding job). A large page uses the free title context tier, never paid
per-chunk synopses; conversation facts keep their own 25 MiB input bound and
are not yet metered by this cap. When several caps apply,
the lowest wins: the per-page cap, the run's consent cap (`--max-usd`),
`embed.backfill_max_usd` and `embed.backfill_max_usd_per_source_24h`. A page
over its cap is still keyword-searchable, and its newest chunks are embedded
first, up to the cap. Doctor's `partial_embedding` check names each such page
with the exact fix, `gbrain embed --slugs <slug> --max-usd <N>`; raising a cap
is the user's call.

<a id="large-pages-upgrade"></a>
**After upgrading.** Older releases stored a page over 500 KB with an
`embed_skip` marker (reason `oversized`) and no chunks. `gbrain upgrade` (its
`gbrain post-upgrade` step) re-chunks and keyword-indexes those pages itself
for up to two minutes, on the CPU, on keyless brains too, and prints a receipt;
`gbrain reindex --oversized` does the rest. The backfill is idempotent and
resumes where it stopped. It removes only gate-written markers whose reason is
`oversized`, and the matching `content_flag: oversized`; a page above the
operator's effective `bytes_block` keeps both and is re-chunked for keyword
search with no vectors. The backfill never embeds.
Backfilled pages over 1 MiB are held for consent; the post-upgrade notice and
doctor's `partial_embedding` check show how many are held and what embedding
them would cost. Pages between 500 KB and 1 MiB cost a cent or two each and
embed through the normal sweep under the existing caps.

```bash
gbrain reindex --oversized --dry-run --json      # preview the backfill: free, no provider calls
gbrain reindex --oversized --source <id>         # run it now for one source
gbrain embed --held --max-usd 2                  # embed every held page, capped at $2 (paid)
gbrain embed --slugs <slug> --max-usd 1          # embed one page, capped at $1 (paid)
gbrain search "<a phrase from deep in the page>" # keyword search finds it before any embedding
gbrain doctor --only partial_embedding --json    # pages embedded only up to their cap
gbrain config set embed.max_usd_per_page 5       # raise the per-page cap (ask the user first)
```

## Where text goes

Local storage does not mean every enabled feature runs locally. Keyless keyword
retrieval and deterministic link extraction need no model API. Configured cloud
embeddings receive the text being embedded; rerankers receive the query and
candidate passages; expansion receives the query; synthesis and LLM extraction
receive the relevant retrieved content or source text. Self-hosted providers have
their own deployment boundary. The connected agent's own model also receives
whatever memory its harness includes in context, even on a keyless GBrain setup.

Enable paid capabilities and automatic capture only with consent, using the
provider's actual data-handling policy. See [installation capabilities](../../INSTALL_FOR_AGENTS.md#step-2-api-keys)
and [spend controls](../operations/spend-controls.md). A spending cap is not a
promise that no text leaves the machine.

## Sharing and backup limits

Remote access depends on authenticated source/operation grants and visibility
filters. Sources organize memory; they do not isolate agents that share local
files or database credentials. Stdio is local access, not an HTTP client grant.
Read [brains and sources](../architecture/brains-and-sources.md#what-confines-remote-callers-and-what-does-not)
before choosing a sharing topology. Tests cover specific boundaries, not a
universal security guarantee.

<a id="fence-markers-in-code"></a>
**Fence markers quoted in code.** Since 0.60.97.0 the readers (the fence
parser, projections, repair) ignore a takes or facts fence marker that sits in
inline code or inside a fenced code block, and since 0.60.162.0 a marker
written into a cell is encoded, never live, so documenting the marker no longer
creates a phantom fence (#5395). The remote privacy boundary deliberately does
not follow: `sanitizeRemoteBody` still treats the first begin marker it sees,
quoted or not, as the start of a protected region and hides everything after
it from remote readers, and a remote whole-page replace of a page with an
unpaired quoted marker is refused with "The takes fence must be repaired before
replacing this page." The boundary only ever changes toward hiding more; a
remote reader that cannot see the tail of a page that quotes the marker is
seeing that rule, not a bug. To publish such a page remotely, write the marker
in a form the scanner does not match (split it, or describe it) or move the
mention after the real fence. Pinned by `test/fence-marker-code-context.test.ts`
("remote privacy boundary" and "remote page replacement").

Markdown export is a portable view of pages, **not a full database backup**.
DB-only facts and pages, revision history, withdrawal state, jobs, settings, and
authentication records may not be recoverable from Markdown. Use the engine's
full backup/restore path and verify a restore into a separate location. Treat
database backups as sensitive. See the [system-of-record contract](../architecture/system-of-record.md)
and [isolated local backup guide](in-agent-setup.md#6-back-up-the-complete-local-database).

<a id="purge"></a>
## Expire versus purge

`forget` **expires**: the fact stops being recalled, cannot be saved again in
the same source and visibility, and its row is struck in the page's Markdown.
The text stays in the row, the file, page history and backups.

Automatic extraction (sync import, `put_page`, `extract_facts`, the sweep)
skips a candidate whose exact claim was forgotten in that source and visibility
and still saves the other facts it found about the same entity; the entity and
completion write receipts and the extraction result count the skips as
`withdrawn_skipped`, and a group of only forgotten claims completes with nothing
inserted. Explicitly remembering the forgotten claim still refuses with
`fact_withdrawn`, and a purge tombstone still refuses the whole write with
`purged_content`. A claim forgotten after an extraction's facts were prepared
refuses that entity's write with `revision_conflict` and a detail naming the
withdrawal; nothing is published. An extraction keyed by its input alone (sync
import or the sweep, which have no request id) recovers on its next run from
such a refusal, and from a batch an older release refused for a forgotten
claim, by re-admitting the retained facts without another model call (at most
three follow-ups per batch, each visible as its own write receipt; the refused
receipts stay as they were). An extraction admitted under a request id replays
its receipt; give it a new `request_id` to extract again.

`gbrain forget <id> --purge` **purges**: an owner-only command on the brain
host that removes the claim from the live stores gbrain controls and returns a
receipt. It is a separate operation (`purge_fact`), never a mode of the
`forget` verb, and no MCP connection can call it; agents get
`trusted_local_only` with the command to give the user.

**Say to your agent:** *"I saved a secret by mistake. Show me what purging fact
42 would remove, then purge it once I confirm."* The agent runs
`gbrain forget 42 --purge --dry-run` and hands the purge itself to you.

What one purge does, in one transaction:

- deletes every fact row with the same normalized claim in the fact's source,
  visibility and entity (`--all-subjects`: every entity), and verbatim take
  copies (consolidated takes, takes with the same claim);
- drops the row (not a strike) from the page's facts or takes fence, from the
  stored page body and from every saved page version, then rebuilds that page's
  chunks; the canonical file is rewritten by the owner and committed as
  `gbrain: purge fact <hash8>` (no claim text in the commit);
- redacts stored write intents that carry the claim (a pending write blocks
  the purge with `purge_blocked_pending_recovery` until it finishes; retry with
  the same request id), deletes legacy query-cache rows and drops the fact's
  rewording-review rows (close active matches are returned first as
  `similar_active`);
- hides rows a model derived from the fact (through the derivation edges
  derivers record) and marks them `needs_rederive`; the receipt reports them as
  `retained_inactive`, not as removed text;
- records a text-free tombstone: the claim's fingerprint, its source,
  visibility, entity, request id and reason. Any later write of the same
  normalized claim is refused with `purged_content`, and a stale file, re-sync
  or revert drops the row on import.

On a terminal the CLI prints the dry-run receipt and asks you to type the
fact's 8-character token; without a terminal it needs `--yes` and
`--request-id`. `--match "<text>"` lists candidate ids and never purges.
`--status --request-id <id>` reports completion: `committed` (effects such as
the file rewrite still running, exit 10), `complete` (exit 0) or `incomplete`
(an effect failed or a swept store still holds the claim, exit 75; retry with
the same request id).

**The receipt lists residuals first.** Purge removes content from live stores;
it is not physical erasure. Out of its reach, and named in every receipt: the
brain repository's git history (the commits that carry the row are listed,
never rewritten) and every other clone or remote, backups taken before the
purge (a restore brings back the content and an older purge ledger), provider
copies (embedding and decision providers), Markdown exports and compiled
context files, and deleted rows in database pages and the write-ahead log until
vacuum. On PGLite, `--vacuum` compacts the touched tables; on Postgres the
receipt names the `VACUUM` the operator runs, and WAL archives, replicas and
point-in-time recovery stay outside gbrain. Claim text in page prose (outside a
facts fence) is reported as `source_prose`: edit or purge that page. Each store
in the receipt is `deleted`, `retained_inactive`, `unverified` (a probe hit its
time or row bound) or `out_of_reach`; "verified" covers only the swept stores.
The vector probe lists close same-model facts as possible rewordings; it is not
a residual count.

The tombstone fingerprint of a short claim is guessable: anyone who already
knows the claim can confirm it was purged. It never reveals what an unknown
claim said.

`gbrain delete <slug> --purge` purges a whole page the same way: facts filed on
it (tombstoned), its takes, take proposals, open loops, core notices, stored
write intents, attached file records and blobs, and the page row with its
chunks, versions, timeline, links and raw data. It records the page's content
hash and the hash of every saved version, so the same content or an older version of it is refused under any slug until
`gbrain pages unpurge <slug>`; `gbrain pages purges list` shows the tombstones.
An edited file imports normally. Its response carries the same store-by-store
`receipt` as a fact purge, naming other pages whose prose still states one of
the purged page's facts. A write refused because it carries purged content,
or accepted as a no-op after its purged rows were dropped, keeps no copy of
that content in its stored write request.

## Verify in the actual harness

Use a generic, unique test fact: remember it, recall it, correct it, recall the
correction, withdraw it, and confirm active recall no longer returns it. Then
open a new conversation in the intended harness and repeat recall with another
saved test fact. A local CLI test proves local storage, not skill activation or
cross-conversation recall in Grok Bot, Muse, Codex, or Claude Code.
