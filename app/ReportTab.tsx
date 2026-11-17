import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { UrlLink } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ReportStep, TestReport, WorkflowReport } from "../src/model";
import { isActive } from "../src/shared";
import { STATUS_LABEL, errorMessage, formatDuration } from "./format";
import { useRevylRpc, useThreadRuns } from "./hooks";
import { RunRow, StatusGlyph, useOpenReport } from "./RunRow";

const TASK_ID = /^[0-9a-f-]{36}$/i;

function readParams(params: unknown): { taskId: string; kind: "test" | "workflow"; name: string | null } | null {
  if (params === null || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const taskId = typeof record.taskId === "string" && TASK_ID.test(record.taskId) ? record.taskId : null;
  if (taskId === null) return null;
  const name = typeof record.name === "string" ? record.name.slice(0, 200) : null;
  return { taskId, kind: record.kind === "workflow" ? "workflow" : "test", name };
}

/** Side panel tab: one run's full report, or the thread's runs to pick from. */
export function ReportTab({ threadId, params }: ExperimentalThreadActionTabProps) {
  const target = readParams(params);
  return (
    <TooltipProvider delayDuration={300}>
      {target === null ? (
        <ThreadRunsHub threadId={threadId} />
      ) : target.kind === "workflow" ? (
        <WorkflowReportView taskId={target.taskId} name={target.name} />
      ) : (
        <TestReportView taskId={target.taskId} />
      )}
    </TooltipProvider>
  );
}

function ThreadRunsHub({ threadId }: { threadId: string }) {
  const { data, error } = useThreadRuns(threadId);
  return (
    <ReportFrame>
      <h2 className="text-base font-semibold text-foreground">Revyl runs in this thread</h2>
      {data === null ? (
        error === null ? <Skeleton className="h-16 w-full" /> : <p role="alert" className="text-sm text-destructive-text">{error}</p>
      ) : data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No runs yet. When an agent here runs `revyl test run` or `revyl workflow run`, the run shows up here and above the composer.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {data.runs.map((run) => (
            <RunRow key={run.key} run={run} threadId={threadId} />
          ))}
        </div>
      )}
    </ReportFrame>
  );
}

function useReport<T>(load: () => Promise<T>, key: string, poll: (value: T) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++generation.current;
    load().then(
      (value) => {
        if (mine !== generation.current) return;
        setData(value);
        setError(null);
      },
      (cause: unknown) => {
        if (mine === generation.current) setError(errorMessage(cause));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    setData(null);
    refetch();
  }, [refetch]);
  const polling = data !== null && poll(data);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(refetch, 5_000);
    return () => clearInterval(timer);
  }, [polling, refetch]);
  return { data, error, refetch };
}

function ReportFrame({ children }: { children: React.ReactNode }) {
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto w-full max-w-2xl space-y-4 p-4">{children}</div></div>;
}

function LoadingReport() {
  return (
    <ReportFrame>
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mx-auto h-80 w-48 rounded-xl" />
      <Skeleton className="h-16 w-full" />
    </ReportFrame>
  );
}

function ErrorReport({ message, retry }: { message: string; retry: () => void }) {
  return (
    <ReportFrame>
      <div role="alert" className="rounded-lg border border-border p-4 text-sm">
        <p className="font-medium text-foreground">The report could not be loaded</p>
        <p className="mt-1 text-muted-foreground">{message}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={retry}>
          Try again
        </Button>
      </div>
    </ReportFrame>
  );
}

