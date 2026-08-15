import type { ComponentType } from "react";
import { BookOpenText, Film, Lightbulb, ScrollText } from "lucide-react";

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

/**
 * The launch workspace deliberately exposes only the four creative tools below.
 * The wider pre-production routes and data remain intact so this product focus
 * does not destroy work or weaken server-side authorization.
 */
export const navigationGroups: readonly NavigationGroup[] = [
  {
    key: "creative-studio",
    label: "Creative studio",
    modules: [
      {
        key: "overview",
        title: "Project Overview",
        singular: "overview",
        description: "A calm starting point for the project's creative work.",
        icon: Film,
        specialized: true,
      },
      {
        key: "ideas",
        title: "Idea Box",
        singular: "idea",
        description: "Capture sparks, rank the strongest ideas and develop them further.",
        icon: Lightbulb,
        specialized: true,
      },
      {
        key: "story",
        title: "The Story",
        singular: "story",
        description: "Write the story in a focused document with a practical story compass.",
        icon: BookOpenText,
        specialized: true,
      },
      {
        key: "screenplay",
        title: "Screenplay",
        singular: "screenplay",
        description: "A structured, revision-safe professional screenplay workspace.",
        icon: ScrollText,
        specialized: true,
      },
    ],
  },
];

export const allModules = navigationGroups.flatMap((group) => group.modules);

export function findModule(key?: string): ModuleDefinition | undefined {
  return allModules.find((module) => module.key === key);
}
