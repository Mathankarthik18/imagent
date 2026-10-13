import { useEffect } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { useAppState } from "./state";

/** Project of the current URL (/p/:projectId/…), or "" outside a project. */
export function currentProject(pathname = window.location.pathname): string {
  const m = pathname.match(/^\/p\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** A path inside the current project: pp("/traces") → "/p/bosun-all/traces". */
export function pp(path: string, project = currentProject()): string {
  if (!project) return path;
  const base = `/p/${encodeURIComponent(project)}`;
  return path === "/" ? base : `${base}${path}`;
}

/** Route wrapper for /p/:projectId — every page below reads the project from app state. */
export function ProjectScope() {
  const { projectId = "" } = useParams();
  const { project, setProject } = useAppState();
  useEffect(() => {
    if (projectId && projectId !== project) setProject(projectId);
  }, [projectId, project, setProject]);
  return projectId === project ? <Outlet key={projectId} /> : null;
}

/** Old links (/traces/…, /experiments/…) → the same page in the last-used project. */
export function LegacyRedirect() {
  const { project } = useAppState();
  const { pathname, search } = useLocation();
  return <Navigate to={project ? `${pp(pathname, project)}${search}` : "/"} replace />;
}
