import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmSpend } from "./ConfirmSpend";
import { SETTINGS_CARD, errorMessage } from "./format";
import { UrlLink } from "@get-bb/plugin-sdk/app";

import { minutesLeftLabel, useBilling, useCliStatus, useRevylRpc } from "./hooks";
import { SetupNotice } from "./SetupNotice";

/** One row of a bb settings card: a title and a line of detail, a control at the trailing edge. */
function SettingsRow({ title, detail, hint, control }: { title: string; detail: React.ReactNode; hint?: string; control?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={hint}>
          {detail}
        </p>
      </div>
      {control === undefined ? null : <div className="shrink-0">{control}</div>}
    </div>
  );
}

/** Settings → Revyl: the connection, and the CLI the plugin uses, in bb's settings card. */
export function SettingsSection() {
  const status = useCliStatus();
  const rpc = useRevylRpc();
  const billing = useBilling(status.data?.state === "ready");
  if (status.data === null) return <Skeleton className="h-[7.5rem] w-full rounded-md" />;
  const notice = <SetupNotice status={status.data} onRecheck={() => void status.recheck()} rechecking={status.refreshing} />;
  if (status.data.state !== "ready") return notice;
  const account = [status.data.orgName ?? "Your Revyl org", status.data.email].filter(Boolean).join(" · ");
  return (
    <div className="space-y-3">
      {status.data.machineSignedIn ? notice : null}
      <div className={`${SETTINGS_CARD} space-y-4`}>
        <SettingsRow
          title="Revyl account"
          detail={account}
          hint={account}
          control={
            <ConfirmSpend
              title="Disconnect Revyl?"
              description="bb forgets the API key. Threads with Test on Revyl on lose Revyl access until you add a key again."
              confirmLabel="Disconnect"
              onConfirm={() => {
                rpc.call("clear_api_key", {}).then(
                  () => void status.recheck(),
                  (error: unknown) => toast.error(errorMessage(error)),
                );
              }}
            >
              {(open) => (
                <Button variant="outline" size="sm" onClick={open}>
                  Disconnect
                </Button>
              )}
            </ConfirmSpend>
          }
        />
        {billing ? (
          <SettingsRow
            title="Revyl plan"
            detail={[
              minutesLeftLabel(billing),
              billing.periodEnd ? `resets ${new Date(billing.periodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            hint={billing.usdPerMinute ? `After that, $${billing.usdPerMinute} a minute. Up to ${billing.concurrentDevices ?? "?"} devices at once.` : undefined}
            control={
              billing.billingUrl ? (
                <UrlLink href={billing.billingUrl} className="text-sm text-muted-foreground hover:text-foreground">
                  Billing
                </UrlLink>
              ) : undefined
            }
          />
        ) : null}
        <SettingsRow
          title="Revyl CLI"
          hint={[status.data.version, status.data.binary].filter(Boolean).join(" · ")}
          detail={
            <>
              {status.data.version ?? "Unknown version"}
              {status.data.binary ? (
                <>
                  {" · "}
                  <span className="font-mono">{status.data.binary}</span>
                </>
              ) : null}
            </>
          }
        />
      </div>
    </div>
  );
}
