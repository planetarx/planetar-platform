# 20 — Parity Matrix · Salesforce Marketing + Commerce / Industry

This slice maps **Salesforce Marketing Cloud (Engagement, Account Engagement/Pardot, Personalization/Interaction Studio, Intelligence/Datorama), Commerce Cloud (B2C + B2B + Order Management/OMS), and the Industry Clouds (OmniStudio, FlexCards/OmniScript, Data Processing Engine, Health/Financial-Services data models)** onto the Planetar plane + storage-role model.

**Headline parity story.** Marketing, Commerce, and Industry are not new *kinds* of system — in Planetar terms they are **richly-typed object/link/action graphs (P6 ontology) with a few specialty roles bolted on**: campaigns/journeys are long-running **work-queue (R14)** orchestrations triggered by **kinetic Action Types (P7)**; segmentation, send-time, and recommendations are **analytics-olap (R9)** + **vector (R7)** queries over the canonical store; the storefront catalog, cart, and order are ordinary **canonical objects (R1)** indexed for browse via **object-index (R4)**; behavioral signals (clicks, page views, opens, add-to-cart) are high-volume **timeseries-geo (R8)** / **stream (R3)** events. The spine already owns the hard middle — semantic objects, identity resolution, kinetic writes, audit — so most of this slice is **declarative configuration over the existing ontology plus one specialty role**, with OSS filling segmentation analytics, search-driven merchandising, and the orchestration engine. The honest gap: Salesforce's *declarative* journey/flow builders and personalization decisioning are **designed-not-built** here — doibio proves the object/audit/import substrate and a webhook automation, but there is no visual journey canvas or real-time decision engine yet.

Roles use the canonical IDs from [`10-STORAGE-ROLES.md`](../10-STORAGE-ROLES.md); planes from [`00-ARCHITECTURE-OVERVIEW.md`](../00-ARCHITECTURE-OVERVIEW.md). **Required** roles are **bold**, *enhancing* roles are *italic*. Status convention: built | partial | designed | planned.

---

## Marketing Cloud — Engagement (email / SMS / push / channels)

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Subscriber / contact data model | Stores contacts, leads, subscriber keys, consent state as objects | P4,P6 | **R1**, **R10**, *R4* | Spine: canonical model + ontology Object Types; OSS: postgres (R1) | partial — `~/data/dev/doibio` 271 JSON schemas inc. contact/party objects; ontology Object Types at `~/github/planetarx/planetar-ontology/src/store` |
| Data Extensions (custom send tables) | Arbitrary typed tables joined to sends/segments | P4,P6 | **R1**, **R10**, *R9* | Spine: registry codegen → canonical objects; OSS: postgres | partial — registry codegen slice `~/github/planetarx/planetar-registry`; doibio custom-object pattern |
| Email Studio (template + dynamic content) | Compose templated, personalized email creative | P6,P8 | **R1**, **R10**, *R6* (image assets) | Spine: ontology + template field-binding; OSS: minio (R6) for assets | designed — doibio has gmail send (`~/data/dev/doibio/src/lib/gmail.ts`) but no template/AMPscript engine |
| AMPscript / dynamic personalization | Per-recipient content substitution at send time | P7,P6 | **R1**, **R10**, *R7* | Spine: Action-Type-driven render step; OSS: pgvector for affinity | designed — no expression/personalization engine built |
| MobileConnect / SMS + MobilePush | Multi-channel message delivery | P2,P7 | **R14**, **R3**, **R1**, *R2* | Spine: send as Action Type → R14 job; OSS: provider gateway (Twilio adapter) behind detector SDK | planned — no SMS/push provider integration |
| Journey Builder (visual journeys) | Multi-step, time-/event-triggered customer journeys | P7 | **R14**, **R1**, **R3**, *R13* | Spine: journey steps compile to Action Types; **OSS: Temporal** (long-running orchestration, R14) | designed — no declarative journey canvas; doibio has webhook automation only (`src/lib/webhooks.ts`), NO flow engine |
| Automation Studio (scheduled/file-drop) | Batch ETL + scheduled send automations | P2,P7 | **R14**, **R3**, *R9* | Spine: scheduled Action Types; OSS: Temporal/Airbyte for file-drop ingest | designed — webhooks are the only automation in doibio |
| Behavioral event capture (opens/clicks) | Track engagement events per subscriber | P2,P3 | **R3**, **R8**, *R9* | Spine: envelope emit + broker; OSS: timescaledb (R8) | partial — broker streaming built (`~/github/planetarx/planetar-broker`); event capture not wired for email |
| Engagement scoring / Einstein STO | Send-time optimization, open/click propensity | P5,P9 | **R9**, **R1**, *R7* | OSS: clickhouse (R9) + model; spine: scores as object fields | planned |
| Consent / preference center (CAN-SPAM) | Opt-in/out, channel preferences, suppression | P1,P6 | **R1**, **R13**, **R11** | Spine: consent as marked Action Types + audit; OSS: OPA (R13) gate | designed — audit substrate exists (doibio immutable event log); consent policy not modeled |
| Send-log audit / deliverability | Immutable record of every send + bounce | P1 | **R11**, *R9* | Spine: audit envelope; OSS: clickhouse sink | partial — immutable event-log audit in doibio; not specialized for sends |

