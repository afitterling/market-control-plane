# Security Assessment (Evidence-Based)

**Scope:** static review of the `market-control-plane` repository at HEAD `4d8e260`. Each finding cites concrete `file:line` evidence from the working tree. Where a security control would be expected but no evidence of it exists, the finding is recorded as a TODO.

**Severity scale:** Critical → High → Medium → Low → Info.

**Method:** read every handler under `src/`, the SST infrastructure in `sst.config.ts`, and the dependency manifest. No dynamic testing was performed — runtime AWS configuration (IAM trust policies, KMS, WAF, account-level limits, CloudTrail, etc.) cannot be inspected from source and is listed separately under [Not assessable from this repo](#not-assessable-from-this-repo).

---

## What's already in place (positive evidence)

| Control | Evidence |
| --- | --- |
| Timing-safe Bearer token comparison | `src/http.ts:62-67` — `timingSafeEqual` with length pre-check |
| Auth required on every route (incl. health) | `src/api.ts:5`, `src/events.ts:25`, `src/stocks.ts:31,59,84,118`, `src/positions.ts:20,58,85` |
| Missing/empty server-side token short-circuits to 401 | `src/http.ts:31` — `!expectedToken` rejects all requests if env var unset |
| 401 response is uniform (no missing-vs-invalid leak) | `src/http.ts:32-37` |
| Secrets file gitignored | `.gitignore:3-5` — `.env`, `.env.*`, allow `.env.example` |
| TypeScript strict toolchain | `tsconfig.json` + `npm run typecheck` script in `package.json:11` |
| Runtime deps are AWS first-party only | `package.json:13-16` — two `@aws-sdk/*` packages, nothing else |

---

## Findings

### [HIGH] Single shared Bearer token grants full tenant-wide access

**Evidence:** `src/http.ts:27` reads a single global `API_BEARER_TOKEN` env var; every handler calls `requireBearerToken(event)` and treats success as full authorization. There is no per-client identity, no claims, no scopes.

**Risk:** Any caller with the token can read or mutate every stock, every position, and every event for every `accountId`. There is no way to revoke a single client without rotating the token for everyone. No audit trail can attribute actions to a specific caller.

**TODO:**
- Replace the shared bearer with per-client credentials (e.g., API Gateway Lambda authorizer + Cognito/JWT, or per-key entries in a `Clients` DynamoDB table).
- Emit the authenticated principal into request logs.

---

### [HIGH] Positions are not bound to the caller — accountId is client-supplied

**Evidence:**
- `src/positions.ts:25` — `accountId` for list comes from `queryStringParameters.accountId`.
- `src/positions.ts:63` — `accountId` for get comes from `pathParameters.accountId`.
- `src/positions.ts:122` — `accountId` on create comes from the request body and is written verbatim.

There is no check that the caller is *allowed* to act on the given `accountId`. Combined with the shared-token model above, any holder of the token can write or read any account.

**Risk:** Cross-tenant data access and tampering. A compromised or curious holder of the token can enumerate or overwrite positions for any account.

**TODO:**
- Derive `accountId` from the authenticated principal, not from the request.
- Add a conditional write (`ConditionExpression: "attribute_not_exists(accountId)"` or owner check) when the row already exists.

---

### [MEDIUM] Race condition in stock create — `STCO_NEW_ADDED` can be emitted twice

**Evidence:** `src/stocks.ts:101-114` performs a check-then-write: `getStock` → if missing, `executeStockAction` then `putStock`. There is no `ConditionExpression: "attribute_not_exists(symbol)"` on the `PutCommand` (`src/stocks.ts:190-197`). The batch path has the same shape (`src/stocks.ts:157-194`).

**Risk:** Two concurrent POSTs for the same new symbol both observe "not exists", both publish `STCO_NEW_ADDED`, and the last write wins on the row. The idempotency promise documented in `doc/signals.md` is violated under concurrency — downstream consumers will see duplicate signals.

**TODO:**
- Add `ConditionExpression: "attribute_not_exists(symbol)"` to `putStock`. On `ConditionalCheckFailedException` re-read and return the cached row.
- For `batchCreate`, switch from `BatchWriteCommand` to per-item conditional puts (or accept the dup and dedupe downstream).

---

### [MEDIUM] No request schema validation / size limits

**Evidence:**
- `src/http.ts:43-50` — `parseJsonBody` calls `JSON.parse` with no max-size, max-depth, or schema check.
- `src/stocks.ts:285` accepts `metadata` as `unknown` and stores it verbatim (`src/stocks.ts:22`).
- Ad-hoc validation only: `normalizeStock` (`src/stocks.ts:265-290`) and `normalizePosition` (`src/positions.ts:117-154`).

**Risk:** Adversarial JSON (deeply nested, large strings, prototype-polluting keys though Node's `JSON.parse` is safe against `__proto__`) can inflate DynamoDB item size, exhaust Lambda memory, and cost write capacity. Garbage / oversized `metadata` enters the table and is later returned to every reader.

**TODO:**
- Adopt a schema validator (`zod` or `ajv`) per handler with explicit max-length on strings, max-depth on `metadata`, and a deny-list of reserved keys.
- Cap DynamoDB item size before writing (DynamoDB hard limit is 400KB; fail fast before the round-trip).

---

### [MEDIUM] Read endpoints do unbounded full-table scans

**Evidence:**
- `src/stocks.ts:39-48` — `list` paginates a `ScanCommand` until `LastEvaluatedKey` is undefined.
- `src/positions.ts:29-47` — same pattern; when `accountId` is omitted, falls back to full `ScanCommand`.

**Risk:** Any authenticated caller can force a full table read on every request — read-capacity exhaustion / cost-amplification DoS, and a memory blow-up if tables grow.

**TODO:**
- Require pagination (`limit` + opaque `cursor`) and return at most N items per call.
- Make `accountId` required for `GET /positions` (or scope it to the authenticated principal).

---

### [MEDIUM] No least-privilege IAM — every Lambda is linked to every table

**Evidence:** `sst.config.ts:43-55` — the single `Api` resource is `link`-ed to `stocks`, `positions`, and `events`. SST grants the union of read/write permissions to every route's Lambda execution role. `GET` handlers receive the same DynamoDB write permissions as `POST` handlers.

**Risk:** A bug or compromise in a read-only path (`GET /stocks`) becomes a write capability. Increases blast radius of any future code-execution finding.

**TODO:**
- Move from a single shared API to per-route `link` declarations, or post-deploy IAM policies that scope `dynamodb:GetItem`/`Query`/`Scan` to read handlers and `PutItem`/`BatchWriteItem` to write handlers.

---

### [MEDIUM] Default `API_BEARER_TOKEN ?? ""` is silently insecure

**Evidence:** `sst.config.ts:50` — `API_BEARER_TOKEN: process.env.API_BEARER_TOKEN ?? ""`. If the deploy machine has no env var, the Lambda boots with an empty token. The runtime check at `src/http.ts:31` then rejects all traffic — safe behavior — but the deploy succeeds without any indication that auth is broken.

**Risk:** A silent misconfiguration (forgotten `.env`, CI without the secret) ships a service that 401s every request. Reverse risk: if the runtime check at `src/http.ts:31` is ever loosened to allow empty tokens, the empty default becomes an authentication bypass.

**TODO:**
- Fail the SST build when `API_BEARER_TOKEN` is unset or shorter than a minimum length.
- Move the token to AWS Secrets Manager / SSM Parameter Store with `sst.Secret`; remove the `?? ""` fallback.

---

### [LOW] No security response headers

**Evidence:** `src/http.ts:9-11` — every response sets only `content-type: application/json`. No `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, or `Referrer-Policy`.

**Risk:** Limited for a JSON API behind an HTTPS-only API Gateway endpoint, but missing headers weaken defence-in-depth and trip security scanners.

**TODO:**
- Add `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` to the `json()` helper.

---

### [LOW] No CORS policy declared

**Evidence:** `sst.config.ts:43-55` configures `ApiGatewayV2` with no `cors` block. The HTTP API default is to *not* return CORS headers, so browsers will block cross-origin reads — but this state is implicit, not enforced.

**Risk:** Low while CORS is unconfigured (browsers block by default). A future "make it work from the frontend" change could open it to `*` without anyone noticing.

**TODO:**
- Explicitly set `cors: false` (or an allow-list of origins) in `sst.config.ts` so the intent is in source.

---

### [LOW] No audit log of writes or auth failures

**Evidence:** Only one log statement exists across the handlers: `src/stocks.ts:257` (`console.info("stock action executed", execution)`). No log on `requireBearerToken` failure, no log on positions writes, no log of the caller's source IP / user-agent / request ID.

**Risk:** No forensic trail after an incident — cannot determine who hit the token, when, or what they touched. CloudWatch will have API Gateway access logs only if configured separately, which this repo does not.

**TODO:**
- Log every write with the API Gateway `requestContext.requestId`, source IP, route, and principal.
- Enable API Gateway access logging in `sst.config.ts` (`accessLog: true` or explicit log group).

---

### [LOW] Event stream has no integrity protection

**Evidence:** `src/events.ts:57-75` — events are written with a server-generated `eventId = ${createdAt}#${randomUUID()}` and no signature. Anyone with write access to the `Events` DynamoDB table (not via this API, but via an AWS-side compromise) can insert past-dated events that consumers will read as authentic.

**Risk:** If a downstream system trusts the event stream as ground truth, a DynamoDB-write compromise can forge history.

**TODO:**
- Optional: HMAC each event payload with a per-environment key stored in Secrets Manager; verify on read.

---

### [INFO] DynamoDB tables use AWS-managed encryption only

**Evidence:** `sst.config.ts:12-41` declares three `sst.aws.Dynamo` resources without an `encryption` / `serverSideEncryption` block. SST defaults to AWS-owned KMS keys.

**Risk:** Acceptable for most workloads; insufficient for environments that require customer-managed keys (CMK) for key-rotation auditability or cross-account isolation.

**TODO if required by data classification:**
- Configure a customer-managed KMS key and reference it from each table.

---

### [INFO] No point-in-time recovery (PITR) configured

**Evidence:** `sst.config.ts:12-41` — no `pointInTimeRecovery` / `pitr` option set on any table.

**Risk:** Accidental deletion or corruption cannot be rolled back beyond what's in the row.

**TODO:** Enable PITR on `Stocks`, `Positions`, and `Events`.

---

### [INFO] No dependency vulnerability scanning configured

**Evidence:** No `.github/dependabot.yml`, no `renovate.json`, no `npm audit` step in any script in `package.json:6-12`. No CI config at all in the repository.

**TODO:** Add Dependabot or Renovate, plus an `npm audit --audit-level=high` step in CI.

---

## Not assessable from this repo

These controls cannot be evaluated from the source tree and must be checked against the live AWS environment:

| Area | What to verify out-of-band |
| --- | --- |
| **IAM** | Lambda execution-role policy is the least-privilege intersection of what each route needs (not the SST-generated union). |
| **API Gateway access logs** | Enabled, retained ≥ 90 days, scoped CloudWatch group. |
| **CloudTrail** | Multi-region, log-file validation enabled, S3 bucket locked. |
| **WAF** | Attached to the API Gateway stage (rate-based rule, AWS managed rule sets). |
| **Secrets** | `API_BEARER_TOKEN` lives in Secrets Manager / SSM SecureString, not plain env, and has a documented rotation cadence. |
| **DynamoDB** | PITR on, deletion protection on, contributor-insights only for non-PII tables. |
| **Network** | Lambdas have no VPC egress to the internet unless required; DDB access via VPC endpoint if VPC-attached. |
| **Deployment pipeline** | `sst deploy` runs from a trusted CI, not a developer laptop; required approvals on production stage. |
| **Account hygiene** | Root account MFA, no long-lived IAM users, SCPs deny `dynamodb:DeleteTable` outside of break-glass. |
| **Data classification** | Whether `metadata` / `positions` rows contain regulated PII (KYC, holdings) — drives whether CMK + field-level encryption are needed. |
| **Incident response** | Runbook exists, paging route defined, log retention long enough to support an investigation. |

---

## Suggested next steps (by priority)

1. **Bind requests to a principal.** Replace the shared bearer with per-client credentials and derive `accountId` from the principal (closes the two HIGH findings).
2. **Conditional writes.** Add `attribute_not_exists` to `putStock` to make `STCO_NEW_ADDED` truly idempotent.
3. **Schema validation + size caps.** Wrap `parseJsonBody` with `zod` schemas per route.
4. **Tighten IAM.** Per-route `link` so reads can't write.
5. **Secrets Manager.** Move the bearer out of `.env` / Lambda env vars.
6. **Operational visibility.** Audit logs, API Gateway access logs, dependency scanning, PITR.
