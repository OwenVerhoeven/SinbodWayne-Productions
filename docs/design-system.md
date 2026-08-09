# Design System

## Direction

Sinbod Wayne Productions is a dense, cinematic working environment: a sibling to Filmcraft Studio, not a clone and not a generic dashboard template. The local Filmcraft source was inspected read-only for legitimate design language. No Filmcraft code, private resource, layout, or trade dress is copied into this repository.

The primary theme is dark only for this release. An incomplete light theme is worse than one complete accessible theme. The visual system avoids film grain, clapperboards, film-strip borders, ornamental motion, oversized bento grids, and imitation StudioBinder composition.

Approved reference concepts belong under `docs/design/approved/` and are design evidence, not test data or literal content requirements.

## Tokens

### Color

| Token                    | Value     | Use                                             |
| ------------------------ | --------- | ----------------------------------------------- |
| `--color-bg`             | `#080d10` | application canvas                              |
| `--color-chrome`         | `#071014` | persistent navigation/top chrome                |
| `--color-bg-raised`      | `#0b1216` | layered workspace background                    |
| `--color-surface`        | `#0e171c` | cards, panels, menus                            |
| `--color-surface-strong` | `#111d22` | active/important working panels                 |
| `--color-line`           | `#26343a` | default dividers and fields                     |
| `--color-line-strong`    | `#3a4649` | selected/focused structure                      |
| `--color-text`           | `#edf1ef` | primary content                                 |
| `--color-text-muted`     | `#89969b` | supporting content; verify contrast by size/use |
| `--color-accent`         | `#e5ad42` | restrained primary action/attention             |
| `--color-info`           | `#51c4c7` | informational state                             |
| `--color-success`        | `#83c968` | confirmed/pass state                            |
| `--color-danger`         | `#e0665d` | blocker/destructive state                       |
| `--color-special`        | `#b47bd5` | revision/special state                          |

Use semantic foreground/background pairs tested to WCAG contrast. Status always includes text and/or an icon; color alone is never meaning.

### Type

- **Inter**: interface/body/data, self-hosted and subset deliberately.
- **Barlow Condensed**: product wordmark and editorial/project headings.
- **Courier Prime**: screenplay content and screenplay-specific print.

Fallback stacks preserve metrics where possible. Operational tables never shrink below a readable working size to fit columns; columns select/collapse instead.

### Shape, spacing, and elevation

- Base radius: 4px. Pills are reserved for compact status/filter semantics.
- Spacing follows a 4px base: 4, 8, 12, 16, 20, 24, 32, 40, 48.
- Layering uses small color/elevation differences and thin dividers. Avoid luminous shadows and glass effects.
- Focus is a high-contrast 2px outline with offset, never removed.
- Motion is brief and functional for drawer/menu/state transitions and disabled under `prefers-reduced-motion`.

## Application shell

### Desktop, 1280px and wider

- Fixed grouped left navigation, approximately 196px expanded and 72px collapsed.
- Top workspace bar approximately 70px high.
- Project phase and readiness remain visible in the project header/top context.
- Main content uses a wide working canvas with bounded reading widths only for prose/editor content.
- Object header supplies breadcrumb, status, recent change, object actions and command palette entry.

### Compact desktop/tablet, 1024–1279px

- Navigation becomes a compact rail.
- Secondary inspectors may collapse to tabs/drawers while the primary task remains visible.
- Dense tables offer column selection and row detail instead of horizontal trapping.

### Below 1024px

- Navigation is a modal drawer, max 304px or 88vw.
- Useful primary actions move to a reachable bottom action area.
- Data grids become selected-column lists/cards with a deliberate detail view; they do not simply overflow the viewport.
- Call-sheet recipient, scout, task, sides, approval and readiness flows are first-class phone experiences.

### Screenplay workspace

- Wide layout: approximately 300px scene outline, `minmax(560px, 1fr)` editor, 460px inspector/comments/sync panel.
- Tablet: editor plus one secondary panel.
- Phone: explicit Outline / Script / Notes or Sync tabs, with draft/save/conflict state persistent.

## Navigation groups

Group modules rather than exposing a flat list:

1. Overview
2. Development
3. Writing
4. Breakdown
5. Visual Planning
6. Production Planning
7. Scheduling
8. Operations
9. Documents
10. Readiness
11. Settings

Each group supports stable deep links and permission-aware results. Later lifecycle phases remain labels, not placeholder navigation.

## Core component language

