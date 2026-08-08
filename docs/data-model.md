# Data Model

## Modeling rules

- IDs are opaque, collision-resistant, time-sortable text values. Display codes, numbers, names and ranks are mutable.
- Tenant-owned rows carry `workspace_id`; project-owned rows also carry `project_id` where useful for explicit policy and indexing.
- Timestamps are UTC instants. Local dates/times retain the named IANA timezone required to resolve them; rendering uses the project or location timezone.
- Money is integer minor units with ISO currency and an explicit exchange-rate note where needed.
- Page quantities are integer eighths. Durations are integer milliseconds or frame counts; a rational numerator/denominator describes frame rate.
- Mutable records use an integer `version`, archive metadata, creator/updater and timestamps. Archive precedes guarded permanent deletion.
- Ranks use collision-resistant fractional ordering and have a deterministic rebalance operation.
- Revisions, issues, decisions, audit events, file versions, snapshots and archive acknowledgements are append-only.
- JSON is bounded and schema-versioned for immutable snapshots, provider evidence, editor fragments or intentionally variable presentation configuration. The live project is never one JSON document.
- Binary content resides in private R2; D1 contains relational metadata, pins and integrity values.

## Common relational foundation

### Object registry

`object_registry(id, object_type, workspace_id, project_id, domain_table, domain_id, archived_at, created_at)` supports comments, mentions, files, tasks, approvals, shares, activity and readiness dependencies. Object type is an allowlisted domain enum. A service creates the registry row in the same transaction as the domain row and centrally validates workspace/project ownership.

Common joins include:

- `object_comments(object_id, comment_id)`
- `object_files(object_id, file_id, purpose)`
- `object_tasks(object_id, task_card_id)`
- `object_approvals(object_id, approval_id)`
- `object_shares(object_id, share_link_id)`
- `readiness_sources(result_id, object_id, revision_or_version_id)`

Dedicated association tables remain preferable when the relation has domain semantics, cardinality, status, timing, or referential invariants.

### Mutability and version assertions

A standard mutable row contains `version integer not null default 1`. Updates provide an expected version. The D1 transaction/batch executes a database assertion that aborts on mismatch, applies all related changes, increments once, then appends activity/audit. Returning zero rows without abort is not an acceptable concurrency control for multi-statement writes.

Immutable tables reject update/delete through database guards except an explicit, narrowly controlled retention migration where the complete policy is revalidated. Supersession, current pointers and stale projections live in mutable parent/state tables; issued bodies do not change.

## Entity catalog

The implementation may split high-volume or sensitive fields into additional one-to-one tables, but may not collapse these groups into a project blob.

### Tenancy and authentication

- `workspaces` — company profile, locale/time/currency/unit/paper defaults and retention settings.
- `user_identities` — case-sensitive username, display name, active state and authentication epoch.
- `password_credentials` — encoded KDF profile/verifier material and change metadata; never plaintext.
- `sessions` — credential digest, user, expiry/idle timestamps, device metadata, CSRF verifier, revoked state.
- `workspace_memberships`, `project_memberships`, `permission_grants` — role and narrower module/object/field grants.
- `share_links` — public locator, secret digest, purpose, scoped object/fields/actions, expiry/revocation.
- `service_credentials` — least-privilege service identity, secret digest, scopes, expiry/rotation/revocation.
- `audit_events` — append-only security/high-impact event records with redacted metadata.
- `notifications`, `notification_receipts` — per-user inbox and unread state.
- `idempotency_records`, `rate_limit_buckets`, `bootstrap_operations` — bounded retry/security state.

### Projects and development

- `projects`, `series`, `seasons`, `episodes` — standalone or hierarchical project identity and complete configuration.
- `ideas`, `idea_tags`, `idea_history` — inbox and promotion provenance; promotion attaches a project without copying away history.
- `project_briefs` plus immutable brief revisions where separated.
- `development_documents`, `development_revisions` — typed logline/pitch/synopsis/treatment/statement/rationale/theme content and current pointer.
- `outlines`, `outline_revisions`, `beats`, `beat_character_links`, `beat_scene_links` — stable structured story order.
- `story_events` — chronological story order independent of presentation order.
- `character_profiles`, `relationships`, `world_notes` — bible and story relationships.
- `research_items`, `research_sources` — source URL/citation, captured notes, provenance and clearance status.
- `approvals` and immutable `approval_decisions` — common request state and pinned decisions.

### Writing

- `screenplays` — working/current/approved revision pointers and numbering policy.
- `script_drafts`, `script_draft_blocks` — mutable structured working blocks with stable block IDs.
- `script_revisions`, `script_block_revisions` — immutable revision metadata and block snapshots.
- `scenes` — canonical project scene identity, display number/current revision/omission state.
- `scene_revisions` — immutable scene content/slugline/source block/order within a script revision.
- `script_syncs`, `scene_mappings`, `scene_mapping_impacts`, `scene_mapping_decisions` — immutable preview/apply record and explicit resolution.
- `script_comments`, `script_comment_anchors` — stable block or revision-range anchors.
- `av_scripts`, `av_revisions`, `av_segments`, `av_rows`, `av_row_revisions` — stable two-/multi-column scripts and timing.
- `documents`, `document_revisions`, `document_blocks` — sanitized general structured documents.
- `templates`, `template_versions` — typed, versioned provenance and clone input across modules.

