import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { UrlLink } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { isActive } from "../src/shared";
import { formatDuration, runSummary } from "./format";
import { useRun } from "./hooks";
import { StatusGlyph, useOpenReport } from "./RunRow";
import { DeviceDirective } from "./DeviceDirective";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `::revyl{task="<task_id>"}` in an assistant reply: a live card for one run.
 * `::revyl{device="<session_id>"}` shows a device instead (DeviceDirective).
 * Attributes are untrusted; only a well-formed task id is used.
 */
export function RevylDirective({ attributes, message }: PluginMessageDirectiveProps) {
  if (attributes.device !== undefined) {
    return <DeviceDirective device={attributes.device} shot={attributes.shot} threadId={message.threadId} />;
  }
  const taskId = attributes.task ?? attributes.taskId ?? "";
  if (!TASK_ID.test(taskId)) {
    return <span className="text-xs text-muted-foreground">Revyl run: missing or invalid task id.</span>;
  }
  const kind = attributes.kind === "workflow" ? "workflow" : attributes.kind === "test" ? "test" : null;
  return <DirectiveCard taskId={taskId.toLowerCase()} kind={kind} threadId={message.threadId} />;
}

function DirectiveCard({ taskId, kind, threadId }: { taskId: string; kind: "test" | "workflow" | null; threadId: string | null }) {
  const { data: run, error, loading } = useRun(taskId, kind, threadId);
  const openReport = useOpenReport();

  if (run === null) {
    return (
      <div className="my-2 rounded-lg border border-border p-3">
        {loading && error === null ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{error ?? "Revyl has no run with this id."}</p>
        )}
      </div>
    );
  }

  const active = isActive(run.status);
  const facts = [
    run.kind === "workflow" ? "Workflow" : "Test",
    run.done !== null && run.total !== null ? `${run.done}/${run.total} ${run.kind === "workflow" ? "tests" : "steps"}` : null,
    run.buildVersion === null ? null : `build ${run.buildVersion}`,
    active ? null : formatDuration(run.durationSeconds),
  ].filter((fact): fact is string => fact !== null);
  const percent = run.done !== null && run.total ? Math.round((run.done / run.total) * 100) : null;
  const reportUrl = `https://app.revyl.ai/${run.kind === "workflow" ? "workflows" : "tests"}/report?taskId=${taskId}`;

  return (
    <div className="my-2 rounded-lg border border-border p-3" data-revyl-task={taskId}>
      <div className="flex items-start gap-2.5">
        <StatusGlyph status={run.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{runSummary(run)}</p>
          <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <UrlLink href={reportUrl} className="text-xs text-muted-foreground hover:text-foreground">
            Open in Revyl
          </UrlLink>
          <Button size="sm" variant="outline" onClick={() => openReport({ taskId, kind: run.kind, name: run.name })}>
            Report
          </Button>
        </div>
      </div>
      {active && percent !== null ? <Progress value={percent} className="mt-2.5 h-1" aria-label="Run progress" /> : null}
      {run.kind === "workflow" && run.children.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2">
          {run.children.map((child) => (
            <li key={child.taskId} className="flex items-center gap-2 text-xs">
              <StatusGlyph status={child.status} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{child.name ?? "Test"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
