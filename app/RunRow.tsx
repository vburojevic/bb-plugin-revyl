import { useState } from "react";
import { experimental_useAppPanel as useAppPanel } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Run } from "../src/model";
import { isActive } from "../src/shared";
import { ConfirmSpend, MINUTES_NOTE } from "./ConfirmSpend";
import { REPORT_TAB, STATUS_LABEL, errorMessage, formatAgo, formatDuration, progressLabel, statusGlyph } from "./format";
import { useRevylRpc } from "./hooks";

export function StatusGlyph({ status, className }: { status: Run["status"]; className?: string }) {
  const glyph = statusGlyph(status);
  return (
    <Icon
      name={glyph.icon}
      fallback={glyph.fallback}
      aria-label={STATUS_LABEL[status]}
      className={cn("size-4 shrink-0", glyph.tone, glyph.spin && "animate-spin", className)}
    />
  );
}

function IconAction({
  label,
  icon,
  fallback,
  onClick,
  disabled,
}: {
  label: string;
  icon: string;
  fallback: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon name={icon} fallback={fallback} className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function useOpenReport() {
  const panel = useAppPanel();
  return (run: Pick<Run, "taskId" | "kind" | "name">) => {
    if (run.taskId === null) return false;
    return panel.openTab({
      tab: REPORT_TAB,
      params: { taskId: run.taskId, kind: run.kind, name: run.name },
      title: run.name ?? (run.kind === "workflow" ? "Workflow report" : "Test report"),
    });
  };
}

/** Which step a failed test stopped at, and Revyl's reason, in two quiet lines. */
export function FailureNote({ failure, className }: { failure: NonNullable<Run["failure"]>; className?: string }) {
  return (
    <div className={cn("mt-0.5 text-xs", className)}>
      <p className="truncate text-foreground" title={failure.description ?? undefined}>
        Failed at step {failure.step}
        {failure.description ? `: ${failure.description}` : ""}
      </p>
      {failure.reason ? (
        <p className="line-clamp-2 text-muted-foreground" title={failure.reason}>
          {failure.reason}
        </p>
      ) : null}
    </div>
  );
}

/** One run in the composer card or on the page. */
export function RunRow({
  run,
  threadId,
  showActions = true,
  onOpenReport,
}: {
  run: Run;
  threadId: string | null;
  showActions?: boolean;
  /** Where "Open report" goes; the thread's side panel by default. */
  onOpenReport?: (target: Pick<Run, "taskId" | "kind" | "name">) => void;
}) {
  const rpc = useRevylRpc();
  const openPanelReport = useOpenReport();
  const openReport = (target: Pick<Run, "taskId" | "kind" | "name">) =>
    onOpenReport === undefined ? openPanelReport(target) : onOpenReport(target);
  const [busy, setBusy] = useState<"rerun" | "cancel" | null>(null);
  const active = isActive(run.status);
  const progress = progressLabel(run);
  const duration = formatDuration(run.durationSeconds);
  // A build is told apart by its profile; the app it built goes beside it.
  const isBuild = run.kind === "build";
  const kindLabel = run.kind === "workflow" ? "Workflow" : isBuild ? run.name : "Test";
  const name = isBuild ? (run.profile ? `${run.profile} build` : "Cloud build") : (run.name ?? kindLabel);
  const lost = run.status === "lost";
  const detail = [
    STATUS_LABEL[run.status],
    active ? progress : duration,
    run.buildVersion === null ? null : `build ${run.buildVersion}`,
    isBuild && run.branchName !== null ? `branch ${run.branchName}` : null,
    active ? null : formatAgo(run.finishedAt ?? run.updatedAt),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const act = async (kind: "rerun" | "cancel") => {
    setBusy(kind);
    try {
      await rpc.call(kind, { threadId, key: run.key });
      if (kind === "rerun") toast.success(`Started ${name} again`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bbrv-run-row group flex min-w-0 items-start gap-2.5 py-2">
      <StatusGlyph status={run.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("min-w-0 truncate text-sm font-medium", lost ? "text-muted-foreground" : "text-foreground")}>{name}</span>
          {kindLabel === null ? null : <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{kindLabel}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
        {/* A build's error carries Revyl's suggested fix after it, so it is shown whole. */}
        {run.error !== null && (active || isBuild) ? (
          <div className={cn("mt-0.5 break-words text-xs text-destructive-text", !isBuild && "line-clamp-2")} title={run.error}>
            {run.error}
          </div>
        ) : null}
        {run.kind === "test" && run.status === "failed" && run.failure ? <FailureNote failure={run.failure} /> : null}
        {run.kind === "workflow" && run.children.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {run.children.map((child) => (
              <li key={child.taskId} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <StatusGlyph status={child.status} className="size-3.5" />
                <button
                  type="button"
                  className="truncate text-left hover:text-foreground hover:underline"
                  onClick={() => openReport({ taskId: child.taskId, kind: "test", name: child.name })}
                >
                  {child.name ?? "Test"}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {showActions ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {run.taskId !== null && run.kind !== "build" ? <IconAction label="Open report" icon="FileText" fallback="File" onClick={() => openReport(run)} /> : null}
          {active ? (
            <IconAction label="Cancel run" icon="Square" fallback="X" disabled={busy !== null || run.taskId === null} onClick={() => act("cancel")} />
          ) : run.kind !== "build" && (run.targetId !== null || run.name !== null) ? (
            <ConfirmSpend
              spends
              title={`Run ${name} again?`}
              description={`${run.kind === "test" && run.buildVersion !== null ? `It reuses build ${run.buildVersion}. ` : ""}${MINUTES_NOTE}`}
              confirmLabel="Run again"
              onConfirm={() => void act("rerun")}
            >
              {(open) => <IconAction label="Run again" icon="ArrowReloadHorizontal" fallback="RotateCcw" disabled={busy !== null} onClick={open} />}
            </ConfirmSpend>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