---

## Marketing Cloud — Account Engagement (Pardot, B2B)

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Prospect / lead database | B2B prospect objects with activity history | P4,P6 | **R1**, **R10**, *R4* | Spine: ontology objects; OSS: postgres | partial — doibio leads-app + contact schemas (`~/data/dev/doibio/contact-app`) |
| Engagement Studio (drip programs) | Branching nurture campaigns over rules | P7 | **R14**, **R1**, **R3** | Spine: rules as Action Types; **OSS: Temporal** | designed — no visual program builder |
| Lead scoring & grading | Rule/ML scoring of prospect fit + activity | P5,P9 | **R1**, **R9**, *R7* | Spine: scores as resolved fields; OSS: clickhouse + model | planned |
| Form / landing page handlers | Capture web form submissions → prospects | P2 | **R3**, **R1**, *R4* | Spine: form post → envelope → Action Type; OSS: postgres | designed — doibio has REST ingest routes (~120) but no form-builder |
| Connected campaigns / attribution | Tie touches to campaigns + revenue attribution | P9,P6 | **R9**, **R1**, *R5* | OSS: clickhouse (multi-touch attribution); spine: campaign link types | planned |
| Marketing/sales sync (lead lifecycle) | Bidirectional sync of leads/contacts to CRM | P5 | **R1**, **R4**, **R12**, *R3* | **Spine: identity resolution** (the moat); OSS: opensearch blocking | partial — `identity-resolution.ts` 631 LOC ported into ontology resolver |

---

## Marketing Cloud — Personalization (Interaction Studio) + Intelligence (Datorama)

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Real-time web/app personalization | Decide content per visitor session in-flight | P7,P8 | **R2**, **R7**, **R1**, *R8* | Spine: decision as Action Type; OSS: redis (R2 session) + pgvector (R7 affinity) | designed — no real-time decision engine; kinetic containment is the design hook |
| Affinity / next-best-action recs | Recommend products/content by affinity | P9,P5 | **R7**, **R1**, *R9* | OSS: pgvector/qdrant (R7) KNN; spine: rec as Action Type | designed — vector role specified, no rec model wired |
| Identity stitching (cross-device) | Merge anonymous + known visitor identities | P5 | **R1**, **R4**, **R12**, *R7* | **Spine: identity resolution + per-field provenance** | partial — ontology resolver + provenance built; cross-device blocking not tuned |
| Marketing data lake / harmonization | Unify ad, web, CRM, cost feeds into one model | P2,P4 | **R9**, **R1**, *R3* | OSS: clickhouse/duckdb (R9) + **Airbyte** connectors; spine: canonical model | designed — canonical model designed; marketing connectors deferred |
| Cross-channel dashboards (Datorama) | Spend/ROI dashboards over harmonized data | P8,P9 | **R9**, **R1** | OSS: clickhouse (R9) + Superset/Grafana surface | partial — doibio analytics-app (`~/data/dev/doibio/analytics-app`); canned SQL only, no report builder |
| Calculated insights / KPIs | Materialized cross-object metrics | P9 | **R9**, **R1**, *R8* | OSS: clickhouse continuous aggregates; spine: metric defs in registry | designed |

---

