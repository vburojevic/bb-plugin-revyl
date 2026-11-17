import { useEffect } from "react";
import {
  experimental_CollapsibleStackCard as CollapsibleStackCard,
  experimental_useAppPanel as useAppPanel,
  useComposer,
} from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Run, Session } from "../src/model";
import { isActive } from "../src/shared";
import { DEVICE_TAB, runSummary } from "./format";
import { useRevylRpc, useThreadRuns } from "./hooks";
import { RunRow } from "./RunRow";

/** Mounted for every thread's composer; renders only when there is something to show. */
export function RunsBanner() {
  const { scope } = useComposer();
  return scope.kind === "thread" ? <ThreadRunsCard threadId={scope.threadId} /> : null;
}

function cardTitle(runs: Run[], liveSessions: Session[]): string {
  const active = runs.filter((run) => isActive(run.status));
  if (active.length === 1) return `Revyl · ${runSummary(active[0]!)}`;
  if (active.length > 1) return `Revyl · ${active.length} runs in progress`;
  const latest = runs[0];
  if (latest !== undefined) {
    const others = runs.length - 1;
    return `Revyl · ${runSummary(latest)}${others > 0 ? ` · ${others} earlier` : ""}`;
  }
  return liveSessions.length === 1 ? "Revyl · device session live" : `Revyl · ${liveSessions.length} device sessions live`;
}

/** Devices whose pane already opened by itself, across windows. */
const OPENED_KEY = "bbrv.deviceOpened.v1";
const readOpened = (): string[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(OPENED_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Open the device pane once for each device that starts in this thread, so
 * the person sees what the agent does (agents start devices without a
 * browser). Closing the pane keeps it closed for that device.
 */
function useOpenNewDevice(sessions: Session[] | undefined) {
  const panel = useAppPanel();
  const live = sessions?.find((session) => session.stoppedAt === null) ?? null;
  const liveId = live?.sessionId ?? null;
  useEffect(() => {
    if (liveId === null) return;
    const opened = readOpened();
    if (opened.includes(liveId)) return;
    if (panel.openTab({ tab: DEVICE_TAB, title: "Revyl device" })) {
      window.localStorage.setItem(OPENED_KEY, JSON.stringify([liveId, ...opened].slice(0, 50)));
    }
  }, [liveId, panel]);
}

function ThreadRunsCard({ threadId }: { threadId: string }) {
  const { data } = useThreadRuns(threadId);
  const rpc = useRevylRpc();
  const panel = useAppPanel();
  useOpenNewDevice(data?.sessions);
  if (data === null) return null;
  const liveSessions = data.sessions.filter((session) => session.stoppedAt === null);
  if (data.runs.length === 0 && liveSessions.length === 0) return null;
  const anyActive = data.runs.some((run) => isActive(run.status));
  const anyFinished = data.runs.some((run) => !isActive(run.status));
  const latestFailed = data.runs[0]?.status === "failed";

  return (
    <TooltipProvider delayDuration={300}>
      <CollapsibleStackCard
        label="Revyl runs"
        title={cardTitle(data.runs, liveSessions)}
        icon={anyActive ? "Loading" : latestFailed ? "CircleX" : data.runs[0]?.status === "passed" ? "CircleCheck" : "revyl/revyl"}
        isActive={anyActive || liveSessions.length > 0}
        dismiss={
          anyFinished
            ? {
                label: "Clear finished Revyl runs",
                failureMessage: "Could not clear finished runs.",
                onDismiss: async () => {
                  await rpc.call("dismiss_finished", { threadId });
                },
              }
            : undefined
        }
      >
        <div className="bbrv-card-body divide-y divide-border px-3">
          {data.runs.map((run) => (
            <RunRow key={run.key} run={run} threadId={threadId} />
          ))}
          {liveSessions.map((session) => (
            <div key={session.sessionId} className="flex items-center gap-2.5 py-2">
              <Icon name="revyl/revyl" fallback="Smartphone" className="size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{session.appName ?? "Device session"}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {session.platform === null ? "Live" : `${session.platform.toUpperCase() === "IOS" ? "iOS" : session.platform} · live`}
                  {session.actions?.[0] !== undefined ? ` · ${session.actions[0].label}` : session.origin === "agent" ? " · started by the agent" : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={() => panel.openTab({ tab: DEVICE_TAB, title: "Revyl device" })}>
                Watch
              </Button>
            </div>
          ))}
        </div>
      </CollapsibleStackCard>
    </TooltipProvider>
  );
}