### Breakdown and reports

- `scene_breakdowns`, `breakdown_overrides` — scene source values, module overrides, readiness and exact totals.
- `element_categories`, `elements`, `element_aliases` — workspace/project categories and element profiles.
- `scene_element_tags`, `tag_source_ranges` — stable block/range source plus manual/implied tags.
- `element_merges`, `reference_redirects` — previewed transactional merge audit.
- `procurement_records` — source, vendor, quantity/variant/measurements, fitting/test, cost and readiness.
- `report_definitions`, `report_snapshots`, `report_snapshot_items` — saved configuration and immutable output pins.
- `sides_issues`, `sides_issue_scenes`, `sides_issue_characters` — immutable selected revision content.

### People, casting and communications

- `people` — contact identity separate from login, names/photo/provenance/consent/retention.
- `contact_points`, `person_addresses`, `person_sensitive_details`, `emergency_contacts` — permission-separable fields.
- `departments`, `role_definitions`, `person_project_roles` — configurable job/department, booking, rates/terms, legal/confirmation state.
- `availability`, `availability_exceptions` — person/resource windows and declared conflicts.
- `characters`, `cast_assignments` — script character identity and booked person link.
- `contact_lists`, `contact_list_members`, `contact_imports`, `contact_merge_operations`.
- `casting_roles`, `candidates`, `candidate_media`, `auditions`, `audition_slots`, `candidate_ratings`, `candidate_status_history`.
- `messages`, `message_participants`, `message_templates`, `outbox_entries`, `delivery_events`.
- `announcements`, `announcement_receipts`.

### Locations

- `locations` — physical place, address/GPS/map/timezone/fee/status and operational fields.
- `sets`, `location_set_links` — story sets distinct from physical locations.
- `location_contacts`, `location_availability`, `location_holds`, `location_scene_links`.
- `scout_visits`, `scout_attendees`, `scout_media_groups`, `scout_decisions` — versioned evidence and approvals.
- `location_facilities`, `location_technical_details`, `location_hazards`, `location_emergency_details` where field policy or indexing warrants separation.

### Visual and technical planning

- `boards`, `board_groups`, `board_items`, `board_item_links` — reusable ranked media/text and object relations.
- `annotation_layers`, `annotations` — non-destructive crop/adjust/text/shape/arrow data pinned to a source file version.
- `storyboards`, `storyboard_frames`, `storyboard_frame_links` — stable frame metadata and source relations.
- `shot_lists`, `shot_groups`, `shots`, `shot_source_ranges`, `shot_object_links` — complete creative/technical plan.
- `frame_shot_links` — provenance and explicit created/linked reason.
- `camera_setups`, `setup_equipment`, `setup_people`, `setup_files`.
- `technical_look_plans`, `technical_look_revisions` — versioned project format/look/sound/effects plan.

### Finance

- `budgets`, `budget_versions`, `budget_accounts`, `budget_lines`, `budget_line_links`.
- `vendors`, `vendor_contacts`, `quotes`, `quote_lines`, `quote_comparisons`.
- `purchase_orders`, `purchase_order_lines`, `invoices`, `invoice_lines`.
- `expenses`, `expense_receipts`, `petty_cash_records`, `payment_records`.
- `finance_approvals`, or common approval joins pinned to exact budget/change versions.

Calculated totals are derived by pure integer services and stored only when a snapshot requires reproducibility. The current view recomputes or verifies cached projections.

### Legal and safety

- `requirements` — configurable type/jurisdiction/party/object/dates/status/blocker/template/file/approval data.
- `agreements`, `releases`, `permits`, `insurance_records`, `clearances` — typed details linked to the common requirement.
- `requirement_reminders`, `requirement_execution_evidence` — external status and file pin.
- `legal_holds`, `legal_hold_objects` — owner-controlled retention gates.
- `risk_assessments`, `hazards`, `hazard_affected_people`, `control_measures` — initial/residual scoring and ownership.
- `safety_plans`, `safety_plan_sections`, `safety_briefings` — method/emergency/medical/evacuation/contingency/safeguarding records.

### Equipment, production resources and logistics

- `equipment_items`, `equipment_kits`, `kit_members` — kits reference rather than duplicate child assets.
- `rentals`, `rental_items`, `reservations`, `reservation_links`, `equipment_conditions`.
- `resource_variants`, `resource_measurements`, `fittings_tests` extend procurement for props/wardrobe/makeup/dressing.
- `transport_plans`, `transport_vehicles`, `transport_people`, `transport_stops`.
- `travel_records`, `accommodation_records`.
- `catering_plans`, `meal_plans`, `dietary_requirements` with narrower field policy.
- `logistics_plans`, `logistics_facilities` — unit base/holding/toilets/power/waste/security/access/emergency.

### Tasks, approvals and calendar