- **Buttons:** primary amber action is scarce; neutral surface actions are default; danger requires clear wording and often typed confirmation. Icon-only buttons have accessible names and tooltips.
- **Status chips:** icon + label + semantic color. `Not configured`, `Stale`, `Archived`, `Conflict`, `Denied`, `Blocked`, `Warning`, `Ready`, and provider-evidence states are distinct.
- **Tables:** sticky header where useful, comfortable row hit areas, selectable columns, stable sorting, filters, cursor paging, keyboard row actions and mobile alternate view.
- **Forms:** visible labels, optional/required cues, descriptions, inline errors connected by semantics, safe unsaved/conflict handling, and no placeholder-only labels.
- **Dialogs/menus/popovers:** trapped/restored focus where modal, escape behavior, outside-click care, screen-reader naming and collision-safe viewport placement.
- **Tabs:** real tab semantics and roving keyboard focus; URL state for primary views.
- **Toasts:** supplement inline durable status; never the only record of success/failure.
- **File controls:** accessible browse/drop target, keyboard alternative, type/size policy before selection, progress/retry/cancel and quarantine/not-configured states.
- **Ranked lists/boards:** drag may enhance, but Move before/after/to group and keyboard actions are always available.
- **Readiness rows:** rule/status/owner/due/source/evidence/resolution in one scannable line; details never hide missing data.

## Page patterns

### Operational list

Project header → saved filters/search/actions → dense table/list → selection/bulk bar → paged footer. Empty, filtered-empty, error, denied, archived and offline variants use truthful actions.

### Editor/detail

Object header → primary content → structured inspector/links/activity. Save state names `Saved`, `Saving`, `Offline draft`, `Conflict`, or a recoverable error; it never implies a revision was issued.

### Overview/dashboard

Use concise status groups and actionable lists for script sync, breakdown gaps, people/location/resource confirmations, budget variance, legal/safety blockers, schedule conflicts, overdue tasks, call confirmations, readiness and archive health. Values come from the API and link to their evidence.

### Public recipient/share

Minimal brand header, explicit document/purpose/expiry, no workspace navigation, no account identity enumeration, one recipient's permitted content only, readable phone layout, accessible confirmation and safe expired/revoked states.

### Readiness control centre

Persistent overall state and issue version; category/day filters; blocker/warning/unavailable/pass summaries; detailed rows with source/resolution; policy-aware override action; issue/stale history and deterministic certificate preview.

## Required state language

- **Loading:** skeleton sized like the final content; no fake values.
- **Empty:** explains the true absence and offers an authorized next action.
- **Filtered empty:** distinguishes no match from no data.
- **Error:** stable message/request ID and retry where safe.
- **Conflict:** current/base/incoming comparison with preserve/copy/resolve actions.
- **Archived:** visible read-only context plus restore if authorized.
- **Permission denied:** no sensitive object existence or data leakage.
- **Offline:** explicit connectivity/draft scope and unsupported-action explanation.
- **Not configured:** names the absent adapter and shows the manual fallback.
- **Issued/immutable:** read-only with pins, integrity and supersede/correct action.
- **Stale:** identifies the exact changed dependencies.

## Accessibility requirements

- Core workflows target WCAG 2.2 AA.
- Page landmarks and heading hierarchy are stable across routes.
- Skip link, visible focus, logical tab order and deterministic focus after navigation/dialog/save/error.
- Tables have accessible names, header associations and a usable small-screen alternative.
- Forms expose errors programmatically and do not erase values on server validation.
- Menus, tabs, comboboxes, dialogs and toasts use established accessible interaction patterns.
- Touch targets are comfortably sized and do not overlap.
- Charts/matrices have text/table equivalents.
- Live updates announce concise changes without flooding assistive technology.
- All drag gestures have button/menu and keyboard alternatives.
- Reduced motion is respected and focus/meaning never depends on animation.

## Print system

Print routes are separate deterministic URLs with a pinned source and explicit `paper=A4|Letter`, orientation, selected fields, branding and watermark. Issued documents never print from a changing live editor state.

Rules include:

- no application chrome or accidental controls;
- embedded/self-hosted fonts with stable metrics;
- safe image sizing and repeatable table headers;
- controlled `break-before`, `break-after`, `break-inside`, widows/orphans and trailing-page behavior;
- screenplay formatting through Courier Prime and screenplay-specific margins;
- recipient variant selected server-side before HTML generation;
- long names/notes, confidential markings, images and empty sections covered by fixtures;
- A4 and Letter screenshots/PDF inspection for calls, sides, schedules, budgets, boards, packs and readiness.

## Design review checklist

- Is this an operational tool or an ornamental card layout?
- Is phase/readiness and save/issue state unambiguous?
- Does every control work, have a permission model, and handle failure?
- Can keyboard/touch users complete the action without drag?
- Is sensitive/private data absent from unauthorized markup, not merely hidden?
- Are compact, mobile, offline, conflict, archived, unconfigured and print states designed?
- Does the screen stay visually related to the documented Filmcraft-family tokens without copying a source layout?

## Guided module workbooks

Registry-backed create and edit flows use a shared guided-workbook pattern instead of a flat field dump. Each module defines its own filmmaking questions, section order, outcome statement and plain-language decision states. The interface shows overall and per-section completion while keeping notes and optional production detail available without making every field feel mandatory.

The reference concept is stored at `docs/design/guided-workbook-concept.png`. The implemented version deliberately uses the existing wide editor drawer and section accordions so it preserves established CRUD, optimistic-conflict and offline-draft behavior. Purpose-built workspaces such as screenplay, schedule, call sheet and readiness retain their specialised interfaces.
