/**
 * The Revyl device pane: this thread's cloud device, live.
 *
 * Opened without params it follows the thread: the device that is running, or
 * the last one with how it ended, or a quiet empty state with the list to
 * start one. A thread runs at most one device (the proxy's cap), so there is
 * never a session to choose. The run card above the composer opens this pane
 * by itself when a new device starts (RunsBanner). A tab opened by 0.2 with a
 * `sessionId` param shows that session while it runs, then follows the thread.
 */
import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useBbContext, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { RevylApp, Session } from "../src/model";
import { ConfirmSpend, MINUTES_NOTE } from "./ConfirmSpend";
import { endedLabel, errorMessage, formatAgo, formatMinutes, platformLabel } from "./format";
import { useRevylRpc, useThreadRuns } from "./hooks";
import { useWhepStream } from "./whep";

const SESSION_ID = /^[0-9a-f-]{36}$/i;
/** How often the pane keeps a copy of the live frame, to show after the device stops. */
const FRAME_EVERY_MS = 3_000;

export function DeviceTab({ threadId, params }: ExperimentalThreadActionTabProps) {
  const record = params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const pinned = typeof record.sessionId === "string" && SESSION_ID.test(record.sessionId) ? record.sessionId.toLowerCase() : null;
  return <FollowThread threadId={threadId} pinned={pinned} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-4 p-4">{children}</div>
    </div>
  );
}

function FollowThread({ threadId, pinned }: { threadId: string; pinned: string | null }) {
  const { data, error } = useThreadRuns(threadId);
  if (data === null) {
    return (
      <Frame>
        {error === null ? <Skeleton className="mx-auto aspect-[9/19.5] w-full max-w-xs rounded-2xl" /> : <p role="alert" className="text-sm text-destructive-text">{error}</p>}
      </Frame>
    );
  }
  const sessions = data.sessions;
  const current =
    (pinned === null ? null : (sessions.find((session) => session.sessionId === pinned && session.stoppedAt === null) ?? null)) ??
    sessions.find((session) => session.stoppedAt === null) ??
    sessions[0] ??
    null;
  if (current === null) {
    return (
      <Frame>
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <Icon name="revyl/revyl" fallback="Smartphone" className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No device in this thread</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            When the agent starts a Revyl cloud device here, it shows up in this pane, live.
          </p>
        </div>
        <StartDevice threadId={threadId} />
      </Frame>
    );
  }
  return <DeviceView key={current.sessionId} threadId={threadId} session={current} agentBusy={data.agentBusy} />;
}

