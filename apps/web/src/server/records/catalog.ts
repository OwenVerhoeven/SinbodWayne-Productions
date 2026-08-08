export interface RecordTableDefinition {
  readonly table: string;
  readonly objectType: string;
}

export const recordTables: Readonly<Record<string, RecordTableDefinition>> = Object.freeze({
  idea: { table: "ideas", objectType: "idea" },
  project_brief: { table: "project_briefs", objectType: "project_brief" },
  development_document: { table: "development_documents", objectType: "development_document" },
  lookbook: { table: "lookbooks", objectType: "lookbook" },
  av_script: { table: "av_scripts", objectType: "av_script" },
  document: { table: "documents", objectType: "document" },
  scene_breakdown: { table: "scene_breakdowns", objectType: "scene_breakdown" },
  element: { table: "elements", objectType: "element" },
  report_definition: { table: "report_definitions", objectType: "report_definition" },
  board: { table: "boards", objectType: "board" },
  storyboard: { table: "storyboards", objectType: "storyboard" },
  shot_list: { table: "shot_lists", objectType: "shot_list" },
  technical_look_plan: { table: "technical_look_plans", objectType: "technical_look_plan" },
  person: { table: "people", objectType: "person" },
  casting_role: { table: "casting_roles", objectType: "casting_role" },
  location: { table: "locations", objectType: "location" },
  budget: { table: "budgets", objectType: "budget" },
  requirement: { table: "requirements", objectType: "requirement" },
  equipment_item: { table: "equipment_items", objectType: "equipment_item" },
  logistics_plan: { table: "logistics_plans", objectType: "logistics_plan" },
  task_card: { table: "task_cards", objectType: "task_card" },
  calendar_event: { table: "calendar_events", objectType: "calendar_event" },
  schedule: { table: "schedules", objectType: "schedule" },
  shoot_day: { table: "shoot_days", objectType: "shoot_day" },
  message: { table: "messages", objectType: "message" },
  file: { table: "files", objectType: "file" },
  call_sheet_draft: { table: "call_sheet_drafts", objectType: "call_sheet_draft" },
  production_pack_draft: { table: "production_pack_drafts", objectType: "production_pack_draft" },
  export_snapshot: { table: "export_snapshots", objectType: "export_snapshot" },
});

export function getRecordTable(recordType: string): RecordTableDefinition | undefined {
  return recordTables[recordType];
}
