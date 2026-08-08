import type { ComponentType } from "react";
import {
  Archive,
  Banknote,
  BookOpenText,
  Boxes,
  BriefcaseBusiness,
  CalendarDays,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  ContactRound,
  FileStack,
  Film,
  FolderOpen,
  Lightbulb,
  ListChecks,
  MapPin,
  Megaphone,
  PackageCheck,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Wrench,
} from "lucide-react";

export interface ModuleDefinition {
  readonly key: string;
  readonly title: string;
  readonly singular: string;
  readonly description: string;
  readonly recordType?: string;
  readonly icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  readonly specialized?: boolean;
}

export interface NavigationGroup {
  readonly key: string;
  readonly label: string;
  readonly modules: readonly ModuleDefinition[];
}

export const navigationGroups: readonly NavigationGroup[] = [
  {
    key: "overview",
    label: "Overview",
    modules: [
      {
        key: "overview",
        title: "Command Centre",
        singular: "overview",
        description: "Current production state, blockers and recent changes.",
        icon: Film,
        specialized: true,
      },
    ],
  },
  {
    key: "development",
    label: "Development",
    modules: [
      {
        key: "ideas",
        title: "Idea Inbox",
        singular: "idea",
        description: "Capture, rank and promote early production ideas.",
        recordType: "idea",
        icon: Lightbulb,
      },
      {
        key: "briefs",
        title: "Project Brief",
        singular: "brief",
        description: "Purpose, audience, creative intent, constraints and success criteria.",
        recordType: "project_brief",
        icon: BriefcaseBusiness,
      },
      {
        key: "development-docs",
        title: "Story & Treatment",
        singular: "development document",
        description: "Loglines, synopses, treatments, outlines, characters, worlds and research.",
        recordType: "development_document",
        icon: BookOpenText,
      },
      {
        key: "lookbooks",
        title: "Lookbooks & Pitch",
        singular: "lookbook",
        description: "Approved visual references, lookbooks and pitch-deck sections.",
        recordType: "lookbook",
        icon: Sparkles,
      },
    ],
  },
  {
    key: "writing",
    label: "Writing",
    modules: [
      {
        key: "screenplay",
        title: "Screenplay",
        singular: "screenplay",
        description: "Structured screenplay drafts, immutable revisions and scene sync.",
        icon: ScrollText,
        specialized: true,
      },
      {
        key: "av-scripts",
        title: "AV Scripts",
        singular: "AV script",
        description: "Timed two-column and multi-column scripts.",
        recordType: "av_script",
        icon: FileStack,
      },
      {
        key: "documents",
        title: "General Documents",
        singular: "document",
        description: "Versioned production paperwork, notes and templates.",
        recordType: "document",
        icon: FileStack,
      },
    ],
  },
  {
    key: "breakdown",
    label: "Breakdown",
    modules: [
      {
        key: "scene-breakdown",
        title: "Scene Breakdown",
        singular: "scene breakdown",
        description: "Scene facts, page eighths, timing, overrides and readiness.",
        recordType: "scene_breakdown",
        icon: ListChecks,
      },
      {
        key: "elements",
        title: "Elements",
        singular: "element",
        description: "Cast, props, wardrobe, effects, sound, safety and custom elements.",
        recordType: "element",
        icon: Boxes,
      },
      {
        key: "sides-reports",
        title: "Sides & Reports",
        singular: "report definition",
        description: "Sides, DOOD, breakdown sheets and saved report definitions.",
        recordType: "report_definition",
        icon: ClipboardCheck,
      },
    ],
  },
  {
    key: "visual",
    label: "Visual Planning",
    modules: [
      {
        key: "boards",
        title: "Mood Boards",
        singular: "board",
        description: "Ranked visual references, annotations and approvals.",
        recordType: "board",
        icon: Sparkles,
      },
      {
        key: "storyboards",
        title: "Storyboards",
        singular: "storyboard",
        description: "Stable storyboard frames connected to scenes and shots.",
        recordType: "storyboard",
        icon: Camera,
      },
      {
        key: "shots",
        title: "Shots & Setups",
        singular: "shot list",
        description: "Coverage, camera/lighting setups and technical requirements.",
        recordType: "shot_list",
        icon: Camera,
      },
      {
        key: "technical-look",
        title: "Technical Look Plan",
        singular: "technical plan",
        description: "Camera, lens, light, sound, VFX and colour strategy.",
        recordType: "technical_look_plan",
        icon: Wrench,
      },
    ],
  },
  {
    key: "production-planning",
    label: "Production Planning",
    modules: [
      {
        key: "people",
        title: "Cast & Crew",
        singular: "person",
        description: "Contacts, project roles, availability and confirmations.",
        recordType: "person",
        icon: ContactRound,
      },
      {
        key: "casting",
        title: "Casting",
        singular: "casting role",
        description: "Roles, candidates, auditions, shortlists and bookings.",
        recordType: "casting_role",
        icon: UsersRound,
      },
      {
        key: "locations",
        title: "Locations",
        singular: "location",
        description: "Scouts, holds, permissions, safety and logistics.",
        recordType: "location",
        icon: MapPin,
      },
      {
        key: "budget",
        title: "Budget & Vendors",
        singular: "budget",
        description: "Versioned budgets, quotes, commitments, expenses and variance.",
        recordType: "budget",
        icon: Banknote,
      },
      {
        key: "legal-safety",
        title: "Legal & Safety",
        singular: "requirement",
        description: "Requirements, agreements, permits, insurance, risks and safety plans.",
        recordType: "requirement",
        icon: ShieldCheck,
      },
      {
        key: "equipment",
        title: "Equipment & Resources",
        singular: "equipment item",
        description: "Assets, kits, rentals, reservations, props and wardrobe sourcing.",
        recordType: "equipment_item",
        icon: Boxes,
      },
      {
        key: "logistics",
        title: "Logistics",
        singular: "logistics plan",
        description: "Transport, travel, accommodation, catering and base operations.",
        recordType: "logistics_plan",
        icon: PackageCheck,
      },
    ],
  },
  {
    key: "scheduling",
    label: "Scheduling",
    modules: [
      {
        key: "tasks",
        title: "Tasks & Approvals",
        singular: "task",
        description: "Boards, dependencies, checklists, assignments and approvals.",
        recordType: "task_card",
        icon: CheckCircle2,
      },
      {
        key: "calendar",
        title: "Production Calendar",
        singular: "calendar event",
        description: "Milestones, dependencies, timezone-safe dates and ICS exports.",
        recordType: "calendar_event",
        icon: CalendarDays,
      },
      {
        key: "schedules",
        title: "Schedules & Stripboards",
        singular: "schedule",
        description: "Variants, revisions, strips, conflicts, totals and reports.",
        recordType: "schedule",
        icon: Clock3,
        specialized: true,
      },
      {
        key: "shoot-days",
        title: "Shoot Days",
        singular: "shoot day",
        description: "Pinned schedule revisions and pre-shoot day preparation.",
        recordType: "shoot_day",
        icon: CalendarDays,
        specialized: true,
      },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    modules: [
      {
        key: "communications",
        title: "Communications",
        singular: "message",
        description: "Announcements, direct messages, templates and truthful outbox state.",
        recordType: "message",
        icon: Megaphone,
      },
    ],
  },
  {
    key: "documents",
    label: "Documents",
    modules: [
      {
        key: "files",
        title: "Files & Media",
        singular: "file",
        description: "Private immutable file versions, folders, links and retention.",
        recordType: "file",
        icon: FolderOpen,
      },
      {
        key: "call-sheets",
        title: "Call Sheets",
        singular: "call sheet",
        description: "Recipient-safe drafts, immutable issues and confirmation tracking.",
        recordType: "call_sheet_draft",
        icon: ClipboardCheck,
        specialized: true,
      },
      {
        key: "production-packs",
        title: "Production Packs",
        singular: "production pack",
        description: "Pinned production documents, manifests and issued packages.",
        recordType: "production_pack_draft",
        icon: PackageCheck,
        specialized: true,
      },
      {
        key: "exports-archive",
        title: "Exports & Archive",
        singular: "export",
        description: "Complete project exports and verified outbound NAS archives.",
        recordType: "export_snapshot",
        icon: Archive,
        specialized: true,
      },
    ],
  },
  {
    key: "readiness",
    label: "Readiness",
    modules: [
      {
        key: "readiness",
        title: "Ready to Shoot",
        singular: "readiness evaluation",
        description: "Truthful project and shoot-day gates, overrides and immutable issues.",
        icon: CheckCircle2,
        specialized: true,
      },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    modules: [
      {
        key: "settings",
        title: "Project Settings",
        singular: "setting",
        description: "Project profile, modules, templates and retention policy.",
        icon: Settings,
        specialized: true,
      },
    ],
  },
];

export const allModules = navigationGroups.flatMap((group) => group.modules);

export function findModule(key?: string): ModuleDefinition | undefined {
  return allModules.find((module) => module.key === key);
}