export function TestReportView({ taskId }: { taskId: string }) {
  const rpc = useRevylRpc();
  const { data: report, error, refetch } = useReport<TestReport>(
    () => rpc.call("test_report", { taskId }),
    taskId,
    (value) => isActive(value.status),
  );
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [expired, setExpired] = useState(false);

  // Presigned media links last an hour; fetch fresh ones just before they lapse.
  useEffect(() => {
    if (report?.mediaExpiresInSeconds == null) return;
    const ms = Math.max(5_000, (report.mediaExpiresInSeconds - 60) * 1000);
    const timer = setTimeout(() => {
      setExpired(false);
      refetch();
    }, ms);
    return () => clearTimeout(timer);
  }, [report?.mediaExpiresInSeconds, refetch]);

  if (report === null) return error === null ? <LoadingReport /> : <ErrorReport message={error} retry={refetch} />;

  const activeStep = report.steps.find(
    (step) => step.videoStart !== null && step.videoEnd !== null && time >= step.videoStart && time < step.videoEnd,
  );
  const seek = (step: ReportStep) => {
    if (video.current === null || step.videoStart === null) return;
    video.current.currentTime = step.videoStart;
    void video.current.play().catch(() => undefined);
  };
  // Duration first, beside the status, so a wrap only pushes the device facts down.
  const facts = [
    formatDuration(report.durationSeconds),
    report.deviceModel,
    report.osVersion,
    report.buildVersion === null ? null : `build ${report.buildVersion}`,
  ].filter((fact): fact is string => fact !== null);

  return (
    <ReportFrame>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <StatusGlyph status={report.status} />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{report.testName ?? "Test run"}</h2>
          {report.reportUrl === null ? null : (
            <UrlLink href={report.reportUrl} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
              Open in Revyl
            </UrlLink>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {STATUS_LABEL[report.status]} · {report.passedSteps} of {report.totalSteps} steps passed
          {facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}
        </p>
      </header>

      {report.videoUrl === null ? (
        <div className="bbrv-stream-frame grid h-48 place-items-center rounded-xl text-sm text-muted-foreground">
          {isActive(report.status) ? "The video appears when the run finishes." : "This run has no video."}
        </div>
      ) : expired ? (
        <div className="bbrv-stream-frame grid h-48 place-items-center rounded-xl text-sm">
          <Button variant="outline" size="sm" onClick={() => { setExpired(false); refetch(); }}>
            Reload video
          </Button>
        </div>
      ) : (
        <video
          ref={video}
          key={report.videoUrl}
          src={report.videoUrl}
          controls
          playsInline
          preload="metadata"
          aria-label={`Recording of ${report.testName ?? "the run"}`}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onError={() => setExpired(true)}
          className="bbrv-stream-frame mx-auto max-h-[28rem] w-auto max-w-full rounded-xl"
        />
      )}

      {report.summary === null && report.insights.length === 0 ? null : (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium text-foreground">Summary</h3>
          {report.summary === null ? null : <p className="text-sm text-foreground">{report.summary}</p>}
          {report.insights.map((insight) => (
            <p key={insight} className="text-sm text-muted-foreground">
              {insight}
            </p>
          ))}
        </section>
      )}

      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">Steps</h3>
        <ol className="divide-y divide-border">
          {report.steps.map((step) => (
            <StepRow key={step.index} step={step} active={step === activeStep} onSeek={() => seek(step)} canSeek={report.videoUrl !== null} />
          ))}
        </ol>
      </section>
    </ReportFrame>
  );
}

function stepStatusForGlyph(status: ReportStep["status"]) {
  switch (status) {
    case "passed":
      return "passed" as const;
    case "failed":
      return "failed" as const;
    case "running":
      return "running" as const;
    case "warning":
      return "timeout" as const;
    default:
      return "queued" as const;
  }
}

function StepRow({ step, active, onSeek, canSeek }: { step: ReportStep; active: boolean; onSeek: () => void; canSeek: boolean }) {
  const [open, setOpen] = useState(step.status === "failed");
  return (
    <li className={cn("py-2", active && "bbrv-step-active rounded-md")}>
      <div className="flex items-start gap-2.5 px-1">
        <StatusGlyph status={stepStatusForGlyph(step.status)} className="mt-0.5" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="block text-sm text-foreground">{step.description || "Step"}</span>
          <span className="block text-xs text-muted-foreground">
            {step.type === "validation" ? "Check" : step.type === "instruction" || step.type === "instructions" ? "Action" : step.type}
            {step.videoStart === null ? "" : ` · ${formatClock(step.videoStart)}`}
          </span>
        </button>
        {canSeek && step.videoStart !== null ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Play from step ${step.index + 1}`}
            onClick={onSeek}
          >
            <Icon name="Play" fallback="ChevronRight" className="size-4" />
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 flex gap-3 pl-7 pr-1">
          {step.screenshotUrl === null ? null : (
            <img
              src={step.screenshotUrl}
              alt={`Screen before: ${step.description}`}
              loading="lazy"
              className="bbrv-stream-frame h-40 w-auto shrink-0 rounded-md"
            />
          )}
          {step.reasoning === null ? null : (
            <p className={cn("text-xs leading-relaxed", step.status === "failed" ? "text-foreground" : "text-muted-foreground")}>
              {step.reasoning}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function WorkflowReportView({
  taskId,
  name = null,
  onOpenTest,
}: {
  taskId: string;
  name?: string | null;
  onOpenTest?: (taskId: string, name: string | null) => void;
}) {
  const rpc = useRevylRpc();
  const openPanelReport = useOpenReport();
  const openReport = (run: { taskId: string; kind: "test"; name: string | null }) =>
    onOpenTest === undefined ? openPanelReport(run) : onOpenTest(run.taskId, run.name);
  const { data: report, error, refetch } = useReport<WorkflowReport>(
    () => rpc.call("workflow_report", { taskId, name }),
    taskId,
    (value) => isActive(value.status),
  );
  if (report === null) return error === null ? <LoadingReport /> : <ErrorReport message={error} retry={refetch} />;
  return (
    <ReportFrame>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <StatusGlyph status={report.status} />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{report.name ?? "Workflow run"}</h2>
          {report.reportUrl === null ? null : (
            <UrlLink href={report.reportUrl} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
              Open in Revyl
            </UrlLink>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {STATUS_LABEL[report.status]} · {report.passed} passed · {report.failed} failed · {report.total} tests
          {report.durationLabel === null ? "" : ` · ${report.durationLabel}`}
        </p>
      </header>
      <ul className="divide-y divide-border">
        {report.tests.map((test) => (
          <li key={test.taskId} className="flex items-center gap-2.5 py-2">
            <StatusGlyph status={test.status} />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{test.name ?? "Test"}</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => openReport({ taskId: test.taskId, kind: "test", name: test.name })}
            >
              Report
            </Button>
          </li>
        ))}
      </ul>
    </ReportFrame>
  );
}
