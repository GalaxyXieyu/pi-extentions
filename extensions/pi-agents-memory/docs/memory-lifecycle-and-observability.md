# Memory Lifecycle and Observability Plan

本文件定义统一记忆层后续的生命周期和统计扩展边界。它不改变当前已验证的 Viking Memory API 或 OpenViking API 合同，也不主动删除或批量修改远端数据。

## Lifecycle

```text
session input
  -> capture payload
  -> candidate extraction
  -> dedup / conflict decision
  -> indexed memory
  -> recalled context
  -> confirmed / superseded / expired
  -> archive or explicit admin purge
```

### Unified record metadata

```yaml
id: backend-owned-id
kind: profile | preference | project | decision | event | experience | workflow
scope: user | project | workspace | session | global
status: candidate | confirmed | superseded | expired
confidence: low | medium | high
source:
  backend: viking-memory | openviking
  session_id: string
  files: []
  commands: []
created_at: timestamp
updated_at: timestamp
last_recalled_at: timestamp
valid_until: timestamp|null
supersedes: []
related: []
```

### Backend mapping

| Lifecycle stage | Viking Memory API | OpenViking API |
| --- | --- | --- |
| Raw session | `session/add` | session messages |
| Extraction | collection pipeline | session commit + memory policy |
| Event | `event_v1` / custom event | events / experiences |
| Profile | collection profile schema + `profile/add` | profile/preferences memory policy |
| Retrieval | `get_context` / `search` | context search / fallback recall |
| Conflict/update | backend UpdateEvent/Profile or collection rules | backend memory dedup/merge |
| Expiry | TTL/time decay | policy and record metadata |
| Admin purge | explicit external admin action | explicit external admin action |

The adapter must report unsupported lifecycle operations instead of silently mapping them to a different backend operation.

## Statistics

### Request metrics

- backend, operation, status, error class
- request count, timeout count, failure count
- latency and optional p95 aggregation
- request id when returned
- active session and pending queue count

### Memory metrics

- captured messages and capture batches
- extracted event/profile counts when the backend reports them
- recalled item count by `kind` and `scope`
- average/maximum score
- empty recall rate and dedup rate
- confirmed, superseded, expired and conflict counts when available

### Cost metrics

- embedding tokens
- extraction/VLM tokens
- recall tokens
- per-backend and per-project usage

Metrics must be bounded and privacy-safe: no raw prompts, memory bodies, API keys, full tool output or authentication headers.

## Management surface

Agent-facing commands remain read/search/write-only:

- `/memory`
- `/memory-capabilities`
- `/memory`
- `/memory-capabilities`
- explicit search and remember tools

Future admin-only commands may include:

- `stats`
- `inspect <id>`
- `audit <session-id>`
- `export`
- `archive`
- `purge`

`purge`, schema changes, reindexing and bulk updates must not be exposed as model-callable tools. They require explicit human confirmation and a separate admin credential.

## Model configuration

### OpenViking

The local Docker deployment can configure independently:

- `embedding.dense`: vector model/provider
- `vlm`: semantic extraction/summarization model/provider
- `query_planner`: retrieval intent expansion model
- `rerank`: optional result reranker
- `memory` and session memory policy

These values live in the ignored local `.runtime/openviking/ov.conf` or a user-owned secure config, never in Git.

### Viking Memory API

The Pi adapter controls request shape, memory filters, purpose, quotas and budgets. Extraction model, event/profile schema and collection pipeline are remote collection settings. The adapter must surface collection errors, such as a missing `sys_profile_v1` schema, instead of pretending the profile capability is available.

## Rollout order

1. Add bounded structured request/recall/extraction events.
2. Add a local stats aggregator with redacted fields.
3. Add inspect/audit read-only commands.
4. Add confirmed/superseded/expired state handling where each backend supports it.
5. Add explicit admin export/archive/purge flows only after authentication and confirmation design is reviewed.
