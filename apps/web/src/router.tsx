import { createBrowserRouter, Navigate } from "react-router";

import { AppShell } from "./app/AppShell";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { LoginPage } from "./auth/LoginPage";
import { ProjectOverviewPage } from "./overview/ProjectOverviewPage";
import { ProjectListPage } from "./projects/ProjectListPage";
import { ModuleRegistryPage } from "./records/ModuleRegistryPage";
import { ProfessionalScreenplayPage } from "./writing/ProfessionalScreenplayPage";
import { ReadinessPage } from "./readiness/ReadinessPage";
import { ProjectSettingsPage } from "./settings/ProjectSettingsPage";
import { PublicSharePage } from "./shares/PublicSharePage";
import { PrintArtifactPage } from "./print/PrintArtifactPage";
import { NotFoundPage } from "./app/NotFoundPage";
import { FilesPage } from "./files/FilesPage";
import { CallSheetsPage } from "./operations/CallSheetsPage";
import { ProductionPacksPage } from "./operations/ProductionPacksPage";
import { SchedulesPage } from "./operations/SchedulesPage";
import { ShootDaysPage } from "./operations/ShootDaysPage";
import { PlanningControlsPage } from "./planning/PlanningControlsPage";
import { PlanningPrintPage } from "./planning/PlanningPrintPage";
import { ExportsArchivePage } from "./archive/ExportsArchivePage";
import { IdeaBoxPage } from "./creative/IdeaBoxPage";
import { StoryPage } from "./creative/StoryPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/s/:publicId", element: <PublicSharePage /> },
  { path: "/print/planning/:projectId/:area", element: <PlanningPrintPage /> },
  { path: "/print/:artifactType/:artifactId", element: <PrintArtifactPage /> },
  {
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate replace to="/projects" /> },
      { path: "projects", element: <ProjectListPage /> },
      { path: "projects/:projectId/overview", element: <ProjectOverviewPage /> },
      { path: "projects/:projectId/ideas", element: <IdeaBoxPage /> },
      { path: "projects/:projectId/story", element: <StoryPage /> },
      { path: "projects/:projectId/screenplay", element: <ProfessionalScreenplayPage /> },
      { path: "projects/:projectId/readiness", element: <ReadinessPage /> },
      { path: "projects/:projectId/settings", element: <ProjectSettingsPage /> },
      { path: "projects/:projectId/files", element: <FilesPage /> },
      { path: "projects/:projectId/schedules", element: <SchedulesPage /> },
      { path: "projects/:projectId/shoot-days", element: <ShootDaysPage /> },
      { path: "projects/:projectId/call-sheets", element: <CallSheetsPage /> },
      { path: "projects/:projectId/production-packs", element: <ProductionPacksPage /> },
      { path: "projects/:projectId/budget", element: <PlanningControlsPage area="budget" /> },
      {
        path: "projects/:projectId/legal-safety",
        element: <PlanningControlsPage area="legal-safety" />,
      },
      { path: "projects/:projectId/equipment", element: <PlanningControlsPage area="equipment" /> },
      { path: "projects/:projectId/logistics", element: <PlanningControlsPage area="logistics" /> },
      { path: "projects/:projectId/exports-archive", element: <ExportsArchivePage /> },
      { path: "projects/:projectId/:moduleKey", element: <ModuleRegistryPage /> },
    ],
  },
  { path: "*", element: <NotFoundPage /> },
]);
