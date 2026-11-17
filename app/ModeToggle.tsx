/**
 * The Test on Revyl switch, in the composer.
 *
 * In a thread's composer it switches that thread. In the new-thread composer
 * there is no thread yet, so it marks the selected project; the first message
 * sent to a new thread there claims the mark (server.ts, message.dispatch).
 * Flipped in a thread that already runs, it also leaves a one-line note at the
 * end of the person's draft, because an agent's standing instructions only
 * change when its session is next built. Flipping back removes that note.
 * While Revyl is not connected the button leads to the Revyl page.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { switchNote } from "../src/agent-text";
import { errorMessage } from "./format";
import { useCliStatus, useRevylRpc } from "./hooks";

const TITLES = {
  threadOn: "Test on Revyl is on: this thread builds, tests and runs iOS and Android apps only on Revyl",
  threadOff: "Test on Revyl: build, test and run this thread's iOS and Android apps only on Revyl",
  newOn: "The first message here starts a thread that tests on Revyl",
  newOff: "Test on Revyl: start this thread building, testing and running on Revyl",
  connect: "Connect Revyl on the Revyl page first",
};

export function ModeToggle() {
  const { scope } = useComposer();
  const status = useCliStatus();
  // Only a missing key or CLI sends the person to the Revyl page; a Revyl
  // that did not answer for a moment keeps the thread's real state showing.
  if (status.data?.state === "no-key" || status.data?.state === "missing") return <ConnectButton />;
  if (scope.kind === "thread") return <ThreadToggle threadId={scope.threadId} />;
  if (scope.kind === "new-thread" && scope.projectId !== null) return <NewThreadToggle projectId={scope.projectId} />;
  // bb is still resolving the new thread's project: nothing inline, and a
  // waiting row in bb's menu rather than an empty one.
  return <Toggle on={null} busy title={TITLES.newOff} menuOnly onClick={() => {}} />;
}

/**
 * Where bb put the button. bb shows only a few plugins' composer actions
 * inline and moves the rest into its "More plugin actions" menu, ordered by
 * how often each was clicked. An icon alone means nothing in that menu, so
 * there the button carries its name and state.
 */
function usePlacement() {
  const ref = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<"inline" | "overflow">("inline");
  useLayoutEffect(() => {
    const host = ref.current?.closest("[data-plugin-composer-action-placement]");
    setPlacement(host?.getAttribute("data-plugin-composer-action-placement") === "overflow" ? "overflow" : "inline");
  }, []);
  return { ref, placement };
}

