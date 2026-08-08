-- Finance planning, rights/legal/safety, equipment, resources, and logistics.

PRAGMA foreign_keys = ON;

CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  company_number TEXT,
  tax_number TEXT,
  address_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(address_json)),
  payment_terms TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vendor_contacts (
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY (vendor_id, person_id, role)
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'working',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  working_version_id TEXT,
  approved_version_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX budgets_project_status_idx ON budgets(workspace_id, project_id, status, archived_at);

CREATE TABLE budget_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'working', 'approved', 'superseded')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  exchange_rate_note TEXT,
  contingency_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (contingency_basis_points >= 0),
  total_estimate_minor INTEGER NOT NULL DEFAULT 0,
  total_approved_minor INTEGER NOT NULL DEFAULT 0,
  total_committed_minor INTEGER NOT NULL DEFAULT 0,
  total_actual_minor INTEGER NOT NULL DEFAULT 0,
  total_paid_minor INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (budget_id, version_number)
);

CREATE TABLE budget_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  budget_version_id TEXT NOT NULL REFERENCES budget_versions(id) ON DELETE RESTRICT,
  parent_account_id TEXT REFERENCES budget_accounts(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (budget_version_id, code)
);

CREATE TABLE budget_lines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  budget_version_id TEXT NOT NULL REFERENCES budget_versions(id) ON DELETE RESTRICT,
  budget_account_id TEXT NOT NULL REFERENCES budget_accounts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  notes TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  quantity_micros INTEGER NOT NULL DEFAULT 1000000 CHECK (quantity_micros >= 0),
  unit TEXT,
  rate_minor INTEGER NOT NULL DEFAULT 0,
  duration_micros INTEGER NOT NULL DEFAULT 1000000 CHECK (duration_micros >= 0),
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  fringe_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (fringe_basis_points >= 0),
  tax_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (tax_basis_points >= 0),
  markup_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (markup_basis_points >= 0),
  estimate_minor INTEGER NOT NULL DEFAULT 0,
  approved_minor INTEGER NOT NULL DEFAULT 0,
  committed_minor INTEGER NOT NULL DEFAULT 0,
  actual_minor INTEGER NOT NULL DEFAULT 0,
  paid_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX budget_lines_account_order_idx ON budget_lines(project_id, budget_version_id, budget_account_id, sort_rank);

CREATE TABLE budget_line_links (
  budget_line_id TEXT NOT NULL REFERENCES budget_lines(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  allocation_minor INTEGER,
  PRIMARY KEY (budget_line_id, object_id)
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  quote_number TEXT,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  total_minor INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT,
  file_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  quantity_micros INTEGER NOT NULL DEFAULT 1000000 CHECK (quantity_micros >= 0),
  unit TEXT,
  unit_price_minor INTEGER NOT NULL,
  total_minor INTEGER NOT NULL,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE quote_comparisons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  quote_ids_json TEXT NOT NULL CHECK (json_valid(quote_ids_json)),
  decision TEXT,
  actor_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  po_number TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  total_minor INTEGER NOT NULL DEFAULT 0,
  issued_at INTEGER,
  due_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, po_number)
);

CREATE TABLE purchase_order_lines (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  budget_line_id TEXT REFERENCES budget_lines(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  total_minor INTEGER NOT NULL DEFAULT 0,
  issued_on TEXT,
  due_on TEXT,
  file_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, vendor_id, invoice_number)
);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  budget_line_id TEXT REFERENCES budget_lines(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  budget_line_id TEXT REFERENCES budget_lines(id) ON DELETE RESTRICT,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  incurred_on TEXT NOT NULL,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE expense_receipts (
  expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  file_version_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (expense_id, file_version_id)
);

CREATE TABLE petty_cash_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  custodian_person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  record_type TEXT NOT NULL CHECK (record_type IN ('float', 'expense', 'return', 'adjustment')),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  occurred_at INTEGER NOT NULL,
  notes TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);

CREATE TABLE payment_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  expense_id TEXT REFERENCES expenses(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'planned',
  due_on TEXT,
  paid_at INTEGER,
  reference TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((invoice_id IS NOT NULL) <> (expense_id IS NOT NULL))
);

CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'missing',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  requirement_type TEXT NOT NULL DEFAULT 'custom',
  jurisdiction TEXT,
  party_person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE RESTRICT,
  due_at INTEGER,
  expires_at INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal',
  is_blocking INTEGER NOT NULL DEFAULT 0 CHECK (is_blocking IN (0, 1)),
  template_version_id TEXT,
  current_file_version_id TEXT,
  signed_executed_state TEXT NOT NULL DEFAULT 'not_required',
  approval_id TEXT REFERENCES approvals(id) ON DELETE RESTRICT,
  restricted INTEGER NOT NULL DEFAULT 1 CHECK (restricted IN (0, 1)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX requirements_project_due_idx ON requirements(project_id, status, is_blocking DESC, due_at, archived_at);
CREATE INDEX requirements_object_idx ON requirements(project_id, object_id, requirement_type, archived_at);

CREATE TABLE agreements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL UNIQUE REFERENCES requirements(id) ON DELETE RESTRICT,
  agreement_type TEXT NOT NULL,
  parties_json TEXT NOT NULL CHECK (json_valid(parties_json)),
  effective_on TEXT,
  executed_at INTEGER,
  external_signature_provider TEXT,
  external_signature_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(external_signature_evidence_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL UNIQUE REFERENCES requirements(id) ON DELETE RESTRICT,
  release_type TEXT NOT NULL,
  releasing_party_person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  scope TEXT,
  territory TEXT,
  term TEXT,
  executed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE permits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL UNIQUE REFERENCES requirements(id) ON DELETE RESTRICT,
  permit_type TEXT NOT NULL,
  authority TEXT,
  permit_number TEXT,
  valid_from TEXT,
  valid_until TEXT,
  restrictions TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE insurance_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL UNIQUE REFERENCES requirements(id) ON DELETE RESTRICT,
  provider TEXT,
  policy_number TEXT,
  coverage_minor INTEGER,
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  valid_from TEXT,
  valid_until TEXT,
  restrictions TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE clearances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL UNIQUE REFERENCES requirements(id) ON DELETE RESTRICT,
  clearance_type TEXT NOT NULL,
  rights_holder TEXT,
  scope TEXT,
  territory TEXT,
  term TEXT,
  fee_minor INTEGER,
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE requirement_reminders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  remind_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE requirement_execution_evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE RESTRICT,
  evidence_type TEXT NOT NULL,
  file_version_id TEXT,
  provider_evidence_json TEXT CHECK (provider_evidence_json IS NULL OR json_valid(provider_evidence_json)),
  recorded_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);

CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'project', 'object', 'file')),
  placed_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  placed_at INTEGER NOT NULL,
  released_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  released_at INTEGER,
  release_reason TEXT
);

CREATE TABLE legal_hold_objects (
  legal_hold_id TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  PRIMARY KEY (legal_hold_id, object_id)
);