- `task_boards`, `task_columns`, `task_cards`, `task_assignees`, `task_checklists`, `checklist_items`, `task_dependencies`.
- Common `comments`, `mentions`, `activities`, object links and approvals attach through validated joins.
- `calendars`, `calendar_revisions`, `calendar_rows`, `calendar_events`, `event_assignees`, `event_dependencies`, `working_days`, `holidays`.
- Event external-update identity is stable across ICS exports; revision and sequence advance on material change.

### Schedules and shoot days

- `schedules`, `schedule_revisions`, `schedule_items` — named variants and immutable ranked snapshots.
- `scene_segments` — split work linked to the same canonical `scene_id`.
- `shoot_days` — pinned schedule revision plus day/date/unit/call/wrap/base/location/constraints.
- `resource_conflicts`, `conflict_resources`, `conflict_resolutions` — deterministic evidence, severity and explicit override.
- Report snapshots pin an exact schedule revision and configuration.

### Call sheets and production packs

- `call_sheet_drafts`, `call_sheet_sections`, `call_sheet_recipients`, `call_sheet_person_calls`.
- `call_sheet_issues` — immutable issue body/source pins/integrity/supersession.
- `call_sheet_recipient_issues` — immutable permission-filtered recipient variant.
- `delivery_events`, `confirmations` — evidence with idempotency and actor context.
- `production_pack_drafts`, `production_pack_items`, `production_pack_issues`, `production_pack_manifest_items`.

Private recipient content is never placed in a common issue body and filtered client-side. Each recipient variant is generated from policy-selected data and independently pinned.

### Readiness

- `readiness_profiles`, `readiness_profile_versions`, `readiness_rules`.
- `readiness_evaluations`, `readiness_results`, `readiness_sources`.
- `readiness_overrides` — scope, reason, actor, time, expiry and policy category.
- `readiness_issues`, `readiness_issue_results`, `readiness_issue_sources`, `readiness_stale_events`.

An evaluator result is one of pass, warning, blocker or unavailable. Unavailable/missing never normalizes to pass. Issue rows freeze the full rule/profile version, source pins, approvals and overrides.

### Exports and archive

- `export_snapshots`, `export_snapshot_objects`, `export_manifest_items` — schema version, R2 body/manifest, source pins and overall integrity.
- `archive_jobs`, `archive_attempts`, `archive_manifest_items`, `archive_leases`, `archive_acknowledgements`.
- `retention_actions` — owner-only distinct cloud-copy removal request with verified archive and legal/retention evidence.

Archive manifest paths are safe relative logical destinations; cloud object keys and access credentials never become NAS destination paths.

## Key relationships and deletion behavior

- Workspace deletion is owner-only, typed-confirmed, legal-hold/retention guarded, and never a cascading shortcut to erase immutable audit or the only good copy.
- Project archive is soft and reversible. Permanent deletion resolves file versions, issued artifacts, exports and archive evidence explicitly.
- Person deletion/correction follows privacy/retention policy and preserves required production/legal/audit references through redaction, tombstone or legal hold rather than broken foreign keys.
- Scene removal marks canonical work omitted, remaps, or explicitly archives it during sync. It never cascades downstream work because a display scene disappeared.
- Making a prior file version current changes only the logical file pointer; pins remain unchanged.
- A schedule/script/pack/readiness restore or correction creates a new revision/issue or traceable pointer transition.

## Index strategy

Every foreign key used for joins/deletes has an intentional index. Common composites begin with tenant scope:

- `(workspace_id, project_id, archived_at, updated_at, id)` for paged project lists;
- `(project_id, scene_id)` on every scene-linked association;
- `(project_id, object_type, object_id)` on validated common links;
- `(workspace_id, username)` with binary/case-sensitive uniqueness for identities;
- `(credential_digest)` on active sessions/shares/service credentials;
- `(project_id, status, due_at)` for tasks/requirements;
- `(project_id, shoot_day_id, resource_type, resource_id)` for conflict detection;
- `(logical_file_id, created_at, id)` for versions and `(object_key)` uniqueness;
- `(job_id, state, lease_expires_at)` for durable work;
- `(workspace_id, created_at, id)` for audit/activity cursors.

Query-plan tests or representative assertions guard high-volume dashboard, search, breakdown, schedule, call-recipient and readiness access.

## Derived search

A D1 FTS5 index may hold normalized permitted search text for projects, scenes, people, elements, locations, files, tasks, requirements, days, shots and documents. It is a rebuildable projection:

- canonical results are re-resolved through tenant/object/field policy;
- sensitive private text is excluded or stored in separately authorized projections;
- archive/current state is verified from canonical tables;
- backup/restore exports canonical rows and rebuilds FTS from a versioned procedure;
- search cursor/output cannot reveal hidden-result counts or snippets.

## Migration discipline

Migrations are numbered, forward-only, and safe for D1 foreign-key behavior. Each migration is tested against an empty database and the supported prior representative state. Destructive transforms create/verify replacement data before removing old structures and have an operator rollback/restore plan. Production migration commands identify the exact database and environment and are never part of an implicit deploy.

Schema smoke tests verify foreign keys, required indexes, case-sensitive identity uniqueness, immutable guards, optimistic assertion behavior, account manifest capability, and no demo/test identities in production bootstrap.
