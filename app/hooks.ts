import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";

import type { RpcContract } from "../src/contract";
import { REALTIME_RUNS, REALTIME_THREAD_STATE } from "../src/shared";
import type { CliStatus, Run, Session } from "../src/model";
import { errorMessage } from "./format";

export function useRevylRpc() {
  return useRpc<RpcContract>();
}

/** A read that refetches on a realtime signal and on demand. */
function useLoaded<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    load().then(
      (value) => {
        if (mine !== generation.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (mine !== generation.current) return;
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    refetch();
  }, [refetch]);
  return { data, error, loading, refetch, setData };
}

export function useThreadRuns(threadId: string) {
  const rpc = useRevylRpc();
  const state = useLoaded(() => rpc.call("thread_runs", { threadId }), [rpc, threadId]);
  const { refetch, setData } = state;
  useRealtime(REALTIME_RUNS, (payload: unknown) => {
    const scope = (payload as { scope?: string } | null)?.scope;
    if (scope === undefined || scope === threadId) refetch();
  });
  useRealtime(REALTIME_THREAD_STATE, (payload: unknown) => {
    const event = payload as { threadId?: string; busy?: boolean } | null;
    if (event?.threadId !== threadId || typeof event.busy !== "boolean") return;
    const busy = event.busy;
    setData((current) => (current === null ? current : { ...current, agentBusy: busy }));
  });
  return state as typeof state & { data: { runs: Run[]; sessions: Session[]; agentBusy: boolean } | null };
}

export function usePageRuns() {
  const rpc = useRevylRpc();
  const state = useLoaded(() => rpc.call("page_runs", {}), [rpc]);
  useRealtime(REALTIME_RUNS, (payload: unknown) => {
    if ((payload as { scope?: string } | null)?.scope === "_page") state.refetch();
  });
  return state;
}

export function useCliStatus() {
  const rpc = useRevylRpc();
  const [refreshing, setRefreshing] = useState(false);
  const state = useLoaded<CliStatus>(() => rpc.call("status", {}), [rpc]);
  const recheck = useCallback(async () => {
    setRefreshing(true);
    try {
      state.setData(await rpc.call("status", { refresh: true }));
    } finally {
      setRefreshing(false);
    }
  }, [rpc, state]);
  return { ...state, recheck, refreshing };
}

/** A run followed by task id, for the directive and the report header. */
export function useRun(taskId: string, kind: Run["kind"] | null, threadId: string | null) {
  const rpc = useRevylRpc();
  const state = useLoaded(() => rpc.call("run_get", { taskId, kind, threadId }), [rpc, taskId, kind, threadId]);
  useRealtime(REALTIME_RUNS, () => state.refetch());
  // A run no thread tracks is polled by the server; ask again while it moves.
  const active = state.data !== null && ["starting", "queued", "running"].includes(state.data.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => state.refetch(), 5_000);
    return () => clearInterval(timer);
  }, [active, state]);
  return state;
}
