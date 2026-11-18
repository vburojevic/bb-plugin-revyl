import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbContext } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BrowserScope, Catalog, HistoryEntry, Run, RunKind, TestSummary } from "../src/model";

/** What the page can start: tests and workflows. */
type StartKind = Exclude<RunKind, "build">;
import { ConfirmSpend, MINUTES_NOTE } from "./ConfirmSpend";
import { STATUS_LABEL, errorMessage, formatWhen } from "./format";
import { minutesLeftLabel, useBilling, useCliStatus, usePageRuns, useRevylRpc } from "./hooks";
import { TestReportView, WorkflowReportView } from "./ReportTab";
import { RunRow, StatusGlyph } from "./RunRow";
import { SetupNotice } from "./SetupNotice";

type Selected = { taskId: string; kind: RunKind; name: string | null };

const ORG = "__org__";

/** The Revyl page in bb's sidebar: browse, run and read reports. */
export function BrowserPage() {
  const { projectId } = useBbContext();
  const rpc = useRevylRpc();
  const status = useCliStatus();
  const pageRuns = usePageRuns();
  // bb gives this page no current project, so it offers the projects whose
  // repos have Revyl files, defaulting to the current one when it is linked.
  const [linked, setLinked] = useState<Array<{ id: string; name: string }> | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("linked_projects", {}).then(
      (value) => setLinked(value.projects),
      () => setLinked([]),
    );
  }, [rpc]);
  const defaultTarget =
    linked === null ? null : (linked.find((project) => project.id === projectId) ?? linked[0])?.id ?? ORG;
  const target = picked ?? defaultTarget;
  const scope: BrowserScope = target === ORG ? "org" : "project";
  const scopeProjectId = target === ORG ? null : target;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);

  const load = useCallback(
    (force = false) => {
      if (target === null) return;
      setRefreshing(true);
      rpc
        .call("catalog", { scope, projectId: scopeProjectId, force })
        .then(
          (value) => {
            setCatalog(value);
            setError(null);
          },
          (cause: unknown) => setError(errorMessage(cause)),
        )
        .finally(() => setRefreshing(false));
    },
    [rpc, scope, scopeProjectId, target],
  );
  const connected = status.data?.state === "ready";
  // Load again once Revyl connects, so an error from before the key went in clears.
  useEffect(() => load(), [load, connected]);

  const start = async (kind: StartKind, targetId: string, name: string) => {
    try {
      const run = await rpc.call("start_run", { threadId: null, kind, targetId, name, projectId: scopeProjectId });
      toast.success(`Started ${name}`);
      pageRuns.refetch();
      if (run.taskId !== null) setSelected({ taskId: run.taskId, kind, name });
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  const testsByApp = useMemo(() => {
    const groups = new Map<string, { name: string; tests: TestSummary[] }>();
    for (const test of catalog?.tests ?? []) {
      const key = test.appId ?? "none";
      const group = groups.get(key) ?? { name: test.appName ?? "No app", tests: [] };
      group.tests.push(test);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog]);

  const ready = status.data?.state === "ready";
  const billing = useBilling(ready);
  const recentRuns: Run[] = pageRuns.data?.runs ?? [];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border grid w-full max-w-6xl gap-6 px-4 pb-6 pt-3 md:px-5 md:pt-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-5">
            <div className="flex items-center gap-2">
              <Select value={target ?? undefined} onValueChange={(value) => { setPicked(value); setSelected(null); }}>
                <SelectTrigger className="h-8 w-56" aria-label="Which tests to show">
                  <SelectValue placeholder="Loading projects…" />
                </SelectTrigger>
                <SelectContent>
                  {(linked ?? []).map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={ORG}>All apps in the org</SelectItem>
                </SelectContent>
              </Select>
              <span className="min-w-0 flex-1" />
              {status.data?.orgName == null ? null : (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`Revyl org: ${status.data.orgName}`}>
                  <Icon name="revyl/revyl" fallback="Building" className="size-3.5 shrink-0" />
                  <span className="sr-only">Revyl org: </span>
                  <span className="truncate">{status.data.orgName}</span>
                  {billing?.iosMinutesLeft != null ? (
                    <span className="shrink-0 tabular-nums" title={minutesLeftLabel(billing) ?? undefined}>
                      · {Math.floor(billing.iosMinutesLeft).toLocaleString()} min left
                    </span>
                  ) : null}
                </span>
              )}
              <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh tests and workflows" disabled={refreshing} onClick={() => load(true)}>
                <Icon name="ArrowReloadHorizontal" fallback="RotateCcw" className={cn("size-4", refreshing && "animate-spin")} />
              </Button>
            </div>

            {status.data !== null && (!ready || status.data.machineSignedIn) ? <SetupNotice status={status.data} onRecheck={() => void status.recheck()} rechecking={status.refreshing} /> : null}
            {catalog?.fallbackReason == null ? null : (
              <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                Showing all apps. {catalog.fallbackReason}
              </p>
            )}
            {error !== null && ready ? <p role="alert" className="text-sm text-destructive-text">{error}</p> : null}

            {recentRuns.length === 0 ? null : (
              <section className="space-y-2">
                <SectionTitle>Started here</SectionTitle>
                <div className="divide-y divide-border rounded-lg border border-border px-3">
                  {recentRuns.slice(0, 5).map((run) => (
                    <RunRow
                      key={run.key}
                      run={run}
                      threadId={null}
                      onOpenReport={(target) =>
                        target.taskId === null ? undefined : setSelected({ taskId: target.taskId, kind: target.kind, name: target.name })
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            {catalog === null ? (
              error === null ? (
                <div className="space-y-2">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : null
            ) : (
              <>
                <section className="space-y-2">
                  <SectionTitle>Workflows</SectionTitle>
                  {catalog.workflows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No workflows. Create one with `revyl workflow create`.</p>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {catalog.workflows.map((workflow) => (
                        <CatalogRow
                          key={workflow.id}
                          kind="workflow"
                          id={workflow.id}
                          name={workflow.name}
                          detail={workflow.testIds === null ? "Workflow" : `${workflow.testIds.length} tests`}
                          canRun={ready}
                          onStart={() => void start("workflow", workflow.id, workflow.name)}
                          onOpen={(taskId) => setSelected({ taskId, kind: "workflow", name: workflow.name })}
                          selectedTaskId={selected?.taskId ?? null}
                        />
                      ))}
                    </ul>
                  )}
                </section>
                {testsByApp.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tests yet. Create one with `revyl test create`.</p>
                ) : (
                  testsByApp.map((group) => (
                    <section key={group.name} className="space-y-2">
                      <SectionTitle>{group.name}</SectionTitle>
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {group.tests.map((test) => (
                          <CatalogRow
                            key={test.id}
                            kind="test"
                            id={test.id}
                            name={test.name}
                            detail={[test.platform, ...test.tags].filter(Boolean).join(" · ") || "Test"}
                            canRun={ready}
                            onStart={() => void start("test", test.id, test.name)}
                            onOpen={(taskId) => setSelected({ taskId, kind: "test", name: test.name })}
                            selectedTaskId={selected?.taskId ?? null}
                          />
                        ))}
                      </ul>
                    </section>
                  ))
                )}
              </>
            )}
          </div>

          <div className="min-w-0 lg:sticky lg:top-0 lg:max-h-screen">
            {selected === null ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-1.5 rounded-lg border border-border px-6 py-10 text-center">
                <Icon name="FileText" fallback="File" className="size-5 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">No report open</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Open a test or workflow to see its runs, then pick one to read its report here.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center gap-2 border-b border-border py-1.5 pl-4 pr-1.5">
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{selected.kind === "workflow" ? "Workflow report" : "Test report"}</p>
                  <Button variant="ghost" size="icon" className="size-7" aria-label="Close report" onClick={() => setSelected(null)}>
                    <Icon name="X" className="size-4" />
                  </Button>
                </div>
                {selected.kind === "workflow" ? (
                  <WorkflowReportView
                    taskId={selected.taskId}
                    name={selected.name}
                    onOpenTest={(taskId, name) => setSelected({ taskId, kind: "test", name })}
                  />
                ) : (
                  <TestReportView taskId={selected.taskId} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-medium text-foreground">{children}</h3>;
}

function CatalogRow({
  kind,
  id,
  name,
  detail,
  canRun,
  onStart,
  onOpen,
  selectedTaskId,
}: {
  kind: StartKind;
  id: string;
  name: string;
  detail: string;
  canRun: boolean;
  onStart: () => void;
  onOpen: (taskId: string) => void;
  selectedTaskId: string | null;
}) {
  const rpc = useRevylRpc();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || history !== null) return;
    rpc.call("history", { kind, targetId: id }).then(
      (value) => setHistory(value.entries),
      (cause: unknown) => setHistoryError(errorMessage(cause)),
    );
  }, [open, history, rpc, kind, id]);

  return (
    <li className="px-1.5 py-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-state-hover"
        >
          <Icon name="ChevronRight" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          </span>
        </button>
        <ConfirmSpend title={`Run ${name}?`} description={MINUTES_NOTE} confirmLabel="Run" onConfirm={onStart} spends>
          {(confirm) => (
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground" disabled={!canRun} onClick={confirm}>
              <Icon name="Play" fallback="ChevronRight" className="size-3.5" />
              Run
            </Button>
          )}
        </ConfirmSpend>
      </div>
      {open ? (
        <div className="mb-1 ml-7 mr-1 mt-1">
          {history === null ? (
            historyError === null ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <p className="text-xs text-destructive-text">{historyError}</p>
            )
          ) : history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {history.map((entry) => (
                <li key={entry.taskId}>
                  <button
                    type="button"
                    aria-current={entry.taskId === selectedTaskId ? "true" : undefined}
                    onClick={() => onOpen(entry.taskId)}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-state-hover aria-[current=true]:bg-state-active"
                  >
                    <StatusGlyph status={entry.status} className="size-3.5" />
                    <span className="w-16 shrink-0 text-foreground">{STATUS_LABEL[entry.status]}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.startedAt === null ? "" : formatWhen(entry.startedAt)}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{entry.durationLabel ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}
