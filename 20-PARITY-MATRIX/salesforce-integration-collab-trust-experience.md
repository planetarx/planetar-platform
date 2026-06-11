# 20 — Parity Matrix · Salesforce: Integration + Collaboration + Trust + Experience

This slice covers the four Salesforce surface-and-edge pillars that sit *around* the data model rather than inside it: **Integration** (MuleSoft, Connect/External Services, Platform Events, CDC, Pub/Sub API, external objects), **Collaboration** (Chatter, Slack, Quip, feeds, notifications, @mentions), **Trust** (Shield Event Monitoring, Field Audit Trail, Platform Encryption, Identity/SSO/MFA, OWD/role-hierarchy/FLS sharing, Health Check), and **Experience** (Experience Cloud sites, Lightning App/Page Builder, CMS, mobile/PWA, accessibility/i18n).

**Headline parity story.** Three of these four pillars decompose almost entirely onto roles the spine *already owns* rather than novel storage:

- **Integration** is the spine's home turf — Salesforce Platform Events / CDC / Pub-Sub API is *exactly* the planetar bus (**R3**, `planetar-broker` + `zmesg` envelope) with a 200+ connector edge supplied by OSS (**Airbyte**) behind the P2 detector SDK. Every external system becomes an envelope; every envelope is a platform event.
- **Collaboration** is *built and live*: doibio's `comms-app`/feed and planetar-ui's per-MMSI chat channels are Chatter/Slack-style feeds driven straight off **R3** with presence pinned via **R2** — the only collaboration moat Salesforce has (object-anchored feeds + notifications) falls out of "every state change is an envelope."
- **Trust** is the one pillar that is mostly *designed, not built*: audit (**R11**) and per-field provenance (**R12**) exist and are live, but propagating markings, FLS/row-level sharing, and at-rest encryption are governance-plane (**P1**) designs gated on the OPA/Keycloak (**R13**) adapters — this is the roadmap's named "propagating security" debt.
- **Experience** is partially built (the planetar-ui 4-pane shell + doibio's ~20 React micro-frontends serve the App-Builder / Experience-Cloud role) but the *config-driven page builder* and external-community + CMS surfaces are designed-only.

Spine code throughout depends only on the role **adapter interfaces** in [`12-ADAPTER-CONTRACT.md`](../12-ADAPTER-CONTRACT.md); OSS engines are named concretely so each row is actionable. Roles use the R1..R14 IDs from [`10-STORAGE-ROLES.md`](../10-STORAGE-ROLES.md); planes use P0..P8 from [`00-ARCHITECTURE-OVERVIEW.md`](../00-ARCHITECTURE-OVERVIEW.md).

---

## Integration

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Platform Events (publish/subscribe bus) | App-defined event objects published to a durable bus with replay | P3 | **R3** | **Spine** — maps directly onto broker streaming; `zmesg` envelope = the event payload, topic = the event channel | **built** — `~/github/planetarx/planetar-broker` (SHM/TCP/UDP+WAL); port `Stream` in [`12 §3`](../12-ADAPTER-CONTRACT.md) |
| Change Data Capture (CDC) | Stream every row-level create/update/delete/undelete as an event | P3,P7 | **R3**, **R1**, *R11* | **Spine** — every kinetic write (P7) already emits a change envelope on R3; CDC = subscribing to the canonical-store projection topic | **built** — Action effects emit envelopes; `~/github/planetarx/planetar-ontology` `src/actions/executor.ts` + broker |
| Pub/Sub API (gRPC streaming) | Bidirectional streaming publish/subscribe with managed offsets | P3,P8 | **R3**, *R2* | **Spine** broker + Object-API WS bridge; offsets = broker WAL offsets. Alt OSS bus: **kafka/redpanda** behind the same `Stream` port | **partial** — broker TCP/WS path built; gRPC façade designed (`~/github/planetarx/planetar-ontology` `src/api/ws.ts` is the WS analog) |
| MuleSoft / Anypoint connectors (200+) | Pre-built connectors to SaaS/DB/file sources, normalized to events | P2 | **R3**, *R6* (raw landing) | **OSS: Airbyte** (or Singer taps / Meltano) behind the P2 detector SDK → emits `zmesg` envelopes | **designed** — detector SDK pattern proven by `planetar-ais/sat/eo/acoustic`; Airbyte breadth deferred (CLAUDE GAP: connectors-at-breadth) |
| Custom detectors / native ingest | Domain source → normalized envelope (the planetar lane pattern) | P2,P3 | **R3** | **Spine** detector framework + envelope emit SDK | **built** — `~/github/planetarx/planetar-ais`, `planetar-sat`, `planetar-eo`, `planetar-acoustic` (RF lane registered, no service) |
| External Services / Connect (OpenAPI invoke) | Register an OpenAPI/REST schema and invoke it as a typed action | P7 | **R10**, **R1**, **R11**, *R14* | **Spine** — an external call is a kinetic Action Type whose effect is an outbound request; registry holds the OpenAPI schema | **designed** — Action Type executor built (`planetar-ontology` `src/actions/executor.ts`); OpenAPI-import codegen designed |
| External Objects / OData (zero-copy federation) | Query an external system live, no data copied in | P4,P9 | **R9** (federated engine), **R10** | **OSS: clickhouse / duckdb** federated query, or **bigquery/snowflake** query-in-place behind R9 adapter | **designed** — Data-Cloud-style virtual-tables pattern; no federated adapter wired yet |
| Outbound Messages / Webhooks | Fire an HTTP callout on a record/event condition | P7 | **R3**, **R14**, *R13* | **Spine** — webhook is an Action triggered off an R3 subscription; R14 holds the retry queue | **built** — doibio `~/data/dev/doibio/src/lib/webhooks.ts` (its only automation primitive) |
| Streaming API / PushTopic (legacy query-stream) | Subscribe to a SOQL-defined result set as it changes | P3,P6 | **R3**, **R4** | **Spine** Object API WS over an object-index query subscription (R4); broker fan-out for delivery | **partial** — Object-API WS subscribe built (`planetar-ontology` `src/api/ws.ts`); query-defined topic filter designed |
| Bulk / Batch data API | High-throughput async insert/update/upsert of large datasets | P2,P7 | **R3**, **R1**, **R14** | **Spine** — bulk load = batched envelopes on R3 with a R14 job tracking the run; CSV ingest reuses import path | **partial** — doibio CSV import `~/data/dev/doibio/src/lib/import-export.ts`; async-job orchestration via R14 designed |
| API Gateway / rate-limiting / API versioning | Throttle, authenticate, and version the public API surface | P0,P8 | **R2** (counters), **R13**, **R10** | **OSS: Kong / Envoy** (or Keycloak token gate) in front of the Object API; R2 redis for rate-limit counters | **designed** — Object API is versioned (registry-driven); gateway/throttle not deployed |
| Composite / Graph API (batched mutations) | One request performs many related reads/writes transactionally | P6,P7 | **R1**, **R6** | **Spine** — Object API batch endpoint; multi-row atomicity via the `CanonicalStore.transaction()` port | **partial** — `CanonicalStore.transaction` in adapter contract; batch endpoint surface designed |

---

## Collaboration

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Chatter feed (record + user feeds) | Activity/comment feed anchored to an object or a user | P8,P3 | **R3**, **R1**, *R4* | **Spine** — a feed is a topic on R3 filtered by object id; posts are envelopes; doibio comms-app is the donor | **built** — `~/data/dev/doibio/comms-app` + per-MMSI chat channels in `~/github/planetarx/planetar-ui` |
| @mentions + notifications | Mention a user/group; push a notification to their inbox | P8,P7 | **R3**, **R2**, **R14** | **Spine** — mention = an Action that enqueues (R14) a notification envelope; R2 holds unread badges | **partial** — feed/post built (doibio comms-app); structured notification inbox designed |
| Presence ("who's online" / live channels) | Show active users / live data channels in real time | P8 | **R2**, **R3** | **Spine** — presence pinned in R2 hot-cache; live-channel control-plane state atop the feed (per the MEMORY live-channel pin) | **built** — `~/github/planetarx/planetar-ui` live-channel pins (AIS/SAR/EO/acoustic) |
| Slack integration / Slack-style shell | Channels, threads, app surfaces in a Slack/Quip-style UI | P8 | **R3**, **R1**, *R2* | **Spine** — planetar-ui is a Slack/Discord/Quip-style 4-pane shell over the bus; no external Slack needed | **built** — `~/github/planetarx/planetar-ui` 4-pane shell (channels pane) |
| Quip-style collaborative docs | Real-time co-edited documents/spreadsheets | P8,P4 | **R6**, **R1**, *R3* (CRDT ops) | **OSS: Yjs / Automerge** (CRDT) over the WS bridge; R6 minio for doc blobs | **designed** — doc blob handle pattern from `ARCH-planetar-photos.md`; CRDT co-edit not built |
| Topics / hashtags / feed tracking | Tag posts, follow topics, track field changes into the feed | P6,P3 | **R4**, **R3**, **R1** | **Spine** — topics are ontology link types; feed-tracked-changes are CDC envelopes (R3) indexed in R4 | **partial** — doibio topic-summarizer `~/data/dev/doibio/src/services/topic-summarizer.ts`; field-tracking config designed |
| Files / content sharing in feed | Attach and share files inline in a feed with versioning | P8,P6 | **R6**, **R1**, *R7* | **Spine** blob handle in envelope; **OSS: minio/s3** (R6); R7 pgvector for similar-file suggest | **designed** — blob-cas handle contract (`BlobCas` port, [`12 §3`](../12-ADAPTER-CONTRACT.md)); media set not wired for feed |
| Groups / spaces (membership) | Private/public groups with member rosters governing feed visibility | P1,P6 | **R13**, **R1**, **R5** | **Spine** group = ontology entity; membership = R5 links; visibility = R13 policy. **OSS: Keycloak** groups | **designed** — group entity modelable; membership-gated visibility gated on R13 adapter |
| AI feed summarization / chat assistant | Summarize a thread / answer over feed history | P8,P7 | **R7**, **R3**, **R10** | **Spine** kinetic containment + **OSS: vector (pgvector) + LLM gateway**; doibio uses **Cohere** | **partial** — doibio Cohere chat `~/data/dev/doibio/src/lib/ai-handler.ts` + `topic-summarizer.ts`; RAG grounding designed |
| Activity timeline / audit-as-feed | Chronological record of all actions on an object | P8,P1 | **R11**, **R1**, *R8* | **Spine** — the activity timeline *is* the audit log (R11) rendered as a feed; R8 for time-bucketed view | **partial** — audit envelope built (doibio `src/lib/event-log.ts`); Timeline tab in planetar-ui is a stub |

---

## Trust

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Shield Event Monitoring | Capture every read/click/login/API/export event for SIEM | P1 | **R11** | **Spine** audit envelope on R3 → R11 sink; **OSS: clickhouse** for queryable scale / **kafka** to ship to SIEM | **partial** — immutable event log built (doibio `~/data/dev/doibio/src/lib/event-log.ts`); read/export-event capture designed |
| Field Audit Trail (history retention) | Long-retention, per-field old/new value history | P1 | **R11**, **R12**, **R1** | **Spine** — per-field provenance (R12) + audit (R11); history is the R3 event log replayed | **partial** — per-field `_provenance` built in `~/github/planetarx/planetar-ontology` `src/resolve/resolve.ts`; retention policy designed |
| Setup Audit Trail (admin/config changes) | Record every metadata/config change with actor + timestamp | P1,P0 | **R11**, **R10** | **Spine** — registry (R10) writes are governed Actions → audit envelopes (R11) | **partial** — registry codegen built (`~/github/planetarx/planetar-registry` slice); change-audit wiring designed |
| Platform Encryption (encryption at rest) | Encrypt selected fields/blobs at rest with key management | P1,P4 | **R1**, **R6**, **R13** | **OSS: engine-native TDE** (postgres pgcrypto / minio SSE) + **Vault** for keys, behind the adapter as a PEP | **designed** — adapters are Policy Enforcement Points ([`12 §1`](../12-ADAPTER-CONTRACT.md)); field-level crypto not implemented (CLAUDE GAP) |
| Identity / SSO / SCIM provisioning | Federated login, SAML/OIDC SSO, automated user provisioning | P1 | **R13** | **OSS: Keycloak** (identity/SSO/SCIM) behind the policy-identity port | **designed** — R13 = `keycloak + OPA`; edge uses `internal` principals; Keycloak not deployed |
| Multi-Factor Authentication (MFA) | Require a second factor on login / sensitive actions | P1 | **R13**, *R2* | **OSS: Keycloak** MFA flows; R2 for challenge/session state | **designed** — gated on Keycloak adapter (R13) |
| OWD / role hierarchy / sharing rules | Org-wide defaults + hierarchy + rule-based row-level sharing | P1 | **R13**, **R1**, *R5* | **OSS: OPA** policy bundle evaluates sharing; R5 graph for hierarchy traversal; **Spine** propagation rules | **designed** — row-level sharing not implemented (doibio has none); needs R13 OPA + propagating-security work |
| Field-Level Security (FLS) | Per-profile visibility/editability of individual fields | P1,P6 | **R13**, **R10** | **OSS: OPA** decision keyed by field id from registry (R10); **Spine** PEP in the Object API read path | **designed** — no FLS today (CLAUDE GAP: FLS/row-level sharing designed-only) |
| Markings / classification + propagating security | A marking set at ingest flows to every derived store/object/surface | P1 | **R12**, **R13**, **R11** | **Spine** propagation rules over lineage (R12); **OSS: OPA** (decisions) + **Marquez** (lineage store) | **designed** — the roadmap's named "next" piece; lineage edges exist, propagation engine not built |
| Lineage / provenance graph | source → observation → object → derivation edges; impact analysis | P1 | **R12**, **R10** | **Spine** lineage emit; **OSS: Marquez** (OpenLineage, postgres-backed) behind R12, or reuse R5 graph | **partial** — per-field provenance built (`planetar-ontology` resolve); Marquez sink designed |
| Health Check / Security posture score | Score org config against a security baseline | P0,P1 | **R10**, **R13** | **Spine** — evaluate registry/manifest (R10) + policy (R13) against a baseline ruleset | **designed** — manifest compiler validates contracts ([`13 §2`](../13-CLIENT-MANIFEST.md)); security-baseline scoring not built |
| Purpose-based access / data masking | Gate access by declared purpose; mask sensitive fields by context | P1,P6 | **R13**, **R12**, **R11** | **Spine** kinetic gate checks purpose (per lifecycle 4.2); **OSS: OPA** decision + masking transform | **designed** — kinetic governance gate designed (`00 §4.2`); purpose model not implemented |
| Tamper-evident / immutable audit store | Audit records cannot be altered or deleted | P1 | **R11** | **Spine** append-WAL with CRC32 (broker-style) — "never rebuilt, it is evidence" (R11 contract) | **built** — broker WAL+CRC32 `~/github/planetarx/planetar-broker`; doibio immutable event-log |

---

## Experience

| Feature | What it does (1 line) | Owning plane(s) | Required roles (bold) + enhancing (italic) | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Lightning App Builder (config-driven pages) | Assemble pages from components without code | P8,P0 | **R10**, **R1** | **Spine** — page layout is a registered config (R10) the shell renders; ontology drives component data | **designed** — registry holds defs; the planetar-ui shell is hand-built, not yet config-assembled |
| Lightning components / micro-frontends | Reusable UI building blocks bound to objects | P8 | **R1**, **R10**, *R4* | **Spine** — React components over the Object API; doibio's ~20 micro-frontends are the donor pattern | **built/partial** — `~/data/dev/doibio` ~20 React apps; `~/github/planetarx/planetar-ui` 4-pane shell (Signal/Imagery/Timeline tabs stubbed) |
| Experience Cloud sites (external portals) | Public/partner/customer-facing branded sites over the same data | P8,P1 | **R1**, **R13**, *R4*, *R6* | **Spine** Object API + **OSS: Keycloak** (external identity) + **minio** (R6 assets); shell reskin | **designed** — Object API is the data tier; external-auth + portal theming not built |
| CMS / managed content | Author, version, and publish reusable content | P8,P6 | **R6**, **R1**, **R10** | **OSS: minio/s3** (R6) for content blobs; **Spine** content type in ontology; versioning via R3 | **designed** — blob-cas (`BlobCas` port) + content type modelable; authoring UI not built |
| Map / geospatial surface (SF Maps) | Plot records on an interactive map; geofence; routing | P8 | **R8**, **R1**, *R5* | **Spine** track model + **OSS: maplibre** + **postgis** (R8) behind the timeseries-geo port | **built** — maplibre map in `~/github/planetarx/planetar-ui`; R8 postgis per maritime manifest |
| Dashboards / report surfaces | Charts and KPIs assembled over analytics | P8 | **R9**, **R1**, *R8* | **OSS: Superset / Grafana** over **clickhouse/duckdb** (R9) behind the analytics port | **designed** — R9 analytics adapter; planetar-ui has no dashboard tab yet |
| Link-chart / graph explorer surface | Interactive entity-link analysis canvas | P8,P6 | **R5**, **R1**, *R4* | **Spine** ontology link types + **OSS: falkordb** (R5); UI graph tab renders the subgraph | **built/partial** — graph tab in `~/github/planetarx/planetar-ui` (built/partial per inventory); R5 engine swappable |
| Mobile / PWA / offline | Responsive + installable + offline-capable client | P8 | **R1**, **R2**, *R3* | **Spine** — React PWA over Object API; R2 for offline cache, R3 replay on reconnect | **designed** — shell is React/Vite (PWA-able); offline sync not implemented |
| Accessibility + i18n / localization | WCAG-conformant, multi-language, multi-locale UI | P8 | **R10** | **Spine/UI** — locale bundles + a11y in the React shell; registry (R10) holds label/translation defs | **designed** — not audited/built; tracked as a shell concern |
| In-app guidance / onboarding (prompts) | Walkthroughs, prompts, and in-context help overlays | P8 | **R10**, **R2** | **Spine/UI** — guidance config in registry (R10); per-user dismissal state in R2 | **planned** — no guidance layer exists |
| Notifications surface (bell / push) | Unified notification center across web/mobile | P8,P7 | **R14**, **R3**, **R2** | **Spine** — notifications enqueued on R14, delivered via R3 WS, unread state in R2 | **partial** — feed delivery built (doibio comms); unified notification center designed |
| Theming / branding (per-client look) | Per-org/site branding, themes, white-label | P0,P8 | **R10** | **Spine** — theme tokens are manifest/registry (R10) config the shell reads at boot | **designed** — per-client manifest exists ([`13`](../13-CLIENT-MANIFEST.md)); theme-token binding not built |

---

## Coverage summary

Counts by status across all 45 features in this slice:

| Status | Count | Notes |
|---|---|---|
| **built** | 7 | Platform Events, CDC, custom detectors, webhooks, Chatter feed, presence/live-channels, Slack-style shell, map surface, tamper-evident audit — all backed by `planetar-broker`, `planetar-ontology`, `planetar-ui`, or `doibio`. (Two rows marked **built/partial** counted under partial below.) |
| **partial** | 13 | Real backing exists but the Salesforce-equivalent surface is incomplete (e.g. Pub/Sub gRPC façade, @mentions inbox, AI summarization RAG, Shield/Field/Setup audit capture, lineage Marquez sink, Lightning micro-frontends, graph explorer, notification center). |
| **designed** | 24 | Spec/architecture exists, no implementation — dominated by the **Trust** pillar (encryption, SSO/MFA, OWD/FLS/sharing, propagating security, purpose-based access) and config-driven **Experience** (App Builder, Experience Cloud, CMS, theming, dashboards). |
| **planned** | 1 | In-app guidance / onboarding — no design yet. |

**Pillar shape:** Integration and Collaboration are mostly built/partial (the bus and feeds are the spine's strengths); Trust and config-driven Experience are mostly designed (the governance plane and the page-builder are the largest remaining work).

---

## Notable gaps

- **Propagating security is the headline debt.** Markings + propagation, OWD/role-hierarchy/row-level sharing, and FLS are all *designed-only* and gated on the **R13** (Keycloak + OPA) and **R12** (Marquez lineage) adapters. doibio has **no** FLS or row-level sharing today; the propagation engine over lineage edges is the roadmap's named "next" piece.
- **No declarative flow/automation engine.** Salesforce Flow has no equivalent — doibio's *only* automation primitive is webhooks (`src/lib/webhooks.ts`). Outbound Messages, @mention notifications, and external-service callouts all currently lean on that one primitive; long-running orchestration needs the **R14** (Temporal) binding wired.
- **Encryption at rest is unimplemented.** Platform Encryption is designed as an adapter-level PEP (engine-native TDE + Vault keys) but no field/blob crypto exists, and multi-tenancy hardening is an open CLAUDE GAP.
- **Connectors-at-breadth deferred.** MuleSoft parity depends on **Airbyte** behind the P2 detector SDK; only the four native planetar detectors are built, and the Airbyte breadth is explicitly deferred. RF lane is registered but has no service.
- **Config-driven UI is hand-built, not assembled.** Lightning App Builder / Experience Cloud / CMS / per-client theming all require a registry-driven page-assembly layer; today the planetar-ui shell is hand-coded and its Signal/Imagery/Timeline tabs are stubs.
- **Pub/Sub API gRPC + zero-copy federation (External Objects)** both have the right spine seam (broker WS, R9 federated adapter) but no concrete façade/adapter is wired — actionable next-OSS picks are a gRPC bridge and a clickhouse/duckdb federated R9 adapter.
- **Apollo-class deploy and AIP agent studio** are out of scope here but bound several Experience/Integration surfaces (in-app guidance, agent-driven collaboration) and remain deferred.
</content>
</invoke>