function Toggle({
  on,
  busy,
  title,
  onClick,
  label = "Test on Revyl",
  note,
  menuOnly = false,
}: {
  on: boolean | null;
  busy: boolean;
  title: string;
  onClick: () => void;
  label?: string;
  /** Shown in the menu in place of On or Off. */
  note?: string;
  /** Draw nothing inline, only the row in bb's menu. */
  menuOnly?: boolean;
}) {
  const { ref, placement } = usePlacement();
  const inMenu = placement === "overflow";
  const state = note ?? (on === null ? null : on ? "On" : "Off");
  if (menuOnly && !inMenu) return <span ref={ref} className="contents" />;
  return (
    <span ref={ref} className="contents">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={inMenu ? "sm" : "icon"}
              aria-pressed={on === null ? undefined : on}
              aria-label={label}
              aria-description={title}
              disabled={busy}
              onClick={onClick}
              className={cn(
                inMenu ? "h-8 min-w-44 justify-start gap-2 px-2 text-sm font-normal text-foreground" : "size-7",
                !inMenu && (on ? "text-primary" : "text-muted-foreground"),
              )}
            >
              <Icon
                name="revyl/revyl"
                fallback="Smartphone"
                className={cn("size-4", inMenu && (on ? "text-primary" : "text-muted-foreground"))}
              />
              {inMenu && (
                <>
                  <span className="flex-1 text-left">{label}</span>
                  {state !== null && (
                    <span className={cn("text-xs", on ? "text-primary" : "text-muted-foreground")}>{state}</span>
                  )}
                </>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{title}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

/** An error message as a sentence, so the retry hint after it reads right. */
const sentence = (text: string) => (/[.?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

function ConnectButton() {
  const navigate = useBbNavigate();
  return <Toggle on={null} busy={false} label="Connect Revyl" title={TITLES.connect} onClick={() => navigate.toPluginPanel("revyl")} />;
}

function useMode(load: () => Promise<{ on: boolean }>, deps: unknown[]) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    setError(null);
    load().then(
      (value) => {
        setOn(value.on);
        setError(null);
      },
      (cause: unknown) => setError(errorMessage(cause)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => refetch(), [refetch]);
  return { on, setOn, error, setError, refetch };
}

function ThreadToggle({ threadId }: { threadId: string }) {
  const rpc = useRevylRpc();
  const composer = useComposer();
  const mode = useMode(() => rpc.call("thread_mode", { threadId }), [rpc, threadId]);
  const [busy, setBusy] = useState(false);
  const on = mode.on ?? false;

  const flip = () => {
    // A failed first load: try reading the state again instead of guessing it.
    if (mode.on === null) {
      mode.refetch();
      return;
    }
    setBusy(true);
    mode.setError(null);
    rpc.call("set_thread_mode", { threadId, on: !on }).then(
      (next) => {
        // A note for the opposite flip at the end of the draft cancels out:
        // the agent still knows the state it had. Otherwise add this flip's note.
        const opposite = switchNote(!next.on);
        const trimmed = composer.draft.text.trimEnd();
        if (trimmed.endsWith(opposite)) {
          composer.replace({ text: trimmed.slice(0, -opposite.length).trimEnd(), mentions: composer.draft.mentions });
        } else {
          composer.insert(trimmed === "" ? switchNote(next.on) : ` ${switchNote(next.on)}`, { at: "end" });
        }
        mode.setOn(next.on);
        setBusy(false);
      },
      (cause: unknown) => {
        mode.setError(errorMessage(cause));
        setBusy(false);
      },
    );
  };

  return (
    <Toggle
      on={mode.on === null ? null : on}
      busy={busy || (mode.on === null && mode.error === null)}
      title={mode.error === null ? (on ? TITLES.threadOn : TITLES.threadOff) : `${sentence(mode.error)} Click to try again.`}
      note={mode.on === null && mode.error !== null ? "Retry" : undefined}
      onClick={flip}
    />
  );
}

function NewThreadToggle({ projectId }: { projectId: string }) {
  const rpc = useRevylRpc();
  const mode = useMode(() => rpc.call("pending_mode", { projectId }), [rpc, projectId]);
  const [busy, setBusy] = useState(false);
  const on = mode.on ?? false;
  // The mark lapses after 30 minutes; asking again each minute keeps the button honest.
  useEffect(() => {
    const timer = setInterval(mode.refetch, 60_000);
    return () => clearInterval(timer);
  }, [mode.refetch]);
  return (
    <Toggle
      on={mode.on === null ? null : on}
      busy={busy || (mode.on === null && mode.error === null)}
      title={mode.error === null ? (on ? TITLES.newOn : TITLES.newOff) : `${sentence(mode.error)} Click to try again.`}
      note={mode.on === null && mode.error !== null ? "Retry" : undefined}
      onClick={() => {
        if (mode.on === null) {
          mode.refetch();
          return;
        }
        setBusy(true);
        mode.setError(null);
        rpc.call("set_pending_mode", { projectId, on: !on }).then(
          (next) => {
            mode.setOn(next.on);
            setBusy(false);
          },
          (cause: unknown) => {
            mode.setError(errorMessage(cause));
            setBusy(false);
          },
        );
      }}
    />
  );
}
