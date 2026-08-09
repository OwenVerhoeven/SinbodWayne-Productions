import type { RecordFieldDefinition } from "./field-catalog";

export interface RecordWorkflowGroup {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly fieldKeys: readonly string[];
}

export interface RecordWorkflow {
  readonly intro: string;
  readonly outcome: string;
  readonly titleQuestion: string;
  readonly titlePlaceholder: string;
  readonly summaryQuestion: string;
  readonly summaryPlaceholder: string;
  readonly groups: readonly RecordWorkflowGroup[];
}

const group = (
  key: string,
  title: string,
  description: string,
  ...fieldKeys: readonly string[]
): RecordWorkflowGroup => ({ key, title, description, fieldKeys });

export const recordWorkflowCatalog: Readonly<Record<string, RecordWorkflow>> = {
  idea: {
    intro:
      "Capture the spark before judging it. A rough idea is useful when its promise and origin are clear.",
    outcome: "A searchable idea that can later become a project without losing its history.",
    titleQuestion: "What is the shortest working name for this idea?",
    titlePlaceholder: "For example: The last tram home",
    summaryQuestion: "What happens, in one compelling sentence?",
    summaryPlaceholder: "A person wants something, meets resistance, and something changes.",
    groups: [
      group("shape", "Shape the spark", "Name the form this idea might take.", "type"),
      group(
        "origin",
        "Remember the origin",
        "Keep enough context to rediscover why it mattered.",
        "source",
        "links",
        "tags",
      ),
    ],
  },
  project_brief: {
    intro: "Answer the decisions that should guide every later creative and production choice.",
    outcome: "A concise brief the team can use to judge whether the production is still on course.",
    titleQuestion: "What should this brief be called?",
    titlePlaceholder: "For example: Approved creative brief",
    summaryQuestion: "If the team remembers only one sentence, what should it be?",
    summaryPlaceholder: "State the central promise or direction of the production.",
    groups: [
      group(
        "why",
        "Why this film?",
        "Define the reason to make it and the creative point of view.",
        "purpose",
        "creativeIntent",
      ),
      group(
        "audience",
        "Who is it for?",
        "Be specific about the audience and desired response.",
        "audience",
        "viewerEffect",
      ),
      group(
        "shape",
        "What form should it take?",
        "Set the viewing context and intended scale.",
        "platform",
        "targetDurationMinutes",
        "distributionContext",
      ),
      group(
        "boundaries",
        "What are the boundaries?",
        "Make success and constraints visible early.",
        "budgetRange",
        "constraints",
        "successCriteria",
      ),
    ],
  },
  development_document: {
    intro:
      "Develop one story question at a time, then keep approved thinking traceable through revisions.",
    outcome: "A focused story document with clear creative context and source provenance.",
    titleQuestion: "Which story question or document are you developing?",
    titlePlaceholder: "For example: Mara's character arc",
    summaryQuestion: "What is the key conclusion or dramatic idea?",
    summaryPlaceholder: "Summarise the insight this document should establish.",
    groups: [
      group(
        "purpose",
        "Choose the purpose",
        "Start with the kind of story work you are doing.",
        "documentType",
      ),
      group(
        "story",
        "Develop the material",
        "Write freely, then name the tone and recurring ideas.",
        "body",
        "genre",
        "tone",
        "themes",
      ),
      group(
        "research",
        "Check the source",
        "Record where outside material came from and whether it can be used.",
        "provenance",
        "clearanceStatus",
      ),
    ],
  },
  lookbook: {
    intro:
      "Build a visual argument, not a folder of attractive images. Every section should communicate a choice.",
    outcome: "A presentable visual document with a clear sequence and purpose.",
    titleQuestion: "What visual idea does this board or deck explore?",
    titlePlaceholder: "For example: Intimate winter nights",
    summaryQuestion: "What should a viewer understand after seeing it?",
    summaryPlaceholder: "Describe the visual promise in one or two sentences.",
    groups: [
      group(
        "purpose",
        "Set the purpose",
        "Choose whether this is for exploration or presentation.",
        "kind",
        "tags",
      ),
      group(
        "sequence",
        "Build the visual argument",
        "Order the sections so each one advances the idea.",
        "sectionOutline",
      ),
      group(
        "presentation",
        "Plan the presentation",
        "Decide how it should feel when shared.",
        "background",
        "presentationNotes",
      ),
    ],
  },
  av_script: {
    intro:
      "Plan picture and sound together, with enough timing information to test whether the piece works.",
    outcome: "A timed audiovisual plan that can be reviewed before production.",
    titleQuestion: "What piece or sequence is this AV script for?",
    titlePlaceholder: "For example: Launch film — 30 seconds",
    summaryQuestion: "What should the finished piece communicate?",
    summaryPlaceholder: "State the message, story beat, or intended effect.",
    groups: [
      group(
        "format",
        "Set the format",
        "Choose a useful starting structure and timing standard.",
        "template",
        "frameRate",
      ),
      group(
        "columns",
        "Pair picture and sound",
        "Describe what the audience sees and hears.",
        "visual",
        "audio",
      ),
      group(
        "timing",
        "Test the timing",
        "Record where the row begins and how long it lasts.",
        "timecodeStart",
        "durationMs",
      ),
    ],
  },
  document: {
    intro: "Create a production document with a clear purpose, owner, and sharing boundary.",
    outcome: "Versioned paperwork that is easy to review, find, and safely share.",
    titleQuestion: "What will the team call this document?",
    titlePlaceholder: "For example: Location scout meeting notes",
    summaryQuestion: "What decision or information does this document capture?",
    summaryPlaceholder: "Give readers the context before they open the full document.",
    groups: [
      group(
        "purpose",
        "Define the document",
        "Choose its working purpose and audience.",
        "documentType",
        "confidentiality",
      ),
      group(
        "content",
        "Capture the content",
        "Write the material and pull out concrete follow-up items.",
        "body",
        "checklist",
      ),
    ],
  },
  scene_breakdown: {
    intro: "Translate one canonical scene into the practical work needed to prepare and shoot it.",
    outcome: "A scene-level preparation record that stays attached through script revisions.",
    titleQuestion: "How should the crew recognise this breakdown?",
    titlePlaceholder: "For example: Scene 12 — Rooftop confrontation",
    summaryQuestion: "What is the essential action of the scene?",
    summaryPlaceholder: "Describe what happens and what makes the scene demanding.",
    groups: [
      group(
        "scene",
        "Anchor the scene",
        "Link the stable scene and its story position.",
        "sceneId",
        "storyDay",
        "chronology",
        "pageEighths",
      ),
      group(
        "effort",
        "Estimate the work",
        "Make preparation and shooting time explicit.",
        "prepMinutes",
        "shootMinutes",
      ),
      group(
        "exceptions",
        "Record exceptions",
        "Only override script truth when production needs it.",
        "sourceOverride",
        "omitted",
      ),
    ],
  },
  element: {
    intro: "Describe one thing the production must provide, prepare, clear, or keep continuous.",
    outcome: "An owned, sourceable element linked to the work it affects.",
    titleQuestion: "What does the production need?",
    titlePlaceholder: "For example: Hero red coat",
    summaryQuestion: "Why does it matter on screen or during preparation?",
    summaryPlaceholder: "Describe its dramatic or practical purpose.",
    groups: [
      group(
        "identity",
        "Identify it",
        "Make the element easy to recognise across departments.",
        "category",
        "aliases",
        "quantity",
      ),
      group(
        "ownership",
        "Assign responsibility",
        "Decide which department owns the preparation.",
        "department",
      ),
      group(
        "source",
        "Plan how to get it",
        "Record the source and expected cost.",
        "procurement",
        "costMinor",
      ),
      group(
        "continuity",
        "Protect continuity",
        "Note changes, duplicates, fittings, tests, or reset needs.",
        "continuityNotes",
      ),
    ],
  },
  report_definition: {
    intro:
      "Save a report recipe by deciding who needs it, what it should contain, and how it will be issued.",
    outcome: "A repeatable report definition that produces consistent outputs.",
    titleQuestion: "Who is this report for and what will they call it?",
    titlePlaceholder: "For example: Art department pull list",
    summaryQuestion: "What decision or task should the report support?",
    summaryPlaceholder: "Explain when the team should use this report.",
    groups: [
      group(
        "output",
        "Choose the output",
        "Start with the report the recipient actually needs.",
        "reportType",
      ),
      group(
        "scope",
        "Choose what appears",
        "Save the filters and useful columns.",
        "filters",
        "columns",
      ),
      group(
        "presentation",
        "Prepare it for issue",
        "Set the paper and confidentiality treatment.",
        "paperSize",
        "watermark",
      ),
    ],
  },
  board: {
    intro: "Collect references around a deliberate visual question, not simply a theme.",
    outcome: "A reviewable board whose groups communicate visual choices.",
    titleQuestion: "What visual question is this board answering?",
    titlePlaceholder: "For example: How should the city feel at night?",
    summaryQuestion: "What visual direction should the team take from it?",
    summaryPlaceholder: "Describe the shared visual principle.",
    groups: [
      group(
        "intent",
        "Set the visual intent",
        "Choose the board's job and search language.",
        "boardType",
        "tags",
      ),
      group(
        "organise",
        "Organise the references",
        "Group images by the choices they demonstrate.",
        "groups",
      ),
      group(
        "present",
        "Choose the viewing experience",
        "Set a layout and background that support comparison.",
        "layout",
        "background",
      ),
    ],
  },
  storyboard: {
    intro:
      "Decide which visual beats must be understood before individual frames are drawn or uploaded.",
    outcome: "A storyboard plan connected to story and ready for frame creation.",
    titleQuestion: "Which scene, sequence, or idea will this storyboard explain?",
    titlePlaceholder: "For example: Opening chase — first pass",
    summaryQuestion: "What must the storyboard prove or communicate?",
    summaryPlaceholder: "Describe the visual problem this board should solve.",
    groups: [
      group(
        "scope",
        "Choose the scope",
        "Anchor the board to the story and grouping logic.",
        "grouping",
        "sceneId",
      ),
      group(
        "frame",
        "Plan the frames",
        "Set the intended frame and canvas.",
        "aspectRatio",
        "frameCount",
      ),
      group(
        "review",
        "Guide the review",
        "Tell collaborators what feedback is useful.",
        "presentationNotes",
      ),
    ],
  },
  shot_list: {
    intro:
      "Turn story intention into coverage: what must be seen, why it matters, and what it costs in setup time.",
    outcome: "A coverage plan the director and camera team can prioritise.",
    titleQuestion: "What sequence or coverage plan is this list for?",
    titlePlaceholder: "For example: Kitchen argument coverage",
    summaryQuestion: "What dramatic purpose must the coverage protect?",
    summaryPlaceholder: "Describe the emotion, information, or transition the shots must deliver.",
    groups: [
      group(
        "scope",
        "Anchor the coverage",
        "Connect the list to its scene, sequence, setup, or day.",
        "grouping",
        "sceneId",
      ),
      group(
        "priority",
        "Define the minimum coverage",
        "Separate essential shots from optional coverage.",
        "shotCount",
        "mustHaveCount",
      ),
      group(
        "effort",
        "Plan the effort",
        "Estimate setup burden and flag gaps.",
        "setupMinutes",
        "coverageNotes",
      ),
    ],
  },
  technical_look_plan: {
    intro: "Define a repeatable image and sound language so technical choices serve the story.",
    outcome:
      "An approved technical strategy that can guide tests, rentals, setups, and the production pack.",
    titleQuestion: "What version or approach does this technical plan represent?",
    titlePlaceholder: "For example: Approved camera and lighting approach",
    summaryQuestion: "What should the production consistently look and sound like?",
    summaryPlaceholder: "State the guiding technical idea in plain language.",
    groups: [
      group(
        "capture",
        "Set the capture standard",
        "Choose compatible image-making fundamentals.",
        "cameraFormat",
        "resolutionCodec",
        "frameRate",
        "shutter",
        "aspectRatio",
      ),
      group(
        "language",
        "Define the visual language",
        "Explain how lenses, movement, and light express the story.",
        "lensStrategy",
        "movementLanguage",
        "lightingPhilosophy",
      ),
      group(
        "pipeline",
        "Protect the pipeline",
        "Plan colour, sound, and effects before production.",
        "colourPipeline",
        "soundApproach",
        "vfxMethodology",
      ),
    ],
  },
  person: {
    intro:
      "Keep the contact, role, commitment, and availability information needed to work with this person respectfully.",
    outcome:
      "A usable project contact with clear booking state and appropriately restricted notes.",
    titleQuestion: "Who is this person?",
    titlePlaceholder: "Full or preferred professional name",
    summaryQuestion: "Why are they part of this production?",
    summaryPlaceholder: "Summarise their role, relationship, or current conversation.",
    groups: [
      group(
        "contact",
        "How can the team reach them?",
        "Record only useful contact and representation details.",
        "pronouns",
        "email",
        "phone",
        "company",
      ),
      group(
        "role",
        "What are they being asked to do?",
        "Make department, role, and commitment state clear.",
        "department",
        "projectRole",
        "bookingStatus",
      ),
      group(
        "terms",
        "When and on what terms?",
        "Capture availability and agreed planning figures.",
        "availability",
        "rateMinor",
        "rateUnit",
      ),
      group(
        "private",
        "What needs restricted handling?",
        "Keep sensitive practical needs narrow and purposeful.",
        "sensitiveNotes",
      ),
    ],
  },
  casting_role: {
    intro: "Define the dramatic and practical casting need before comparing candidates.",
    outcome: "A casting brief that supports fair review, availability checks, and booking.",
    titleQuestion: "Which role are you casting?",
    titlePlaceholder: "Character or performance role",
    summaryQuestion: "What is essential about this performance?",
    summaryPlaceholder: "Describe the dramatic function rather than an idealised person.",
    groups: [
      group(
        "character",
        "Understand the character",
        "Connect the role to story and playing range.",
        "characterId",
        "playingAge",
        "sceneIds",
      ),
      group(
        "needs",
        "What must the performer be able to do?",
        "Record relevant skills and production requirements.",
        "appearanceSkills",
        "specialRequirements",
      ),
      group(
        "pipeline",
        "Where is casting now?",
        "Track the decision stage and consent provenance.",
        "candidateStatus",
        "consentProvenance",
      ),
    ],
  },
  location: {
    intro: "Evaluate story fit and production reality together before calling a location approved.",
    outcome: "A location record that exposes access, technical, legal, and emergency gaps.",
    titleQuestion: "What location are you considering?",
    titlePlaceholder: "Venue or working location name",
    summaryQuestion: "Why does it suit the story, and what is the main concern?",
    summaryPlaceholder: "Balance the creative reason with the biggest production risk.",
    groups: [
      group(
        "identity",
        "Where is it and what does it play?",
        "Identify the address, map, timezone, and sets.",
        "setNames",
        "address",
        "mapUrl",
        "timezone",
      ),
      group(
        "deal",
        "Can the production use it?",
        "Record dates, holds, and expected fees.",
        "availability",
        "feeMinor",
      ),
      group(
        "practical",
        "Can the crew work there?",
        "Check access, facilities, power, sound, light, and rigging.",
        "accessLogistics",
        "powerSoundLight",
      ),
      group(
        "safety",
        "What could stop approval?",
        "Expose restrictions, emergency planning, permits, releases, and insurance.",
        "restrictions",
        "emergency",
        "legalSafetyState",
      ),
    ],
  },
  budget: {
    intro: "Record the financial plan the production is currently making decisions against.",
    outcome: "A versioned budget summary with visible approval, commitment, and variance.",
    titleQuestion: "What budget version is this?",
    titlePlaceholder: "For example: Working budget v2",
    summaryQuestion: "What assumptions or decisions define this version?",
    summaryPlaceholder: "Explain the scope and biggest financial change.",
    groups: [
      group(
        "basis",
        "Set the basis",
        "Name the version and currency.",
        "versionName",
        "currency",
        "exchangeRateNote",
      ),
      group(
        "plan",
        "What is planned and approved?",
        "Separate the estimate from the approved ceiling.",
        "estimateMinor",
        "approvedMinor",
        "contingencyMinor",
      ),
      group(
        "exposure",
        "What is already exposed?",
        "Track committed, actual, and tax amounts.",
        "committedMinor",
        "actualMinor",
        "taxMinor",
      ),
    ],
  },
  requirement: {
    intro:
      "Track what must be obtained, reviewed, renewed, or evidenced before the production can proceed.",
    outcome: "An owned requirement with truthful blocking and execution status.",
    titleQuestion: "What permission, agreement, right, or protection is needed?",
    titlePlaceholder: "For example: Canal location release",
    summaryQuestion: "What does this requirement cover?",
    summaryPlaceholder: "Explain the activity, material, person, or location affected.",
    groups: [
      group(
        "scope",
        "Define the requirement",
        "Name its type, jurisdiction, and responsible party.",
        "requirementType",
        "jurisdiction",
        "party",
      ),
      group(
        "timing",
        "When must it be valid?",
        "Record due and expiry dates.",
        "dueAt",
        "expiresAt",
      ),
      group(
        "evidence",
        "Is it cleared to proceed?",
        "Distinguish a blocker from received execution evidence.",
        "blocking",
        "signedExecuted",
        "legalDisclaimer",
      ),
    ],
  },
  equipment_item: {
    intro:
      "Describe the exact resource, its condition, availability, and movement before it reaches set.",
    outcome: "An identifiable equipment item with a realistic readiness plan.",
    titleQuestion: "What exact item or kit is being planned?",
    titlePlaceholder: "For example: A-camera body",
    summaryQuestion: "What will it be used for?",
    summaryPlaceholder: "Describe its role in the camera, lighting, sound, art, or logistics plan.",
    groups: [
      group(
        "identity",
        "Identify the item",
        "Record ownership, category, model, and asset identity.",
        "ownership",
        "category",
        "manufacturerModel",
        "serialAssetId",
      ),
      group(
        "condition",
        "Is it suitable and protected?",
        "Record condition, value, and storage.",
        "condition",
        "valueMinor",
        "storageLocation",
      ),
      group(
        "movement",
        "Can it be where it is needed?",
        "Plan reservation, pickup, and return.",
        "availability",
        "pickupReturn",
      ),
    ],
  },
  logistics_plan: {
    intro: "Work through how people and resources arrive, operate, eat, rest, and leave safely.",
    outcome: "A shoot-day logistics summary ready to feed the call sheet and production pack.",
    titleQuestion: "Which day or logistics problem does this plan cover?",
    titlePlaceholder: "For example: Shoot day 1 — city unit",
    summaryQuestion: "What is the overall movement and base strategy?",
    summaryPlaceholder: "Summarise the plan and its main pressure point.",
    groups: [
      group("day", "Anchor the plan", "Connect it to the correct shoot day.", "shootDayId"),
      group(
        "movement",
        "How does everyone get there and stay?",
        "Plan transport, travel, and accommodation.",
        "transport",
        "travelAccommodation",
      ),
      group(
        "welfare",
        "How is the team supported?",
        "Plan food, water, allergies, and access needs.",
        "catering",
        "dietaryRestricted",
      ),
      group(
        "base",
        "How will the base operate?",
        "Cover holding, facilities, power, waste, security, and emergencies.",
        "baseOperations",
        "securityEmergency",
      ),
    ],
  },
  task_card: {
    intro:
      "Turn a production need into an owned, sequenced action with a clear definition of done.",
    outcome: "A task that can be scheduled, assigned, checked, and linked to readiness.",
    titleQuestion: "What concrete action needs to happen?",
    titlePlaceholder: "Start with a verb, for example: Confirm generator delivery",
    summaryQuestion: "What does done look like?",
    summaryPlaceholder: "State the outcome, not just the activity.",
    groups: [
      group(
        "importance",
        "How important is it?",
        "Set priority and whether it blocks readiness.",
        "priority",
        "readinessBlocking",
      ),
      group(
        "ownership",
        "Who does it and when?",
        "Assign people, dates, and a realistic estimate.",
        "assignees",
        "startAt",
        "dueAt",
        "estimateMinutes",
      ),
      group(
        "steps",
        "What must happen first?",
        "Break down the work and name dependencies.",
        "checklist",
        "dependencies",
        "linkedObject",
      ),
    ],
  },
  calendar_event: {
    intro:
      "Place a real production commitment on the shared timeline with enough context to avoid conflicts.",
    outcome: "A timezone-safe event tied to people, dependencies, and production purpose.",
    titleQuestion: "What is happening?",
    titlePlaceholder: "For example: Lead wardrobe fitting",
    summaryQuestion: "What should participants prepare or achieve?",
    summaryPlaceholder: "Give the purpose and any essential arrival information.",
    groups: [
      group(
        "kind",
        "What kind of commitment is it?",
        "Choose the production event that best describes it.",
        "eventType",
      ),
      group(
        "when",
        "When does it happen?",
        "Set accurate dates, times, and timezone behaviour.",
        "startAt",
        "endAt",
        "timezone",
        "allDay",
      ),
      group(
        "people",
        "Who and what does it depend on?",
        "Name participants and preceding commitments.",
        "assignees",
        "dependencies",
      ),
    ],
  },
  schedule: {
    intro: "Create an explicit scheduling hypothesis before committing the production to it.",
    outcome: "A traceable schedule variant with pinned script truth and visible constraints.",
    titleQuestion: "What scheduling approach does this variant test?",
    titlePlaceholder: "For example: Two-day location-first plan",
    summaryQuestion: "What is the logic and trade-off of this variant?",
    summaryPlaceholder: "Explain what this arrangement optimises and what it risks.",
    groups: [
      group(
        "basis",
        "Set the basis",
        "Name the variant and pin the script revision.",
        "variantName",
        "working",
        "sourceRevisionId",
      ),
      group(
        "order",
        "Choose the scene order",
        "Record the scenes and any proposed grouping rule.",
        "sceneIds",
        "autoOrder",
      ),
      group(
        "limits",
        "Expose the constraints",
        "Separate hard constraints from warnings.",
        "hardConstraints",
        "warnings",
      ),
    ],
  },
  shoot_day: {
    intro: "Turn an approved schedule revision into one operational day before issuing documents.",
    outcome: "A shoot day with reliable date, call, location, scene, and wrap assumptions.",
    titleQuestion: "How should this shoot day be identified?",
    titlePlaceholder: "For example: Day 1 — Canal house",
    summaryQuestion: "What is the day's main production objective?",
    summaryPlaceholder: "Summarise the work and the biggest constraint.",
    groups: [
      group(
        "source",
        "Anchor the day",
        "Pin the schedule revision and scenes.",
        "scheduleRevisionId",
        "sceneIds",
      ),
      group(
        "identity",
        "When and where?",
        "Set date, unit, day count, and base.",
        "shootDate",
        "unit",
        "dayCount",
        "base",
      ),
      group(
        "timing",
        "What is the working envelope?",
        "Record the general call and estimated wrap.",
        "generalCall",
        "estimatedWrap",
      ),
    ],
  },
  message: {
    intro: "Communicate one clear production action or update, with truthful delivery evidence.",
    outcome: "A message record whose audience, purpose, and delivery state are explicit.",
    titleQuestion: "What is this communication about?",
    titlePlaceholder: "For example: Location scout confirmation",
    summaryQuestion: "What should the recipient know or do?",
    summaryPlaceholder: "Summarise the ask or decision before writing the full message.",
    groups: [
      group(
        "audience",
        "Who needs this?",
        "Choose the communication type, recipients, and template.",
        "messageType",
        "recipientUserIds",
        "template",
      ),
      group(
        "message",
        "What exactly should they receive?",
        "Write the message in clear production language.",
        "body",
      ),
      group(
        "delivery",
        "How was it delivered?",
        "Never claim delivery without provider or manual evidence.",
        "provider",
        "evidence",
      ),
    ],
  },
  file: {
    intro:
      "Describe where a file came from, how it should be found, and whether retention rules restrict it.",
    outcome: "A private, classifiable file record ready for immutable versioning.",
    titleQuestion: "What should the team call this file?",
    titlePlaceholder: "Use a clear human-readable document name",
    summaryQuestion: "What does it contain and why is it being kept?",
    summaryPlaceholder: "Describe the production purpose without exposing sensitive contents.",
    groups: [
      group(
        "organise",
        "Where does it belong?",
        "Choose its logical folder and useful search tags.",
        "folder",
        "tags",
      ),
      group(
        "origin",
        "Where did it come from?",
        "Record source and chain-of-custody context.",
        "provenance",
      ),
      group(
        "retention",
        "How must it be protected?",
        "Apply retention and legal-hold rules deliberately.",
        "retentionClass",
        "legalHold",
      ),
    ],
  },
  call_sheet_draft: {
    intro: "Prepare the information each recipient needs for a specific production activity.",
    outcome: "A call-sheet draft ready for recipient-safe preview and immutable issue.",
    titleQuestion: "What activity is this call sheet for?",
    titlePlaceholder: "For example: Shoot day 1 call sheet",
    summaryQuestion: "What is the most important instruction for this call?",
    summaryPlaceholder: "Summarise the day, location, or special arrival requirement.",
    groups: [
      group(
        "source",
        "Build from the right source",
        "Choose the type, shoot day, and schedule revision.",
        "callSheetType",
        "shootDayId",
        "sourceScheduleRevisionId",
      ),
      group(
        "day",
        "What must everyone know?",
        "Set the general call, weather context, and safety bulletin.",
        "generalCall",
        "weatherMode",
        "weather",
        "safetyBulletin",
      ),
      group(
        "privacy",
        "What varies by recipient?",
        "Define how private notes must be isolated.",
        "recipientNotes",
      ),
    ],
  },
  production_pack_draft: {
    intro: "Assemble only the approved, relevant material a recipient needs to arrive prepared.",
    outcome: "An ordered, permission-aware pack ready for deterministic issue.",
    titleQuestion: "What production pack are you building?",
    titlePlaceholder: "For example: Crew production pack — Day 1",
    summaryQuestion: "Who is it for and what should it enable?",
    summaryPlaceholder: "Describe the recipient and the decisions they need to make.",
    groups: [
      group(
        "audience",
        "Who will receive it?",
        "Set the recipient projection before selecting content.",
        "recipientRole",
        "includeConfidential",
      ),
      group(
        "contents",
        "What must be included?",
        "Order the approved sections for practical use.",
        "sections",
      ),
      group(
        "issue",
        "How should it be presented?",
        "Choose paper size and confidentiality marking.",
        "paperSize",
        "watermark",
      ),
    ],
  },
  export_snapshot: {
    intro:
      "Define an immutable export or archive request without confusing creation, verification, and deletion.",
    outcome: "A traceable export snapshot with truthful integrity and archive state.",
    titleQuestion: "What export or archive package is this?",
    titlePlaceholder: "For example: Ready to Shoot archive snapshot",
    summaryQuestion: "What does this snapshot need to preserve?",
    summaryPlaceholder: "Describe scope, recipient, and operational purpose.",
    groups: [
      group(
        "scope",
        "Choose the package",
        "Select the export type and schema contract.",
        "exportType",
        "schemaVersion",
      ),
      group(
        "integrity",
        "Can it be verified?",
        "Record manifest evidence separately from archive state.",
        "manifestHash",
        "archiveState",
      ),
    ],
  },
};

