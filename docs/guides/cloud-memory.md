# Cloud memory — HydraDB as storage and search backend (opt-in)

Connecting a brain to [HydraDB](https://docs.hydradb.com) copies every page, past
and future, to a HydraDB database and makes HydraDB the search backend: `query`,
`search` and `recall` rank with HydraDB. It is off until you connect. The brain
keeps a full local copy, which stays the system of record for writes, links,
facts and versions, and is searched whenever HydraDB is off or unreachable.
Another device connected to the same database searches the whole brain, even
before it holds the pages.

## Quick start

**Say to your agent:** *"Make HydraDB my brain's backend"*: the agent runs
`gbrain cloud connect`, which shows what will be shared and asks you in a
terminal. *"Is my brain synced to HydraDB?"* runs `gbrain cloud status`.
*"Search my brain locally again"* runs `gbrain cloud primary off`.

```bash
gbrain cloud connect          # disclosure, consent, API key, full backfill, HydraDB becomes primary
gbrain cloud status           # database, key prefix, search backend, last push
```

You need a HydraDB API key from <https://dashboard.hydradb.com>. `connect` takes it
from `HYDRA_DB_API_KEY`, from stdin (`--key -`), or from a prompt, and stores it in
the credential vault (`~/.gbrain/credentials.json`, 0600). The config table holds
only the vault id.

## What leaves the machine

The text gbrain already gives an embedding provider (each page's fence-aware
chunk projection), with every secret gbrain's scanner finds redacted on top, the
same rule the Memorable relay applies. These never leave:

- private pages (`visibility: private`, and derived pages that default private)
- private rows of a `## Facts` fence, and held fence rows
- embed-skipped and quarantined pages
- private keys, tokens, API keys and other detected secrets (sent as `<REDACTED:…>`)

A page that turns private, empties out, or is deleted is removed from the cloud.

## How it stays current

- **Backfill:** `connect` sends every existing page.
- **On every write:** each committed page write (put, edit, delete, import, sync,
  `remember`, connector syncs) is pushed a moment after it settles.
- **Catch-up:** the `cloud_mirror` autopilot phase sends everything changed since
  its cursor, including maintenance writes (dream, chronicle, extraction) that
  don't go through the write journal, and anything a failed push missed.

`gbrain cloud push` mirrors now; `--full` re-sends every page. HydraDB indexes
asynchronously: a deletion stops matching almost at once, while a new or edited
page can take up to about half a minute to be searchable.

Bound: a page soft-deleted and then purged while every mirror run failed stays in
the cloud until `gbrain cloud disconnect --purge-cloud`.

## How search uses it

While HydraDB is primary, `query`, `search` and `recall` take their ranking from
HydraDB (2.5 s budget, scoped to the caller's sources). Each hit resolves to this
brain's own page row under the caller's full read policy, so trust labels,
`get_page` and evidence delivery work as before:

- the page is here and the caller may read it: a normal page row;
- the page is here but deleted, archived, quarantined, private to this caller or
  outside its scope: dropped;
- the page is not here (another device's): a `result_type: "cloud"` row with the
  passage, labelled `trust_tier: unknown`, dropped for callers with a trust floor.

Searched locally instead:

- queries with filters HydraDB can't apply (`offset`, types, slug filters,
  dates, `--since`/`--until`, language, symbols, image search);
- any query while HydraDB is unreachable, slow, or returns an error;
- `recall` on a brain without an embedding key, and `context_pack`, which reads
  entity cards rather than searching.

While HydraDB is primary, private pages are not searchable (they are never sent),
and a page written seconds ago may not be found yet.

## Off switches

```bash
gbrain cloud primary off                  # search locally; pages keep syncing
gbrain cloud disconnect                   # stop everything; the cloud copy is kept
gbrain cloud disconnect --purge-cloud     # also delete the HydraDB database
```

`hydradb.*` keys are not settable with `gbrain config set`: `gbrain cloud connect`
is the only way to turn this on, so it can't be enabled around the disclosure.
