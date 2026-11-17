import { useState, type FormEvent } from "react";
import { experimental_copyToClipboard as copyToClipboard } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { CliStatus } from "../src/model";
import { SETTINGS_CARD, errorMessage } from "./format";
import { useRevylRpc } from "./hooks";

function CommandRow({ command }: { command: string }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{command}</code>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Copy command" onClick={() => void copyToClipboard({ text: command })}>
        <Icon name="Copy" className="size-4" />
      </Button>
    </div>
  );
}

/** Paste the Revyl API key. It goes to the bb server's secret settings and is never shown again. */
function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const rpc = useRevylRpc();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (key.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("set_api_key", { key: key.trim() });
      if (result.connected) {
        setKey("");
        onConnected();
      } else {
        setError(result.error ?? "Revyl refused this key.");
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="Revyl API key"
          aria-label="Revyl API key"
        />
        <Button type="submit" size="sm" disabled={busy || key.trim() === ""}>
          {busy ? "Checking…" : "Connect"}
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
    </form>
  );
}

/** What to do when Revyl is not connected, or when this machine could bypass the proxy. */
export function SetupNotice({ status, onRecheck, rechecking }: { status: CliStatus; onRecheck: () => void; rechecking: boolean }) {
  if (status.state === "ready") {
    if (!status.machineSignedIn) return null;
    return (
      <div role="status" className={`${SETTINGS_CARD} text-sm`}>
        <p className="font-medium text-foreground">The revyl CLI on bb's machine is signed in on its own</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Agents here could use that sign-in instead of their thread's token, skipping the per-thread limits. Sign it out; bb keeps
          working with the key on its Revyl page.
        </p>
        <CommandRow command="revyl auth logout" />
        <Button variant="outline" size="sm" className="mt-2" disabled={rechecking} onClick={onRecheck}>
          {rechecking ? "Checking…" : "Check again"}
        </Button>
      </div>
    );
  }
  return (
    <div role="status" className={`${SETTINGS_CARD} text-sm`}>
      {status.state === "missing" ? (
        <>
          <p className="font-medium text-foreground">Install the Revyl CLI on the machine that runs bb</p>
          <p className="mt-1 text-xs text-muted-foreground">Agents' machines don't need it signed in; bb hands each thread a token.</p>
          <CommandRow command="brew install RevylAI/tap/revyl" />
        </>
      ) : status.state === "no-key" ? (
        <>
          <p className="font-medium text-foreground">Connect Revyl</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Paste an API key from app.revyl.ai, Settings, API Keys. It stays on the bb server; agents get a token for their thread only.
          </p>
          <ConnectForm onConnected={onRecheck} />
        </>
      ) : (
        <>
          <p className="font-medium text-foreground">Revyl did not answer</p>
          <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
          <CommandRow command="revyl doctor" />
        </>
      )}
      {status.state === "no-key" ? null : (
        <Button variant="outline" size="sm" className="mt-2" disabled={rechecking} onClick={onRecheck}>
          {rechecking ? "Checking…" : "Check again"}
        </Button>
      )}
    </div>
  );
}