## Commerce Cloud — Storefront (B2C / B2B)

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Product catalog / PIM | Products, variants, attributes, taxonomy | P4,P6 | **R1**, **R10**, *R4* | Spine: ontology Object/Link Types; OSS: postgres | partial — ontology object/link types built; no commerce-specific PIM schema |
| Categories / merchandising hierarchy | Browse taxonomy + category assignment | P6,P5 | **R1**, **R5**, *R4* | Spine: link types (R5 graph); OSS: falkordb | designed — ontology link types support hierarchy; not modeled for catalog |
| Storefront search & faceting | Full-text + faceted product browse | P6,P8 | **R4**, **R1**, *R7* | **OSS: opensearch** (R4 facets) + pgvector (R7 semantic); spine: Object API | partial — ontology Object API (REST+WS) built; opensearch facets not bound, doibio uses Elasticsearch (`src/lib/elasticsearch.ts`) |
| Product recommendations (Einstein) | "Customers also bought" / personalized recs | P9,P5 | **R7**, **R1**, *R9* | OSS: pgvector/qdrant KNN; spine: rec as Action Type | designed |
| Media / digital assets (images, video) | Content-addressed product imagery | P6 | **R6**, **R1**, *R7* | Spine: blob handle in envelope; **OSS: minio/s3** (R6) | designed — blob-cas role + `{sha256,size,mime}` envelope handle specified (ARCH-planetar-photos.md) |
| Pricing / promotions engine | Price books, promo rules, qualifiers | P7,P6 | **R1**, **R10**, *R9* | Spine: pricing rules as Action Types; OSS: postgres | designed |
| Cart & checkout | Build cart, apply promos, place order | P7 | **R1**, **R3**, **R2**, *R14* | Spine: cart ops as kinetic Action Types; OSS: redis (R2 session) | designed — Action Type executor built (`~/github/planetarx/planetar-ontology/src/actions/executor.ts`); no cart object |
| Customer accounts / profiles | Shopper accounts, addresses, order history | P4,P6 | **R1**, **R10**, *R4* | Spine: canonical party objects; OSS: postgres | partial — doibio party-app (`~/data/dev/doibio/party-app`) + contact schemas |
| Content / page management (CMS) | Slot-based content + experiences | P6,P8 | **R1**, **R6**, *R4* | Spine: content objects; OSS: minio (assets) + postgres | designed — doibio blog-app/docs-app are the pattern donor, not a slot CMS |

---

## Commerce Cloud — Order Management (OMS) + B2B

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Order lifecycle / fulfillment | Order capture → allocate → ship → invoice state machine | P7 | **R1**, **R3**, **R14**, **R11** | Spine: each transition an Action Type (audited); **OSS: Temporal** (R14 saga) | designed — kinetic executor + audit substrate built; saga orchestration not built |
| Inventory availability (ATP) | Real-time available-to-promise across locations | P4 | **R1**, **R2**, *R8* | Spine: inventory objects; OSS: redis (R2 hot counts) | designed |
| Payment / capture / refund | Authorize, capture, refund as discrete actions | P7,P1 | **R1**, **R3**, **R11**, *R13* | Spine: payment Action Types + audit; OSS: gateway adapter | planned — no payment provider integration |
| Returns / RMA | Reverse-logistics workflow | P7 | **R14**, **R1**, **R3** | Spine: RMA Action Types; OSS: Temporal | designed |
| B2B accounts / contracts / quotes | Account hierarchies, contracted pricing, quotes | P6,P4 | **R1**, **R5**, *R9* | Spine: account link graph (R5); OSS: falkordb | partial — ontology link types + account graph pattern; no quote object |
| Buyer reordering / order lists | Saved lists, quick reorder for B2B | P6,P8 | **R1**, **R4**, *R2* | Spine: ontology Object API list views; OSS: opensearch | designed |
| Headless commerce APIs (SCAPI) | REST/GraphQL access to catalog/cart/order | P6,P8 | **R1**, **R4** | **Spine: ontology Object API (OSDK-equivalent, REST+WS)** | partial — Object API built (`~/github/planetarx/planetar-ontology/src/api/server.ts`); not modeled for commerce nouns |

---

