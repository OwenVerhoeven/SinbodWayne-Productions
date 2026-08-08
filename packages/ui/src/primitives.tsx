import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { AlertCircle, Archive, LoaderCircle, LockKeyhole, WifiOff } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly icon?: ReactNode;
}

export function Button({
  children,
  className = "",
  icon,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button className={`swp-button swp-button--${variant} ${className}`} type={type} {...props}>
      {icon ? (
        <span className="swp-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly children: ReactNode;
}

export function IconButton({
  children,
  className = "",
  label,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={`swp-icon-button ${className}`}
      title={label}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}

export type StatusTone = "neutral" | "info" | "warning" | "success" | "danger" | "purple";

export function Status({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: StatusTone;
}) {
  return <span className={`swp-status swp-status--${tone}`}>{children}</span>;
}

export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="swp-visually-hidden">{children}</span>;
}

export function Wordmark({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span
      aria-label="Sinbod Wayne Productions"
      className={`swp-wordmark${compact ? " swp-wordmark--compact" : ""}`}
    >
      <span>SINBOD WAYNE</span>
      {!compact ? <span>PRODUCTIONS</span> : null}
    </span>
  );
}

export type BoundaryState =
  "loading" | "empty" | "error" | "permission" | "offline" | "archived" | "not-configured";

const boundaryCopy: Record<BoundaryState, { title: string; description: string; icon: ReactNode }> =
  {
    loading: {
      title: "Loading",
      description: "Retrieving the latest production data.",
      icon: <LoaderCircle className="swp-spin" />,
    },
    empty: {
      title: "Nothing here yet",
      description: "Create the first record to begin this part of pre-production.",
      icon: <AlertCircle />,
    },
    error: {
      title: "Could not load this view",
      description: "Try again. The request identifier is available in details.",
      icon: <AlertCircle />,
    },
    permission: {
      title: "Permission denied",
      description: "Your role does not allow access to this information.",
      icon: <LockKeyhole />,
    },
    offline: {
      title: "Offline",
      description: "The last known data remains visible. Eligible drafts will queue locally.",
      icon: <WifiOff />,
    },
    archived: {
      title: "Archived",
      description: "This record is read-only until it is restored.",
      icon: <Archive />,
    },
    "not-configured": {
      title: "Not configured",
      description: "Use the documented manual fallback or configure the optional provider.",
      icon: <AlertCircle />,
    },
  };

export interface SurfaceBoundaryProps extends HTMLAttributes<HTMLDivElement> {
  readonly state: BoundaryState;
  readonly title?: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

export function SurfaceBoundary({
  action,
  className = "",
  description,
  state,
  title,
  ...props
}: SurfaceBoundaryProps) {
  const copy = boundaryCopy[state];
  return (
    <div
      className={`swp-boundary swp-boundary--${state} ${className}`}
      role={state === "error" ? "alert" : "status"}
      {...props}
    >
      <span className="swp-boundary__icon" aria-hidden="true">
        {copy.icon}
      </span>
      <div>
        <h2>{title ?? copy.title}</h2>
        <p>{description ?? copy.description}</p>
      </div>
      {action ? <div className="swp-boundary__action">{action}</div> : null}
    </div>
  );
}

export function ProgressBar({ label, value }: { readonly label: string; readonly value: number }) {
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="swp-progress">
      <div className="swp-progress__label">
        <span>{label}</span>
        <strong>{bounded}%</strong>
      </div>
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={bounded}
        className="swp-progress__track"
        role="progressbar"
      >
        <span style={{ width: `${bounded}%` }} />
      </div>
    </div>
  );
}
