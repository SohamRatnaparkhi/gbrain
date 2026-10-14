# Optional HydraDB memory validation

`smoke.ts` exercises an isolated synthetic brain through connect, indexed
backfill, query/search/recall on a second brain without local embeddings,
fast/thinking Markdown MCP output, updates, local switching and deletion.
Set `GBRAIN_GSTACK_ROOT` to a gstack checkout to include its real context loader.
It creates and removes its own unique cloud database.

```bash
export HYDRA_DB_API_KEY=...                 # use your own key; do not commit it
bun evals/cloud-memory/smoke.ts
```

## Public retrieval comparison

`ab.ts` uses [LongMemEval](https://github.com/xiaowu0162/LongMemEval), a public
long-term conversation memory benchmark. Download its
[cleaned S dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json)
outside the repository. The checked-in split manifest
`evals/longmemeval/splits-seed42.json` records its SHA-256.

Select two questions per type, deterministically, from the existing development
split. Selection precedes retrieval and does not use gold answers:

```bash
export LME_DATASET=/absolute/path/longmemeval_s_cleaned.json
python3 - <<'PY'
import json, os
from pathlib import Path
questions = json.loads(Path(os.environ['LME_DATASET']).read_text())
dev = set(json.loads(Path('evals/longmemeval/splits-seed42.json').read_text())['dev40'])
selected = []
for kind in sorted({q['question_type'] for q in questions}):
    selected += sorted(q['question_id'] for q in questions
                       if q['question_id'] in dev and q['question_type'] == kind)[:2]
Path('/tmp/gbrain-lme-ids.txt').write_text('\n'.join(selected) + '\n')
PY
export HYDRA_DB_API_KEY=...
export OPENROUTER_API_KEY=...               # embeds the local baseline
bun evals/cloud-memory/ab.ts \
  --dataset "$LME_DATASET" --ids /tmp/gbrain-lme-ids.txt \
  --out /tmp/gbrain-lme-results.json \
  --work-dir /tmp/gbrain-lme-brains \
  --k 10 --local-share 0.3 --repeats 3
```

The harness compares four conditions through the shipped MCP `query` operation:

| Local corpus | Selected search backend | Cloud corpus |
| --- | --- | --- |
| All sessions | GBrain hybrid | Unused |
| All sessions | HydraDB fast | All sessions |
| Most recent 30% of sessions, rounded up per question | GBrain hybrid | Unused |
| Most recent 30% of sessions, rounded up per question | HydraDB fast | All sessions |

Local hybrid has complete `openai/text-embedding-3-small` vectors, plus GBrain's
keyword fusion. GBrain query expansion, semantic cache and autocut are disabled.
HydraDB's internal caching is not controlled. Gold session identifiers are hashed in page slugs and titles;
only the scorer knows the inverse mapping. Sources isolate each question's
haystack. Backend receipts disclose cloud fallbacks. Three repetitions balance
backend order; retrieval quality uses the first repetition and latency includes
all repetitions. Provisioning, ingestion and embeddings are excluded from query
latency. The complete public conversation corpus is uploaded only to a unique
disposable database, which is deleted in `finally`. `--work-dir` retains local
benchmark data and vectors for resumable reruns and checks corpus identity.

Metrics are any/all gold-session hit rate among up to ten returned query results,
gold-session recall, and end-to-end query p50/p95 latency. The reduced-local
comparison measures access to older cloud memory; it is not an equal-corpus
retrieval quality comparison. This small development pilot does not measure
answer accuracy, confidence intervals, or full-benchmark performance. A reader
model and the full held-out split are needed before making those claims.

Keep raw question/session/output rows outside the repository. Publish only
aggregate metrics, sample size, dataset hash, settings and fallback counts.

Cloud indexing is asynchronous and may take much longer than retrieval. The
runner waits for verified completion (up to 30 minutes per upload batch), logs
aggregate indexing states and error codes, and keeps the disposable database
identifier in `--work-dir/live-cloud.json` during the run for diagnosis. The
file and cloud database are removed after completion or failure.

Measured pilot: [six-category retrieval comparison](results/longmemeval-pilot-2026-10-14.md).