## Industry Clouds — OmniStudio + data models

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| OmniScript (guided flows) | Declarative multi-step guided UI processes | P7,P8 | **R14**, **R1**, **R3** | Spine: steps → Action Types; **OSS: Temporal** for long-running; surface in planetar-ui | designed — no declarative script builder; planetar-ui shell partial |
| FlexCards (config-driven UI cards) | Data-bound, action-wired display cards | P8,P6 | **R1**, **R4**, *R2* | **Spine: ontology Object API** feeds cards; surface: planetar-ui panes | partial — Object API + planetar-ui 4-pane shell built/partial (`~/github/planetarx/planetar-ui`) |
| DataRaptor (extract/transform/load map) | Declarative read/transform/write to objects | P4,P7 | **R1**, **R10**, *R3* | Spine: registry-driven field maps over canonical store; OSS: postgres | designed — canonical model + registry exist; no declarative mapper UI |
| Integration Procedures (server actions) | Server-side composite read+write orchestration | P7 | **R1**, **R3**, **R11**, *R14* | Spine: composite Action Types (audited); OSS: Temporal | partial — Action Type executor built; composite orchestration not built |
| Data Processing Engine / batch calc | Declarative bulk calc + rollup over datasets | P9 | **R9**, **R1**, *R14* | OSS: clickhouse/duckdb (R9) batch; spine: calc defs in registry | designed |
| Industry data models (Health/FSC/etc.) | Prebuilt domain object/link schemas | P4,P6 | **R1**, **R10**, *R5* | Spine: registry-shipped schema packs; OSS: postgres | partial — registry codegen ships schema packs; doibio proves 271-schema scale (`~/data/dev/doibio`) |
| Business Rules Engine | Declarative eligibility/decisioning rules | P7 | **R1**, **R10**, *R13* | Spine: rules as preconditioned Action Types; OSS: OPA (R13) | designed — kinetic precondition model is the hook; no rules UI |
| OmniAnalytics / industry dashboards | Domain-specific reports & KPIs | P8,P9 | **R9**, **R1** | OSS: clickhouse + Superset; spine: metric registry | partial — doibio analytics-app, canned SQL only |

---

## Cross-cutting (shared by Marketing, Commerce, Industry)

| Feature | What it does (1 line) | Owning plane(s) | Required (bold) + enhancing (italic) roles | Spine vs OSS component | Status + backing path |
|---|---|---|---|---|---|
| Audience / customer 360 unification | Single resolved customer across channels | P5 | **R1**, **R4**, **R12**, *R7* | **Spine: identity resolution + per-field provenance** (the moat) | partial — ontology resolver + provenance built (ported `identity-resolution.ts` 631 LOC) |
| Segmentation / audience builder | Filter customers into reusable segments | P9,P6 | **R9**, **R1**, *R4* | OSS: clickhouse (R9 filter scan); spine: segment as object set | partial — doibio queries/metrics (`src/lib/queries.ts`); no visual segment builder |
| Bulk import / export (CSV) | Load/extract contacts, products, orders | P2 | **R1**, **R3**, *R6* | Spine: import → envelopes → Action Types; OSS: postgres | built — doibio CSV import/export (`~/data/dev/doibio/src/lib/import-export.ts`) |
| Webhooks / outbound integration | Push events to external systems | P2,P7 | **R3**, **R14**, *R11* | Spine: webhook dispatch as Action Type; OSS: postgres queue | built — doibio webhooks (`~/data/dev/doibio/src/lib/webhooks.ts`), the only automation |
| AI chat / assistant grounding | NL Q&A grounded on customer/catalog data | P7,P8 | **R7**, **R6**, **R10**, *R5* | Spine: kinetic containment for writes; OSS: pgvector (R7) + LLM gateway | partial — doibio Cohere AI chat (`src/services/cohere.ts`); not kinetically contained |
| Full-text search across records | Search contacts/products/orders/content | P6,P8 | **R4**, **R1**, *R7* | **OSS: opensearch** (R4); doibio uses Elasticsearch; spine: Object API | partial — doibio Elasticsearch (`src/lib/elasticsearch.ts`); opensearch is the platform default |
| Consent / privacy / right-to-erasure | GDPR/CCPA subject requests + audit | P1 | **R11**, **R13**, **R12** | Spine: erasure Action Type + lineage-driven cascade; OSS: OPA, marquez | designed — audit + lineage substrate exist; erasure cascade not built |
| Engagement timeseries / activity stream | High-volume per-customer activity history | P3,P8 | **R8**, **R3**, *R4* | Spine: broker stream + track model; OSS: timescaledb (R8) | partial — broker built; activity stream not modeled for CRM |
| Reports & dashboards (CRMA-class) | Self-serve reporting over marketing/commerce | P8,P9 | **R9**, **R1**, *R8* | OSS: clickhouse/duckdb + Superset; spine: metric registry | partial — doibio analytics canned SQL; NO report builder |
| Per-record audit / event monitoring | Immutable log of every read/write/export | P1 | **R11** | Spine: audit envelope; OSS: clickhouse sink | built — doibio immutable event-log audit (event-sourced vault→SQLite) |

