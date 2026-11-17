/**
 * Frontend registration. Each surface lives in its own module under app/.
 */

import { definePluginApp } from "@get-bb/plugin-sdk/app";

import "./app.css";
import { BrowserPage } from "./app/BrowserPage";
import { DeviceTab } from "./app/DeviceTab";
import { ModeToggle } from "./app/ModeToggle";
import { ReportTab } from "./app/ReportTab";
import { RevylDirective } from "./app/RevylDirective";
import { RunsBanner } from "./app/RunsBanner";
import { SettingsSection } from "./app/SettingsSection";

export default definePluginApp((app) => {
  // Test on Revyl, per thread: a button among the composer's actions, in a
  // thread and in the new-thread composer.
  app.composer.customize({
    id: "revyl-mode",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "test-on-revyl", component: ModeToggle }],
  });

  // The run card above a thread's composer. `chrome: "bare"` because bb's
  // collapsible stack card draws its own frame.
  app.composer.customize({
    id: "revyl-runs",
    scopes: ["thread"],
    banners: [{ id: "runs", chrome: "bare", component: RunsBanner }],
  });

  // `::revyl{task="<task_id>"}` in a reply: a live result card.
  app.slots.messageDirective({ id: "revyl", component: RevylDirective });

  // Side panel: a run's report (video, steps, AI summary), or with no run
  // chosen, the thread's runs.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "report",
    title: "Revyl runs",
    icon: "FileText",
    component: ReportTab,
  });

  // Side panel: a live cloud device to watch and drive, or the list to start one.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "device",
    title: "Revyl device",
    icon: "Smartphone",
    component: DeviceTab,
  });

  // The Revyl page in the sidebar: browse tests and workflows, run them, read reports.
  app.slots.navPanel({
    id: "revyl",
    title: "Revyl",
    icon: "revyl/revyl",
    path: "revyl",
    component: BrowserPage,
  });

  app.slots.settingsSection({
    id: "revyl-cli",
    title: "Connection",
    description: "The Revyl org this bb uses, and the CLI it runs.",
    component: SettingsSection,
  });
});
