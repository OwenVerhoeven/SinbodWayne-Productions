export type RecordFieldType =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "date"
  | "datetime"
  | "url"
  | "email"
  | "tel"
  | "tags"
  | "checkbox"
  | "select";

export interface RecordFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: RecordFieldType;
  readonly help?: string;
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

const option = (...values: readonly string[]) =>
  values.map((value) => ({
    value,
    label: value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase()),
  }));

export const recordFieldCatalog: Readonly<Record<string, readonly RecordFieldDefinition[]>> = {
  idea: [
    {
      key: "type",
      label: "Production type",
      type: "select",
      options: option(
        "short_film",
        "narrative_video",
        "music_video",
        "youtube",
        "commercial",
        "episodic",
      ),
    },
    { key: "source", label: "Source or inspiration", type: "text" },
    { key: "tags", label: "Tags", type: "tags", help: "Separate tags with commas." },
    { key: "links", label: "Reference links", type: "textarea" },
  ],
  project_brief: [
    { key: "purpose", label: "Purpose", type: "textarea", required: true },
    { key: "creativeIntent", label: "Creative intent", type: "textarea" },
    { key: "audience", label: "Target audience", type: "textarea" },
    { key: "viewerEffect", label: "Intended viewer effect", type: "textarea" },
    { key: "platform", label: "Format / platform", type: "text" },
    {
      key: "targetDurationMinutes",
      label: "Target duration (minutes)",
      type: "number",
      min: 0,
      step: 0.1,
    },
    { key: "budgetRange", label: "Budget range", type: "text" },
    { key: "constraints", label: "Constraints", type: "textarea" },
    { key: "successCriteria", label: "Success criteria", type: "textarea" },
    { key: "distributionContext", label: "Distribution context", type: "textarea" },
  ],
  development_document: [
    {
      key: "documentType",
      label: "Document type",
      type: "select",
      options: option(
        "logline",
        "tagline",
        "elevator_pitch",
        "short_synopsis",
        "long_synopsis",
        "treatment",
        "director_statement",
        "outline",
        "character_bible",
        "world_bible",
        "research",
      ),
    },
    { key: "body", label: "Document body", type: "textarea", required: true },
    { key: "themes", label: "Themes", type: "tags" },
    { key: "tone", label: "Tone", type: "text" },
    { key: "genre", label: "Genre", type: "text" },
    { key: "provenance", label: "Research provenance", type: "textarea" },
    {
      key: "clearanceStatus",
      label: "Copyright / clearance",
      type: "select",
      options: option("review_required", "cleared", "restricted", "not_applicable"),
    },
  ],
  lookbook: [
    { key: "kind", label: "Format", type: "select", options: option("lookbook", "pitch_deck") },
    { key: "sectionOutline", label: "Ordered sections", type: "textarea" },
    { key: "presentationNotes", label: "Presentation notes", type: "textarea" },
    { key: "background", label: "Background treatment", type: "text" },
    { key: "tags", label: "Tags", type: "tags" },
  ],
  av_script: [
    {
      key: "template",
      label: "Template",
      type: "select",
      options: option(
        "music_video",
        "commercial",
        "corporate_explainer",
        "documentary_interview",
        "custom",
      ),
    },
    {
      key: "frameRate",
      label: "Frame rate",
      type: "select",
      options: option("24", "25", "30", "50", "60"),
    },
    { key: "visual", label: "Visual column", type: "textarea" },
    { key: "audio", label: "Audio / dialogue / VO", type: "textarea" },
    { key: "durationMs", label: "Row duration (milliseconds)", type: "number", min: 0, step: 1 },
    { key: "timecodeStart", label: "Start timecode", type: "text", help: "HH:MM:SS:FF" },
  ],
  document: [
    {
      key: "documentType",
      label: "Document type",
      type: "select",
      options: option("meeting_notes", "creative_brief", "policy", "plan", "letter", "custom"),
    },
    { key: "body", label: "Document body", type: "textarea" },
    { key: "checklist", label: "Checklist items", type: "textarea", help: "One item per line." },
    {
      key: "confidentiality",
      label: "Confidentiality",
      type: "select",
      options: option("project", "restricted", "public_share_allowed"),
    },
  ],
  scene_breakdown: [
    { key: "sceneId", label: "Canonical scene ID", type: "text", required: true },
    { key: "pageEighths", label: "Pages (eighths)", type: "number", min: 0, step: 1 },
    { key: "storyDay", label: "Story day", type: "text" },
    { key: "chronology", label: "Chronology", type: "number", step: 1 },
    { key: "prepMinutes", label: "Prep estimate (minutes)", type: "number", min: 0, step: 1 },
    { key: "shootMinutes", label: "Shoot estimate (minutes)", type: "number", min: 0, step: 1 },
    { key: "sourceOverride", label: "Module-specific override", type: "checkbox" },
    { key: "omitted", label: "Omitted", type: "checkbox" },
  ],
  element: [
    {
      key: "category",
      label: "Category",
      type: "select",
      options: option(
        "cast",
        "background",
        "props",
        "set_dressing",
        "wardrobe",
        "hair_makeup",
        "vehicle",
        "animal",
        "stunt",
        "special_effects",
        "vfx",
        "sound",
        "music_playback",
        "special_equipment",
        "intimacy_safeguarding",
        "safety_hazard",
        "custom",
      ),
    },
    { key: "aliases", label: "Aliases", type: "tags" },
    { key: "department", label: "Department", type: "text" },
    { key: "quantity", label: "Quantity", type: "number", min: 0, step: 1 },
    {
      key: "procurement",
      label: "Source / procurement",
      type: "select",
      options: option("owned", "borrowed", "rented", "made", "buy", "unknown"),
    },
    { key: "costMinor", label: "Planned cost (minor units)", type: "currency", min: 0, step: 1 },
    { key: "continuityNotes", label: "Continuity / prep notes", type: "textarea" },
  ],
  report_definition: [
    {
      key: "reportType",
      label: "Report type",
      type: "select",
      options: option(
        "breakdown_sheet",
        "breakdown_summary",
        "element_list",
        "cast_list",
        "location_list",
        "dood",
        "sides",
      ),
    },
    { key: "filters", label: "Saved filters", type: "textarea" },
    { key: "columns", label: "Selected columns", type: "tags" },
    { key: "paperSize", label: "Paper size", type: "select", options: option("A4", "Letter") },
    { key: "watermark", label: "Watermark", type: "text" },
  ],
  board: [
    {
      key: "boardType",
      label: "Board type",
      type: "select",
      options: option("mood_board", "look_board", "reference_board"),
    },
    { key: "groups", label: "Ordered groups", type: "textarea" },
    {
      key: "layout",
      label: "Layout",
      type: "select",
      options: option("grid", "masonry", "presentation"),
    },
    { key: "background", label: "Background", type: "text" },
    { key: "tags", label: "Tags", type: "tags" },
  ],
  storyboard: [
    {
      key: "grouping",
      label: "Grouping",
      type: "select",
      options: option("scene", "sequence", "custom"),
    },
    { key: "sceneId", label: "Canonical scene ID", type: "text" },
    { key: "aspectRatio", label: "Aspect ratio", type: "text" },
    { key: "frameCount", label: "Planned frames", type: "number", min: 0, step: 1 },
    { key: "presentationNotes", label: "Presentation notes", type: "textarea" },
  ],
  shot_list: [
    {
      key: "grouping",
      label: "Grouping",
      type: "select",
      options: option("project", "scene", "sequence", "setup", "shoot_day", "unit", "custom"),
    },
    { key: "sceneId", label: "Canonical scene ID", type: "text" },
    { key: "shotCount", label: "Shots", type: "number", min: 0, step: 1 },
    { key: "mustHaveCount", label: "Must-have shots", type: "number", min: 0, step: 1 },
    { key: "setupMinutes", label: "Setup total (minutes)", type: "number", min: 0, step: 1 },
    { key: "coverageNotes", label: "Coverage / readiness notes", type: "textarea" },
  ],
  technical_look_plan: [
    { key: "cameraFormat", label: "Camera format / body", type: "text" },
    { key: "resolutionCodec", label: "Resolution / codec", type: "text" },
    { key: "frameRate", label: "Frame rate", type: "text" },
    { key: "shutter", label: "Shutter convention", type: "text" },
    { key: "aspectRatio", label: "Aspect ratio", type: "text" },
    { key: "lensStrategy", label: "Lens / filtration strategy", type: "textarea" },
    { key: "movementLanguage", label: "Movement language", type: "textarea" },
    { key: "colourPipeline", label: "Colour pipeline / LUT", type: "textarea" },
    { key: "lightingPhilosophy", label: "Lighting philosophy", type: "textarea" },
    { key: "soundApproach", label: "Sound approach", type: "textarea" },
    { key: "vfxMethodology", label: "VFX methodology", type: "textarea" },
  ],
  person: [
    { key: "pronouns", label: "Pronouns", type: "text" },
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone", type: "tel" },
    { key: "company", label: "Company / representation", type: "text" },
    { key: "department", label: "Department", type: "text" },
    { key: "projectRole", label: "Project role", type: "text" },
    {
      key: "bookingStatus",
      label: "Booking status",
      type: "select",
      options: option("candidate", "hold", "offered", "booked", "confirmed", "released"),
    },
    { key: "availability", label: "Availability / conflicts", type: "textarea" },
    { key: "rateMinor", label: "Rate (minor units)", type: "currency", min: 0, step: 1 },
    {
      key: "rateUnit",
      label: "Rate unit",
      type: "select",
      options: option("hour", "day", "week", "flat"),
    },
    {
      key: "sensitiveNotes",
      label: "Restricted dietary / accessibility / emergency notes",
      type: "textarea",
    },
  ],
  casting_role: [
    { key: "characterId", label: "Linked character ID", type: "text" },
    { key: "playingAge", label: "Playing age", type: "text" },
    { key: "appearanceSkills", label: "Appearance / skills", type: "textarea" },
    { key: "specialRequirements", label: "Special requirements", type: "textarea" },
    { key: "sceneIds", label: "Canonical scene IDs", type: "tags" },
    {
      key: "candidateStatus",
      label: "Pipeline stage",
      type: "select",
      options: option("open", "shortlist", "callback", "hold", "offer", "booked", "closed"),
    },
    { key: "consentProvenance", label: "Consent / provenance", type: "textarea" },
  ],
  location: [
    { key: "setNames", label: "Set names", type: "tags" },
    { key: "address", label: "Address", type: "textarea" },
    { key: "mapUrl", label: "Validated map link", type: "url" },
    { key: "timezone", label: "Timezone", type: "text" },
    { key: "availability", label: "Availability / hold windows", type: "textarea" },
    { key: "feeMinor", label: "Fee (minor units)", type: "currency", min: 0, step: 1 },
    { key: "accessLogistics", label: "Access, loading, parking and facilities", type: "textarea" },
    { key: "powerSoundLight", label: "Power, sound, light and rigging", type: "textarea" },
    { key: "restrictions", label: "Restrictions", type: "textarea" },
    { key: "emergency", label: "Hospital, emergency and evacuation", type: "textarea" },
    {
      key: "legalSafetyState",
      label: "Permit / release / insurance / safety state",
      type: "select",
      options: option("missing", "in_progress", "blocked", "approved"),
    },
  ],
  budget: [
    { key: "versionName", label: "Version name", type: "text" },
    { key: "currency", label: "Currency", type: "text" },
    { key: "estimateMinor", label: "Estimate (minor units)", type: "currency", min: 0, step: 1 },
    { key: "approvedMinor", label: "Approved (minor units)", type: "currency", min: 0, step: 1 },
    { key: "committedMinor", label: "Committed (minor units)", type: "currency", min: 0, step: 1 },
    { key: "actualMinor", label: "Actual (minor units)", type: "currency", min: 0, step: 1 },
    { key: "taxMinor", label: "Tax (minor units)", type: "currency", min: 0, step: 1 },
    {
      key: "contingencyMinor",
      label: "Contingency (minor units)",
      type: "currency",
      min: 0,
      step: 1,
    },
    { key: "exchangeRateNote", label: "Exchange-rate note", type: "textarea" },
  ],
  requirement: [
    {
      key: "requirementType",
      label: "Requirement type",
      type: "select",
      options: option(
        "chain_of_title",
        "agreement",
        "appearance_release",
        "location_release",
        "minor_permission",
        "permit",
        "insurance",
        "music_rights",
        "clearance",
        "drone",
        "road",
        "fire",
        "animal",
        "weapon",
        "stunt",
        "special_effect",
        "public_space",
        "privacy_consent",
      ),
    },
    { key: "jurisdiction", label: "Jurisdiction", type: "text" },
    { key: "party", label: "Party", type: "text" },
    { key: "dueAt", label: "Due date", type: "date" },
    { key: "expiresAt", label: "Expiry date", type: "date" },
    { key: "blocking", label: "Blocking requirement", type: "checkbox" },
    { key: "signedExecuted", label: "Signed / executed evidence received", type: "checkbox" },
    {
      key: "legalDisclaimer",
      label: "Tracking notes",
      type: "textarea",
      help: "Tracking only; this application does not make legal determinations.",
    },
  ],
  equipment_item: [
    {
      key: "ownership",
      label: "Ownership",
      type: "select",
      options: option("owned", "borrowed", "rented"),
    },
    { key: "category", label: "Category", type: "text" },
    { key: "manufacturerModel", label: "Manufacturer / model", type: "text" },
    { key: "serialAssetId", label: "Serial / asset ID", type: "text" },
    { key: "condition", label: "Pre-shoot condition", type: "textarea" },
    { key: "valueMinor", label: "Value (minor units)", type: "currency", min: 0, step: 1 },
    { key: "storageLocation", label: "Storage location", type: "text" },
    { key: "availability", label: "Availability / reservation", type: "textarea" },
    { key: "pickupReturn", label: "Pickup / return plan", type: "textarea" },
  ],
  logistics_plan: [
    { key: "shootDayId", label: "Shoot day ID", type: "text" },
    { key: "transport", label: "Transport / unit moves / parking", type: "textarea" },
    { key: "travelAccommodation", label: "Travel / accommodation", type: "textarea" },
    { key: "catering", label: "Meals / catering / water", type: "textarea" },
    { key: "dietaryRestricted", label: "Restricted dietary / allergy summary", type: "textarea" },
    {
      key: "baseOperations",
      label: "Base camp / holding / toilets / power / waste",
      type: "textarea",
    },
    { key: "securityEmergency", label: "Security / access / emergency notes", type: "textarea" },
  ],
  task_card: [
    {
      key: "priority",
      label: "Priority",
      type: "select",
      options: option("low", "normal", "high", "urgent", "blocking"),
    },
    { key: "startAt", label: "Start", type: "datetime" },
    { key: "dueAt", label: "Due", type: "datetime" },
    { key: "estimateMinutes", label: "Estimate (minutes)", type: "number", min: 0, step: 1 },
    { key: "assignees", label: "Assignees", type: "tags" },
    { key: "checklist", label: "Checklist", type: "textarea", help: "One item per line." },
    { key: "dependencies", label: "Dependency task IDs", type: "tags" },
    { key: "linkedObject", label: "Linked production object ID", type: "text" },
    { key: "readinessBlocking", label: "Blocks readiness", type: "checkbox" },
  ],
  calendar_event: [
    {
      key: "eventType",
      label: "Event type",
      type: "select",
      options: option(
        "audition",
        "scout",
        "fitting",
        "rehearsal",
        "permit",
        "equipment_pickup",
        "equipment_return",
        "travel",
        "shoot_day",
        "deadline",
        "delivery",
        "milestone",
      ),
    },
    { key: "startAt", label: "Start", type: "datetime", required: true },
    { key: "endAt", label: "End", type: "datetime" },
    { key: "timezone", label: "Timezone", type: "text" },
    { key: "allDay", label: "All day", type: "checkbox" },
    { key: "assignees", label: "Assignees", type: "tags" },
    { key: "dependencies", label: "Dependency event IDs", type: "tags" },
  ],
  schedule: [
    { key: "variantName", label: "Variant name", type: "text" },
    { key: "working", label: "Working / default variant", type: "checkbox" },
    { key: "sourceRevisionId", label: "Pinned script revision ID", type: "text" },
    { key: "sceneIds", label: "Ordered canonical scene IDs", type: "tags" },
    {
      key: "autoOrder",
      label: "Auto-order preview basis",
      type: "select",
      options: option("none", "location", "day_night", "int_ext", "cast", "story_day"),
    },
    { key: "hardConstraints", label: "Hard constraints", type: "textarea" },
    { key: "warnings", label: "Conflict warnings", type: "textarea" },
  ],
  shoot_day: [
    {
      key: "scheduleRevisionId",
      label: "Pinned schedule revision ID",
      type: "text",
      required: true,
    },
    { key: "shootDate", label: "Shoot date", type: "date", required: true },
    { key: "unit", label: "Unit", type: "text" },
    { key: "dayCount", label: "Day count", type: "number", min: 1, step: 1 },
    { key: "generalCall", label: "General call", type: "datetime" },
    { key: "estimatedWrap", label: "Estimated wrap", type: "datetime" },
    { key: "base", label: "Base / primary location", type: "text" },
    { key: "sceneIds", label: "Canonical scene IDs", type: "tags" },
  ],
  message: [
    {
      key: "messageType",
      label: "Message type",
      type: "select",
      options: option("direct", "announcement", "provider_outbox", "manual_log"),
    },
    { key: "recipientUserIds", label: "Internal recipient user IDs", type: "tags" },
    { key: "body", label: "Message body", type: "textarea", required: true },
    {
      key: "template",
      label: "Template",
      type: "select",
      options: option(
        "audition",
        "booking",
        "location",
        "crew_confirmation",
        "call_sheet",
        "reminder",
        "custom",
      ),
    },
    {
      key: "provider",
      label: "Delivery provider",
      type: "select",
      options: option("manual", "email_not_configured", "sms_not_configured"),
    },
    { key: "evidence", label: "Manual/provider evidence", type: "textarea" },
  ],
  file: [
    { key: "folder", label: "Logical folder", type: "text" },
    { key: "tags", label: "Tags", type: "tags" },
    { key: "provenance", label: "Provenance", type: "textarea" },
    { key: "retentionClass", label: "Retention class", type: "text" },
    { key: "legalHold", label: "Legal hold", type: "checkbox" },
  ],
  call_sheet_draft: [
    {
      key: "callSheetType",
      label: "Type",
      type: "select",
      options: option("shoot_day", "scout", "rehearsal", "fitting_test", "custom"),
    },
    { key: "shootDayId", label: "Shoot day ID", type: "text" },
    { key: "sourceScheduleRevisionId", label: "Pinned schedule revision ID", type: "text" },
    { key: "generalCall", label: "General call", type: "datetime" },
    {
      key: "weatherMode",
      label: "Weather",
      type: "select",
      options: option("manual", "not_configured"),
    },
    { key: "weather", label: "Frozen manual weather / contingency", type: "textarea" },
    { key: "safetyBulletin", label: "Safety bulletin", type: "textarea" },
    { key: "recipientNotes", label: "Recipient-private notes policy", type: "textarea" },
  ],
  production_pack_draft: [
    { key: "sections", label: "Ordered sections", type: "textarea" },
    { key: "recipientRole", label: "Recipient role / projection", type: "text" },
    { key: "paperSize", label: "Paper size", type: "select", options: option("A4", "Letter") },
    { key: "watermark", label: "Watermark", type: "text" },
    {
      key: "includeConfidential",
      label: "Include permitted confidential sections",
      type: "checkbox",
    },
  ],
  export_snapshot: [
    {
      key: "exportType",
      label: "Export type",
      type: "select",
      options: option(
        "module_csv",
        "module_print",
        "project_json",
        "production_pack",
        "nas_archive",
      ),
    },
    { key: "schemaVersion", label: "Schema version", type: "text" },
    { key: "manifestHash", label: "Manifest hash", type: "text" },
    {
      key: "archiveState",
      label: "Archive state",
      type: "select",
      options: option("requested", "running", "verifying", "verified", "failed"),
    },
  ],
};

export function fieldsForRecord(recordType: string): readonly RecordFieldDefinition[] {
  return recordFieldCatalog[recordType] ?? [];
}

export function fieldValueForInput(
  field: RecordFieldDefinition,
  raw: FormDataEntryValue | null,
): unknown {
  if (field.type === "checkbox") return raw === "on";
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  if (field.type === "number" || field.type === "currency") return Number(text);
  if (field.type === "tags")
    return [
      ...new Set(
        text
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
  if (field.type === "date" || field.type === "datetime") {
    const epoch = Date.parse(text);
    return Number.isFinite(epoch) ? epoch : null;
  }
  return text;
}

export function fieldValueForForm(
  field: RecordFieldDefinition,
  value: unknown,
): string | number | undefined {
  if (value === null || value === undefined) return undefined;
  if (field.type === "tags")
    return Array.isArray(value) ? value.map(String).join(", ") : String(value);
  if (field.type === "date" && typeof value === "number")
    return new Date(value).toISOString().slice(0, 10);
  if (field.type === "datetime" && typeof value === "number") {
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value);
}