CREATE TABLE risk_assessments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  review_at INTEGER,
  approval_id TEXT REFERENCES approvals(id) ON DELETE RESTRICT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE hazards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  risk_assessment_id TEXT NOT NULL REFERENCES risk_assessments(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  affected_people TEXT,
  likelihood INTEGER NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  impact INTEGER NOT NULL CHECK (impact BETWEEN 1 AND 5),
  initial_score INTEGER NOT NULL CHECK (initial_score BETWEEN 1 AND 25),
  residual_likelihood INTEGER CHECK (residual_likelihood IS NULL OR residual_likelihood BETWEEN 1 AND 5),
  residual_impact INTEGER CHECK (residual_impact IS NULL OR residual_impact BETWEEN 1 AND 5),
  residual_score INTEGER CHECK (residual_score IS NULL OR residual_score BETWEEN 1 AND 25),
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open',
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE hazard_affected_people (
  hazard_id TEXT NOT NULL REFERENCES hazards(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  notes TEXT,
  PRIMARY KEY (hazard_id, person_id)
);

CREATE TABLE control_measures (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  hazard_id TEXT NOT NULL REFERENCES hazards(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'planned',
  due_at INTEGER,
  evidence_object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE safety_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  plan_type TEXT NOT NULL DEFAULT 'safety_plan',
  emergency_plan TEXT,
  medical_hospital TEXT,
  evacuation TEXT,
  weather_contingencies TEXT,
  safeguarding_intimacy TEXT,
  approval_id TEXT REFERENCES approvals(id) ON DELETE RESTRICT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE safety_plan_sections (
  id TEXT PRIMARY KEY,
  safety_plan_id TEXT NOT NULL REFERENCES safety_plans(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE safety_briefings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  safety_plan_id TEXT NOT NULL REFERENCES safety_plans(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  planned_at INTEGER,
  evidence_file_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE equipment_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  ownership_type TEXT NOT NULL DEFAULT 'owned' CHECK (ownership_type IN ('owned', 'borrowed', 'rented')),
  category TEXT NOT NULL DEFAULT 'uncategorized',
  manufacturer TEXT,
  model TEXT,
  serial_asset_id TEXT,
  condition TEXT,
  value_minor INTEGER CHECK (value_minor IS NULL OR value_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  storage_location TEXT,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE RESTRICT,
  insurance_requirement_id TEXT REFERENCES requirements(id) ON DELETE RESTRICT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, serial_asset_id)
);

CREATE INDEX equipment_items_status_idx ON equipment_items(workspace_id, project_id, status, archived_at, category);

CREATE TABLE equipment_kits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE kit_members (
  equipment_kit_id TEXT NOT NULL REFERENCES equipment_kits(id) ON DELETE RESTRICT,
  equipment_item_id TEXT NOT NULL REFERENCES equipment_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  sort_rank TEXT NOT NULL,
  PRIMARY KEY (equipment_kit_id, equipment_item_id)
);

CREATE TABLE rentals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quoted',
  pickup_at INTEGER,
  return_at INTEGER,
  deposit_minor INTEGER CHECK (deposit_minor IS NULL OR deposit_minor >= 0),
  cost_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  terms TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (return_at IS NULL OR pickup_at IS NULL OR return_at > pickup_at)
);

CREATE TABLE rental_items (
  rental_id TEXT NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
  equipment_item_id TEXT NOT NULL REFERENCES equipment_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (rental_id, equipment_item_id)
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  equipment_item_id TEXT REFERENCES equipment_items(id) ON DELETE RESTRICT,
  equipment_kit_id TEXT REFERENCES equipment_kits(id) ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  planned_custodian_person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  collection_checklist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(collection_checklist_json)),
  return_checklist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(return_checklist_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK ((equipment_item_id IS NOT NULL) <> (equipment_kit_id IS NOT NULL))
);

CREATE INDEX reservations_item_time_idx ON reservations(project_id, equipment_item_id, starts_at, ends_at, archived_at);
CREATE INDEX reservations_kit_time_idx ON reservations(project_id, equipment_kit_id, starts_at, ends_at, archived_at);

CREATE TABLE reservation_links (
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL,
  PRIMARY KEY (reservation_id, object_id, relation_type)
);

CREATE TABLE equipment_conditions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  equipment_item_id TEXT NOT NULL REFERENCES equipment_items(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  notes TEXT,
  photo_file_version_id TEXT,
  assessed_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  assessed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE resource_variants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  element_id TEXT NOT NULL REFERENCES elements(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE resource_measurements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  resource_variant_id TEXT NOT NULL REFERENCES resource_variants(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  measurements_json TEXT NOT NULL CHECK (json_valid(measurements_json)),
  unit_system TEXT NOT NULL DEFAULT 'metric',
  captured_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE fittings_tests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  resource_variant_id TEXT NOT NULL REFERENCES resource_variants(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  fitting_type TEXT NOT NULL,
  scheduled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'planned',
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE transport_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  route_map_url TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE transport_vehicles (
  id TEXT PRIMARY KEY,
  transport_plan_id TEXT NOT NULL REFERENCES transport_plans(id) ON DELETE RESTRICT,
  equipment_item_id TEXT REFERENCES equipment_items(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  driver_person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE transport_people (
  transport_vehicle_id TEXT NOT NULL REFERENCES transport_vehicles(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  pickup_stop_id TEXT,
  dropoff_stop_id TEXT,
  PRIMARY KEY (transport_vehicle_id, person_id)
);

CREATE TABLE transport_stops (
  id TEXT PRIMARY KEY,
  transport_plan_id TEXT NOT NULL REFERENCES transport_plans(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  address_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(address_json)),
  planned_at INTEGER,
  map_url TEXT,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE travel_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  departs_at INTEGER,
  arrives_at INTEGER,
  origin TEXT,
  destination TEXT,
  booking_reference TEXT,
  cost_minor INTEGER,
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE accommodation_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  check_in_on TEXT,
  check_out_on TEXT,
  booking_reference TEXT,
  responsible_person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  cost_minor INTEGER,
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE catering_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  vendor_id TEXT REFERENCES vendors(id) ON DELETE RESTRICT,
  head_count INTEGER NOT NULL DEFAULT 0 CHECK (head_count >= 0),
  meal_times_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(meal_times_json)),
  cost_minor INTEGER,
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE meal_plans (
  id TEXT PRIMARY KEY,
  catering_plan_id TEXT NOT NULL REFERENCES catering_plans(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  planned_at INTEGER,
  head_count INTEGER NOT NULL DEFAULT 0 CHECK (head_count >= 0),
  notes TEXT,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE dietary_requirements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  requirement_type TEXT NOT NULL,
  details TEXT NOT NULL,
  severity TEXT,
  access_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(access_policy_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE logistics_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  base_camp TEXT,
  holding TEXT,
  green_room TEXT,
  toilets TEXT,
  power_charging TEXT,
  waste TEXT,
  security TEXT,
  access_notes TEXT,
  emergency_notes TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE logistics_facilities (
  id TEXT PRIMARY KEY,
  logistics_plan_id TEXT NOT NULL REFERENCES logistics_plans(id) ON DELETE RESTRICT,
  facility_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  details TEXT,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