/** The apps a person can start a device for, each start confirmed (device minutes cost money). */
function StartDevice({ threadId, title = "Start a device" }: { threadId: string; title?: string }) {
  const { projectId } = useBbContext();
  const rpc = useRevylRpc();
  const [apps, setApps] = useState<RevylApp[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [targets, setTargets] = useState<{ ios: Array<{ model: string; os: string }>; android: Array<{ model: string; os: string }> } | null>(null);
  // "default", or "<platform>|<model>|<os>".
  const [choice, setChoice] = useState("default");

  useEffect(() => {
    let cancelled = false;
    rpc.call("device_targets", {}).then(
      (value) => !cancelled && setTargets(value),
      () => !cancelled && setTargets({ ios: [], android: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const targetFor = (app: RevylApp) => {
    if (choice === "default") return {};
    const [platform, model, os] = choice.split("|");
    // A model of the other platform does not apply to this app: start Revyl's default.
    return platform === (app.platform ?? "ios").toLowerCase() ? { deviceModel: model, osVersion: os } : {};
  };

  useEffect(() => {
    let cancelled = false;
    rpc.call("catalog", { scope: "project", projectId }).then(
      (catalog) => !cancelled && setApps(catalog.apps.filter((app) => app.platform?.toLowerCase() !== "web")),
      (cause: unknown) => !cancelled && setAppsError(errorMessage(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId]);

  const start = async (app: RevylApp) => {
    setStarting(app.id);
    try {
      // The pane follows the thread, so the new device shows here by itself.
      await rpc.call("session_start", { threadId, appId: app.id, ...targetFor(app) });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setStarting(null);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">{title}</h3>
        {targets !== null && targets.ios.length + targets.android.length > 0 ? (
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger className="h-8 w-56" aria-label="Device to start">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Revyl's default device</SelectItem>
              {[...targets.ios.map((target) => ({ ...target, platform: "ios" })), ...targets.android.map((target) => ({ ...target, platform: "android" }))].map((target) => (
                <SelectItem key={`${target.platform}|${target.model}|${target.os}`} value={`${target.platform}|${target.model}|${target.os}`}>
                  {target.model} · {target.os}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {apps === null ? (
        appsError === null ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <p role="alert" className="text-sm text-destructive-text">{appsError}</p>
        )
      ) : apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No iOS or Android apps in Revyl yet. Upload a build with `revyl build upload`.</p>
      ) : (
        <ul className="divide-y divide-border">
          {apps.map((app) => (
            <li key={app.id} className="flex items-center gap-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{app.name}</p>
                <p className="text-xs text-muted-foreground">
                  {app.platform ?? "App"}
                  {app.latestVersion === null ? "" : ` · latest build ${app.latestVersion}`}
                </p>
              </div>
              <ConfirmSpend
                spends
                title={`Start a device for ${app.name}?`}
                description={`${MINUTES_NOTE} It stops when you press Stop or after it sits idle.`}
                confirmLabel="Start device"
                onConfirm={() => void start(app)}
              >
                {(confirm) => (
                  <Button size="sm" variant="outline" disabled={starting !== null} onClick={confirm}>
                    {starting === app.id ? "Starting…" : "Start"}
                  </Button>
                )}
              </ConfirmSpend>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Pending {
  id: number;
  x: number;
  y: number;
}

type Info = {
  whepUrl: string | null;
  alive: boolean;
  screenWidth: number | null;
  screenHeight: number | null;
  idleTimeoutSeconds: number | null;
  lastActivityAt: number | null;
};

/** Re-render on an interval, for "12 min" and "4 s ago". */
function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The agent's latest screenshot of this device, or a given one. */
function useStill(threadId: string, sessionId: string, n: number | null, version: number | null, enabled: boolean) {
  const rpc = useRevylRpc();
  const [still, setStill] = useState<{ n: number; takenAt: number; dataUrl: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    rpc.call("device_still", { threadId, sessionId, n }).then(
      (value) => !cancelled && setStill(value),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, sessionId, n, version, enabled]);
  return still;
}

function DeviceView({ threadId, session, agentBusy }: { threadId: string; session: Session; agentBusy: boolean }) {
  const rpc = useRevylRpc();
  const sessionId = session.sessionId;
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState("");
  const [stopping, setStopping] = useState(false);
  // The latest copy of the live frame, read when the device ends.
  const lastFrame = useRef<string | null>(null);
  const [wasLive, setWasLive] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  // Revyl types into the field at a point, so typing goes where you last tapped.
  const [lastTap, setLastTap] = useState<{ x: number; y: number } | null>(null);
  const counter = useRef(0);
  const now = useNow(15_000);

  const ended = session.stoppedAt !== null || (info !== null && !info.alive);

  // Ask Revyl about the session: often until the stream URL appears, then
  // rarely. One call at a time, so a slow Revyl never queues CLI runs.
  useEffect(() => {
    if (ended) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hasStream = false;
    const load = async () => {
      try {
        const value = await rpc.call("session_info", { sessionId });
        if (cancelled) return;
        hasStream = value.whepUrl !== null;
        setInfo((previous) => (previous !== null && previous.whepUrl === value.whepUrl ? { ...value, whepUrl: previous.whepUrl } : value));
        setInfoError(null);
      } catch (cause) {
        if (!cancelled) setInfoError(errorMessage(cause));
      } finally {
        if (!cancelled) timer = setTimeout(() => void load(), hasStream ? 20_000 : 4_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rpc, sessionId, ended]);

  const streamState = useWhepStream(ended ? null : (info?.whepUrl ?? null), video, attempt);
  const live = !ended && streamState === "live";
  useEffect(() => {
    if (live) setWasLive(true);
  }, [live]);
  const width = info?.screenWidth || session.screenWidth || 440;
  const height = info?.screenHeight || session.screenHeight || 956;
  const canTouch = live && !agentBusy;
  // Without a live picture, show the agent's latest screenshot.
  const still = useStill(threadId, sessionId, null, session.lastStill ?? null, !live && (session.lastStill ?? null) !== null);

  // Keep a copy of the live frame, so the screen does not go blank when the device stops.
  useEffect(() => {
    if (!live) return;
    const grab = () => {
      const element = video.current;
      if (element === null || element.videoWidth === 0) return;
      const scale = Math.min(1, 720 / element.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(element.videoWidth * scale);
      canvas.height = Math.round(element.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height);
      try {
        lastFrame.current = canvas.toDataURL("image/jpeg", 0.85);
      } catch {
        // A tainted frame cannot be read back; keep the previous one.
      }
    };
    const timer = setInterval(grab, FRAME_EVERY_MS);
    return () => clearInterval(timer);
  }, [live]);

  const toDevice = (clientX: number, clientY: number) => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * width),
      y: Math.round(((clientY - rect.top) / rect.height) * height),
      px: ((clientX - rect.left) / rect.width) * 100,
      py: ((clientY - rect.top) / rect.height) * 100,
    };
  };

  const send = async (action: Parameters<typeof rpc.call<"session_input">>[1]["action"], marker: { px: number; py: number } | null) => {
    const id = ++counter.current;
    if (marker !== null) setPending((current) => [...current, { id, x: marker.px, y: marker.py }]);
    try {
      await rpc.call("session_input", { threadId, sessionId, action });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setPending((current) => current.filter((item) => item.id !== id));
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!canTouch) return;
    press.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = press.current;
    press.current = null;
    if (start === null || !canTouch) return;
    const from = toDevice(start.x, start.y);
    if (from === null) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) < 12) {
      setLastTap({ x: from.x, y: from.y });
      void send({ type: "tap", x: from.x, y: from.y }, from);
      return;
    }
    // Revyl's input takes a direction from a start point, not a path.
    const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    void send({ type: "swipe", x: from.x, y: from.y, direction }, from);
  };

  const submitText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (value === "" || !canTouch) return;
    if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) {
      setText("");
      void send({ type: "navigate", url: value }, null);
      return;
    }
    if (lastTap === null) return;
    setText("");
    void send({ type: "type", text: value, x: lastTap.x, y: lastTap.y }, null);
  };

  const stop = async () => {
    setStopping(true);
    try {
      await rpc.call("session_stop", { threadId, sessionId });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setStopping(false);
    }
  };

  const ranFor = formatMinutes((session.stoppedAt ?? now) - session.startedAt);
  const facts = [
    platformLabel(session.platform),
    session.buildVersion ? `build ${session.buildVersion}` : null,
  ].filter((fact): fact is string => fact !== null);
  // Worktree branch names run long; they sit with the details below, not in the header.
  const branch = session.branchName && session.branchName !== "base" ? session.branchName : null;
  const link = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text.trim()) ? text.trim() : null;
  const idle =
    !ended && info?.idleTimeoutSeconds
      ? `Stops after ${formatMinutes(info.idleTimeoutSeconds * 1000)} without input${
          info.lastActivityAt !== null && now - info.lastActivityAt > 60_000 ? ` · idle ${formatMinutes(now - info.lastActivityAt)}` : ""
        }`
      : null;
  const picture = ended ? (lastFrame.current ?? still?.dataUrl ?? null) : live ? null : (still?.dataUrl ?? null);

  // While connecting, the chip on the screen says so; this line is for a live or failed view.
  const status = ended
    ? null
    : live
      ? agentBusy
        ? "The agent is using the device. You can take over when it goes idle."
        : "Click to tap, drag to swipe. Each input takes about a second to land."
      : streamState === "failed"
        ? "The live view did not connect."
        : streamState === "ended"
          ? "The live view dropped. The device may still be running."
          : null;
  const endedAs = endedLabel(session.endedBy ?? null);
  const summary = [
    ended ? `${endedAs.charAt(0).toUpperCase()}${endedAs.slice(1)} · ran ${ranFor}` : live ? `Live · ${ranFor}` : wasLive ? `Live view lost · ${ranFor}` : "Starting",
    ...facts,
  ].join(" · ");
  const latest = session.actions?.[0] ?? null;

  return (
    <Frame>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Icon name="revyl/revyl" fallback="Smartphone" className={cn("size-4 shrink-0", ended ? "text-muted-foreground" : "text-primary")} />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{session.appName ?? "Cloud device"}</h2>
          {ended ? null : agentBusy && session.origin === "agent" ? (
            <ConfirmSpend
              title="Stop the agent's device?"
              description="The agent is working with this device. Stopping it ends the session; the agent would have to start a new one."
              confirmLabel="Stop device"
              onConfirm={() => void stop()}
            >
              {(confirm) => (
                <Button size="sm" variant="outline" disabled={stopping} onClick={confirm}>
                  {stopping ? "Stopping…" : "Stop"}
                </Button>
              )}
            </ConfirmSpend>
          ) : (
            <Button size="sm" variant="outline" disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </div>
        <p className="text-pretty text-xs text-muted-foreground" role="status">
          {ended ? null : (
            <span className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", live ? "bg-success" : "bg-muted-foreground")} aria-hidden />
          )}
          {summary}
        </p>
        {latest !== null && !ended ? (
          <p className="truncate text-xs text-muted-foreground" aria-live="polite" title={latest.label}>
            Agent: <span className="text-foreground">{latest.label}</span> · {formatAgo(latest.at, now)}
          </p>
        ) : null}
      </header>
      {infoError !== null && !ended ? <p role="alert" className="text-sm text-destructive-text">{infoError}</p> : null}

      <div
        ref={surface}
        className={cn(
          "bbrv-stream-frame relative mx-auto max-w-full touch-none select-none overflow-hidden rounded-2xl",
          canTouch ? "cursor-pointer" : "cursor-default",
        )}
        // Tall enough to read, short enough that the controls and the agent's actions fit beside it.
        style={{ aspectRatio: `${width} / ${height}`, height: "min(58vh, 40rem)" }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          press.current = null;
        }}
        aria-label={canTouch ? "Device screen. Click to tap, drag to swipe." : "Device screen"}
        role="application"
      >
        <video ref={video} muted playsInline autoPlay className={cn("pointer-events-none h-full w-full object-fill", picture !== null && "hidden")} />
        {picture !== null ? (
          <img src={picture} alt={ended ? "The device's last screen" : "The agent's latest screenshot"} className={cn("pointer-events-none h-full w-full object-fill", ended && "opacity-60")} />
        ) : null}
        {!ended && !live ? (
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            {streamState === "failed" || streamState === "ended" ? (
              <Button size="sm" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
                Reconnect
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background/80 px-2 py-1 text-xs text-muted-foreground">
                <Icon name="Loading" className="size-3.5 animate-spin" />
                {picture === null ? "Connecting" : "Latest screenshot · connecting"}
              </span>
            )}
          </div>
        ) : null}
        {ended && picture === null ? <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Ended</div> : null}
        {pending.map((item) => (
          <span key={item.id} className="bbrv-touch-pending" style={{ left: `${item.x}%`, top: `${item.y}%` }} />
        ))}
      </div>

      {status !== null ? <p className="text-center text-xs text-muted-foreground">{status}</p> : null}

      {ended ? null : (
        <>
          <div className="mx-auto flex w-full max-w-xs items-center justify-center gap-2">
            <Button size="sm" variant="ghost" disabled={!canTouch} onClick={() => void send({ type: "home" }, null)}>
              <Icon name="Home" className="size-4" />
              Home
            </Button>
            {session.platform?.toLowerCase() === "android" ? (
              <Button size="sm" variant="ghost" disabled={!canTouch} onClick={() => void send({ type: "back" }, null)}>
                <Icon name="ArrowLeft" className="size-4" />
                Back
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={!canTouch} onClick={() => void send({ type: "key", key: "ENTER" }, null)} aria-label="Press Enter">
              <Icon name="CornerDownLeft" fallback="ArrowLeft" className="size-4" />
              Enter
            </Button>
            <Button size="sm" variant="ghost" disabled={!canTouch} onClick={() => void send({ type: "key", key: "BACKSPACE" }, null)} aria-label="Press Delete">
              <Icon name="Delete" fallback="X" className="size-4" />
              Delete
            </Button>
            <Button size="sm" variant="ghost" disabled={!canTouch} onClick={() => void send({ type: "relaunch" }, null)} aria-label="Relaunch the app">
              <Icon name="RotateCw" fallback="ArrowReloadHorizontal" className="size-4" />
              Relaunch
            </Button>
          </div>
          <form onSubmit={submitText} className="mx-auto flex w-full max-w-sm items-center gap-2">
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={lastTap === null ? "Tap a field first, or paste a link" : "Type into the field you tapped"}
              aria-label="Text to type on the device, or a link to open"
              disabled={!canTouch}
              maxLength={2000}
            />
            <Button type="submit" size="sm" disabled={!canTouch || lastTap === null || text.trim() === "" || link !== null}>
              Type
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canTouch || link === null}
              onClick={() => {
                if (link === null) return;
                setText("");
                void send({ type: "navigate", url: link }, null);
              }}
            >
              Open link
            </Button>
          </form>
        </>
      )}

      <Activity session={session} now={now} />

      <section className="space-y-1 text-xs text-muted-foreground">
        <p>
          Started {formatAgo(session.startedAt, now)} {session.origin === "agent" ? "by the agent" : "from bb"}
        </p>
        {branch !== null ? (
          <p className="truncate" title={branch}>
            Branch {branch}
          </p>
        ) : null}
        {idle !== null ? <p>{idle}</p> : null}
      </section>

      {ended ? <StartDevice threadId={threadId} title="Start another device" /> : null}
    </Frame>
  );
}

/** What the agent did on the device, newest first, as the proxy saw it. */
function Activity({ session, now }: { session: Session; now: number }) {
  const actions = session.actions ?? [];
  if (session.origin !== "agent" && actions.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium text-foreground">Agent activity</h3>
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ol className="space-y-1">
          {actions.map((action, index) => (
            <li key={`${action.at}-${index}`} className="flex items-baseline gap-2 text-sm">
              <span className={cn("min-w-0 flex-1 truncate", index === 0 ? "text-foreground" : "text-muted-foreground")}>{action.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatAgo(action.at, now)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