---

## Coverage summary

Total features assessed: **57**.

| Status | Count | Notes |
|---|---|---|
| built | 4 | CSV import/export, webhooks (only automation), event-log audit, AI-chat-adjacent — all in doibio; no Marketing/Commerce-specific feature is fully built |
| partial | 21 | Spine substrate present (ontology Object API, identity resolution + provenance, Action Type executor, broker streaming, doibio objects/analytics/search) but not modeled for the specific Marketing/Commerce/Industry noun |
| designed | 25 | Decomposition + spine hook defined; needs the declarative builder/engine or domain schema pack |
| planned | 7 | Requires an external provider (SMS/push/payment) or an unbuilt scoring/attribution model |

By plane (owning, primary): P4/P6 object+ontology features dominate, followed by P7 kinetic (carts, orders, journeys-as-actions), P9 analytics (segmentation, attribution, dashboards), and P5 resolution (customer 360, identity stitching). P1 governance (consent, erasure, audit) cross-cuts.

By specialty role beyond the ubiquitous {**R1**, **R10**}: **R14 work-queue** (journeys, automations, OMS sagas, OmniScript), **R9 analytics-olap** (segmentation, attribution, dashboards, DPE), **R7 vector** (recs, personalization, affinity), **R4 object-index** (storefront search, list views), **R6 blob-cas** (creative + product media), **R8 timeseries-geo** (engagement/activity streams), **R5 graph** (catalog taxonomy, B2B account hierarchies).

---

## Notable gaps

- **No declarative journey / flow / OmniScript engine.** Journey Builder, Engagement Studio, Automation Studio, OmniScript, and Business Rules all decompose cleanly to **R14 + Action Types**, but there is no visual builder or compiled runtime — doibio's only automation is **webhooks**. This is the single biggest cluster of `designed` features and the clearest build target (Temporal-backed R14 + a journey-step→Action-Type compiler).
- **No real-time personalization / decisioning engine.** Interaction Studio's in-session decisioning (R2 + R7 + Action Type) is designed via kinetic containment but unbuilt; no rec model is wired to the vector role.
- **No segmentation / report builder.** doibio exposes **canned SQL only** (no report builder, no visual segment builder); CRMA/Datorama-class self-serve analytics needs the R9 engine (clickhouse/duckdb) bound and a query surface (Superset).
- **Commerce nouns unmodeled.** Catalog/PIM, cart, order, price book, inventory are all `designed` — the ontology Object/Link/Action types and Action executor exist, but no commerce schema pack has been authored or projected.
- **No SMS/push/payment provider adapters.** MobileConnect/MobilePush and payment capture/refund are `planned` pending provider integrations behind the detector/adapter SDK.
- **Search engine mismatch.** doibio runs **Elasticsearch** for full-text; the platform default object-index (R4) engine is **opensearch**. Either rebind the adapter or wrap ES — currently `partial` and inconsistent with the spine default.
- **Identity resolution is the realized moat here.** Customer 360, marketing/sales sync, and cross-device stitching all lean on the *built* `identity-resolution.ts` (631 LOC, ported into the ontology resolver) + per-field provenance — the strongest parity story in this slice, but cross-device blocking is not yet tuned.
- **Consent / privacy / right-to-erasure** has the audit (R11) + lineage (R12) substrate built, but the lineage-driven erasure cascade and consent-as-policy (R13/OPA) are not implemented — a compliance-blocking gap for any real Marketing deployment.
