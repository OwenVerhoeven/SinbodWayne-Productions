import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Command,
  Menu,
  Search,
  WifiOff,
  X,
} from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { IconButton, Status, Wordmark } from "@swp/ui";

import { apiRequest } from "../api/client";
import { useAuth } from "../auth/auth-context";
import { navigationGroups } from "./module-catalog";
import { projectListSchema, type ProjectSummary } from "./schemas";
import { CommandPalette } from "./CommandPalette";
import { NotificationDrawer } from "./NotificationDrawer";
import { useOfflineDrafts } from "../offline/useOfflineDrafts";

export function AppShell() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("swp-nav-collapsed") === "true",
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const offline = useOfflineDrafts();

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiRequest("/api/v1/app/projects?limit=100", projectListSchema),
  });

  const activeProject = useMemo(
    () => projects.data?.items.find((project) => project.id === projectId),
    [projectId, projects.data?.items],
  );

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  function changeProject(nextId: string) {
    if (!nextId) {
      void navigate("/projects");
      return;
    }
    void navigate(`/projects/${nextId}/overview`);
  }

  function toggleCollapsed() {
    setCollapsed((value) => {
      localStorage.setItem("swp-nav-collapsed", String(!value));
      return !value;
    });
  }

  return (
    <div className={`app-frame${collapsed ? " app-frame--collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside aria-label="Primary" className={`sidebar${mobileOpen ? " sidebar--open" : ""}`}>
        <div className="sidebar__brand">
          <Link aria-label="Projects" to="/projects">
            <Wordmark compact={collapsed} />
          </Link>
          <IconButton
            className="sidebar__mobile-close"
            label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X />
          </IconButton>
        </div>
        <nav className="sidebar__nav">
          {activeProject ? (
            navigationGroups.map((group) => (
              <div className="nav-group" key={group.key}>
                {!collapsed ? <p className="nav-group__label">{group.label}</p> : null}
                {group.modules.map((module) => {
                  const Icon = module.icon;
                  return (
                    <NavLink
                      className={({ isActive }) => `nav-item${isActive ? " nav-item--active" : ""}`}
                      key={module.key}
                      title={collapsed ? module.title : undefined}
                      to={`/projects/${activeProject.id}/${module.key}`}
                    >
                      <Icon aria-hidden />
                      {!collapsed ? <span>{module.title}</span> : null}
                    </NavLink>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="nav-group">
              <NavLink
                className={({ isActive }) => `nav-item${isActive ? " nav-item--active" : ""}`}
                to="/projects"
              >
                <Command aria-hidden="true" />
                {!collapsed ? <span>Projects</span> : null}
              </NavLink>
            </div>
          )}
        </nav>
        <button className="sidebar__collapse" onClick={toggleCollapsed} type="button">
          {collapsed ? <ChevronsRight aria-hidden="true" /> : <ChevronsLeft aria-hidden="true" />}
          {!collapsed ? (
            <span>Collapse navigation</span>
          ) : (
            <span className="swp-visually-hidden">Expand navigation</span>
          )}
        </button>
      </aside>
      {mobileOpen ? (
        <button
          aria-label="Close navigation"
          className="drawer-scrim"
          onClick={() => setMobileOpen(false)}
          type="button"
        />
      ) : null}
      <header className="topbar">
        <IconButton
          className="topbar__menu"
          label="Open navigation"
          onClick={() => setMobileOpen(true)}
        >
          <Menu />
        </IconButton>
        <label className="project-switcher">
          <span className="swp-visually-hidden">Current project</span>
          <select
            onChange={(event) => changeProject(event.currentTarget.value)}
            value={activeProject?.id ?? ""}
          >
            <option value="">All projects</option>
            {projects.data?.items.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.title}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
        {activeProject ? (
          <div className="topbar__phase">
            <span>{activeProject.phase}</span>
            <Status
              tone={
                activeProject.readinessState === "ready"
                  ? "success"
                  : activeProject.readinessState === "stale"
                    ? "warning"
                    : "danger"
              }
            >
              {activeProject.readinessState.replaceAll("_", " ")}
            </Status>
          </div>
        ) : null}
        {auth.account?.role === "viewer" ? <Status tone="neutral">View only</Status> : null}
        <button className="command-trigger" onClick={() => setCommandOpen(true)} type="button">
          <Search aria-hidden="true" />
          <span>Search production</span>
          <kbd>Ctrl K</kbd>
        </button>
        {!offline.online || offline.drafts.length > 0 ? (
          <div
            className={`offline-indicator${offline.drafts.some((draft) => draft.state === "conflict") ? " offline-indicator--conflict" : ""}`}
            role="status"
          >
            <WifiOff aria-hidden="true" />
            <span>
              {!offline.online
                ? "Offline"
                : `${offline.drafts.length} local draft${offline.drafts.length === 1 ? "" : "s"}`}
            </span>
          </div>
        ) : null}
        <div className="topbar__actions">
          <IconButton label="Open command palette" onClick={() => setCommandOpen(true)}>
            <Search />
          </IconButton>
          <IconButton label="Notifications" onClick={() => setNotificationsOpen(true)}>
            <Bell />
          </IconButton>
          <button
            className="account-menu"
            onClick={() => void auth.signOut()}
            title="Sign out"
            type="button"
          >
            <span aria-hidden="true">{initials(auth.account?.displayName ?? "SW")}</span>
            <span className="account-menu__name">{auth.account?.displayName}</span>
          </button>
        </div>
      </header>
      <main className="workspace" id="main-content" tabIndex={-1}>
        {auth.account?.role === "viewer" ? (
          <div className="read-only-notice" role="status">
            <strong>View-only account</strong>
            <span>
              You can review production content, but you cannot create, edit or delete it.
            </span>
          </div>
        ) : null}
        <Outlet context={{ activeProject }} />
      </main>
      <CommandPalette
        activeProject={activeProject}
        onClose={() => setCommandOpen(false)}
        open={commandOpen}
      />
      <NotificationDrawer onClose={() => setNotificationsOpen(false)} open={notificationsOpen} />
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export interface AppOutletContext {
  readonly activeProject?: ProjectSummary;
}
