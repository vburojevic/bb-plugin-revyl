import { useState, type ReactNode } from "react";

import { minutesLeftLabel, useBilling } from "./hooks";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Starting a run or a device uses paid Revyl device minutes, so every start
 * from bb asks first. `children` renders the trigger with an `open` callback.
 */
export function ConfirmSpend({
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
  spends = false,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  children: (open: () => void) => ReactNode;
  /** It uses device minutes: say how many are left. */
  spends?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const billing = useBilling(open && spends);
  const left = spends ? minutesLeftLabel(billing) : null;
  return (
    <>
      {children(() => setOpen(true))}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>
              {description}
              {left === null ? null : (
                <>
                  <br />
                  <span className="mt-1.5 inline-block">
                    {left}
                    {billing?.usdPerMinute ? `, then $${billing.usdPerMinute} a minute` : ""}.
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const MINUTES_NOTE = "It runs on a Revyl cloud device and uses device minutes from your plan.";
