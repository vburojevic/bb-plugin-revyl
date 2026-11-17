/**
 * `::revyl{device="<session_id>" shot="<n>"}` in a reply: one screen of this
 * thread's cloud device. With `shot`, that screenshot, kept for good (pinned);
 * without it, the agent's latest screenshot of the device. Only devices of the
 * thread the reply is in. Attributes are untrusted; only well-formed values are used.
 */
import { useEffect, useState } from "react";
import { experimental_useAppPanel as useAppPanel } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DEVICE_TAB, endedLabel, errorMessage, formatAgo, platformLabel } from "./format";
import { useRevylRpc, useThreadRuns } from "./hooks";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function DeviceDirective({ device, shot, threadId }: { device: string; shot: string | undefined; threadId: string | null }) {
  const n = shot !== undefined && /^[1-9][0-9]{0,6}$/.test(shot) ? Number(shot) : null;
  if (!SESSION_ID.test(device) || (shot !== undefined && n === null)) {
    return <span className="text-xs text-muted-foreground">Revyl device: missing or invalid device or screenshot number.</span>;
  }
  if (threadId === null) return <span className="text-xs text-muted-foreground">Revyl device: shown only inside its thread.</span>;
  return <DeviceCard sessionId={device.toLowerCase()} n={n} threadId={threadId} />;
}

function DeviceCard({ sessionId, n, threadId }: { sessionId: string; n: number | null; threadId: string }) {
  const rpc = useRevylRpc();
  const panel = useAppPanel();
  const { data } = useThreadRuns(threadId);
  const session = data?.sessions.find((candidate) => candidate.sessionId === sessionId) ?? null;
  const [still, setStill] = useState<{ n: number; takenAt: number; dataUrl: string } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Without a number the card follows the latest screenshot.
  const version = n === null ? (session?.lastStill ?? null) : n;

  useEffect(() => {
    let cancelled = false;
    rpc.call("device_still", { threadId, sessionId, n, pin: n !== null }).then(
      (value) => !cancelled && setStill(value),
      (cause: unknown) => !cancelled && setError(errorMessage(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, sessionId, n, version]);

  // The still is looked up within this thread, so a still found here is this
  // thread's even when the device has dropped off the thread's recent list.
  if (data !== null && session === null && still === null) {
    return <p className="my-2 text-xs text-muted-foreground">Revyl device: not a device of this thread, or its screenshot is no longer kept.</p>;
  }
  const live = session !== null && session.stoppedAt === null;
  const facts = [
    platformLabel(session?.platform ?? null),
    session?.buildVersion ? `build ${session.buildVersion}` : null,
    live ? "live now" : session === null ? null : endedLabel(session.endedBy ?? null),
  ].filter((fact): fact is string => fact !== null);

  return (
    <div className="my-2 flex max-w-md gap-3 rounded-lg border border-border p-3" data-revyl-device={sessionId}>
      <div className="w-28 shrink-0">
        {still === undefined && error === null ? (
          <Skeleton className="aspect-[9/19.5] w-full rounded-lg" />
        ) : still ? (
          <img src={still.dataUrl} alt={`Screenshot ${still.n} of ${session?.appName ?? "the device"}`} className="w-full rounded-lg border border-border" />
        ) : (
          <div className="grid aspect-[9/19.5] w-full place-items-center rounded-lg border border-dashed border-border p-2 text-center text-[11px] text-muted-foreground">
            {error ?? (n === null ? "No screenshot yet" : "This screenshot is no longer kept")}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Icon name="revyl/revyl" fallback="Smartphone" className={cn("size-3.5 shrink-0", live ? "text-primary" : "text-muted-foreground")} />
          <p className="truncate text-sm font-medium text-foreground">{session?.appName ?? "Cloud device"}</p>
        </div>
        {facts.length > 0 ? <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p> : null}
        {still ? (
          <p className="text-xs text-muted-foreground">
            Screenshot {still.n} · {formatAgo(still.takenAt)}
          </p>
        ) : null}
        <div className="pt-2">
          <Button size="sm" variant="outline" onClick={() => panel.openTab({ tab: DEVICE_TAB, title: "Revyl device" })}>
            {live ? "Watch live" : "Open device"}
          </Button>
        </div>
      </div>
    </div>
  );
}