const promptOverrides: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  project_brief: {
    purpose: "Why should this production exist?",
    creativeIntent: "What creative point of view should guide every decision?",
    audience: "Who specifically should this reach?",
    viewerEffect: "What should the audience think, feel, or do afterwards?",
    constraints: "What cannot change, even if the plan becomes difficult?",
    successCriteria: "How will you know the production succeeded?",
  },
  development_document: { body: "What do you currently believe about this part of the story?" },
  scene_breakdown: { sceneId: "Which canonical scene does this breakdown belong to?" },
  element: { department: "Which department is responsible for making this ready?" },
  storyboard: { sceneId: "Which canonical scene does this storyboard explain?" },
  shot_list: { sceneId: "Which scene should this coverage serve?" },
  person: {
    availability: "When are they available, and what conflicts are already known?",
    sensitiveNotes: "Is there a practical need that only authorised producers should see?",
  },
  casting_role: {
    appearanceSkills: "Which story-relevant qualities or skills are genuinely required?",
  },
  location: {
    accessLogistics: "Can cast, crew, vehicles, and equipment enter and work here safely?",
    powerSoundLight: "What will camera, lighting, grip, and sound need to solve here?",
    emergency: "Where do people go and who is contacted if something goes wrong?",
  },
  requirement: { blocking: "Must this be complete before the affected work can proceed?" },
  equipment_item: { condition: "What is its verified condition before the shoot?" },
  logistics_plan: { transport: "How will people and equipment move door to door?" },
  task_card: { checklist: "What smaller checks prove this task is complete?" },
  message: { evidence: "What evidence exists that this was actually delivered or confirmed?" },
};

export function workflowForRecord(recordType: string): RecordWorkflow {
  return (
    recordWorkflowCatalog[recordType] ?? {
      intro: "Work through the questions that make this record useful to the production team.",
      outcome: "A clear, owned production record with enough context to act on.",
      titleQuestion: "What should the team call this?",
      titlePlaceholder: "Use a clear working name",
      summaryQuestion: "Why does this matter to the production?",
      summaryPlaceholder: "Summarise the decision, need, or intended outcome.",
      groups: [],
    }
  );
}

export function promptForField(recordType: string, field: RecordFieldDefinition): string {
  return (
    promptOverrides[recordType]?.[field.key] ??
    questionFromLabel(field.label, field.type === "checkbox")
  );
}

function questionFromLabel(label: string, boolean: boolean): string {
  const plain = label.replace(/\s*\([^)]*\)\s*/gu, " ").trim();
  if (boolean) return `${plain}?`;
  return `What should the production know about ${plain.toLowerCase()}?`;
}
