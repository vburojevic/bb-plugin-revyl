/**
 * What the test browser lists: apps, tests and workflows, for one project or
 * the whole Revyl org.
 *
 * A project is linked through its repo's Revyl files, the ones `revyl init`
 * and `revyl test create` write:
 *   - `.revyl/config.yaml`: `build.platforms.*.app_id` and the `tests:` map of
 *     alias to test id;
 *   - `.revyl/tests/*.yaml`: `_meta.remote_id` (the test id) and
 *     `test.build.name` (the app name).
 * Workflows have no app of their own, so a workflow belongs to the project
 * when it contains one of the project's tests.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { RevylCli } from "./revyl-cli";
import type { BrowserScope, Catalog, RevylApp, TestSummary, WorkflowSummary } from "./model";
import { arr, mapApps, mapTests, mapWorkflows, obj, str } from "./revyl-json";

export interface ProjectLink {
  appIds: Set<string>;
  appNames: Set<string>;
  testIds: Set<string>;
  testNames: Set<string>;
}

const ORG_TTL_MS = 30_000;
const MAX_TEST_FILES = 200;

export async function readProjectLink(root: string): Promise<ProjectLink | null> {
  const link: ProjectLink = { appIds: new Set(), appNames: new Set(), testIds: new Set(), testNames: new Set() };
  let found = false;
  try {
    const config = obj(parseYaml(await readFile(join(root, ".revyl", "config.yaml"), "utf8")));
    found = true;
    for (const platform of Object.values(obj(obj(config.build).platforms))) {
      const appId = str(obj(platform).app_id);
      if (appId !== null) link.appIds.add(appId);
    }
    for (const [alias, id] of Object.entries(obj(config.tests))) {
      link.testNames.add(alias);
      const testId = str(id);
      if (testId !== null) link.testIds.add(testId);
    }
  } catch {
    // No config: tests folder alone can still link a project.
  }
  try {
    const dir = join(root, ".revyl", "tests");
    const files = (await readdir(dir)).filter((name) => /\.ya?ml$/i.test(name)).slice(0, MAX_TEST_FILES);
    for (const file of files) {
      try {
        const doc = obj(parseYaml(await readFile(join(dir, file), "utf8")));
        found = true;
        const remoteId = str(obj(doc._meta).remote_id);
        if (remoteId !== null) link.testIds.add(remoteId);
        const test = obj(doc.test);
        const name = str(obj(test.metadata).name);
        if (name !== null) link.testNames.add(name);
        const appName = str(obj(test.build).name);
        if (appName !== null) link.appNames.add(appName);
      } catch {
        // One unreadable file does not unlink the project.
      }
    }
  } catch {
    // No tests folder.
  }
  if (!found) return null;
  const empty = link.appIds.size + link.appNames.size + link.testIds.size + link.testNames.size === 0;
  return empty ? null : link;
}

interface OrgCatalog {
  apps: RevylApp[];
  tests: TestSummary[];
  workflows: WorkflowSummary[];
  loadedAt: number;
}

export class CatalogService {
  private org: OrgCatalog | null = null;
  private loading: Promise<OrgCatalog> | null = null;
  private readonly workflowTests = new Map<string, { testIds: string[]; at: number }>();

  constructor(
    private readonly cli: RevylCli,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forget the cached org, after the key changes. */
  reset(): void {
    this.org = null;
  }

  async orgCatalog(force = false): Promise<OrgCatalog> {
    if (!force && this.org !== null && this.now() - this.org.loadedAt < ORG_TTL_MS) return this.org;
    if (this.loading !== null) return this.loading;
    this.loading = (async () => {
      const [apps, tests, workflows] = await Promise.all([
        this.cli.json(["app", "list"]).then(mapApps),
        this.cli.json(["test", "remote", "--limit", "500"]).then(mapTests),
        this.cli.json(["workflow", "list"]).then(mapWorkflows),
      ]);
      const catalog = { apps, tests, workflows, loadedAt: this.now() };
      this.org = catalog;
      return catalog;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Test names by id, for workflow children that carry only ids. */
  async testNames(): Promise<Map<string, string>> {
    try {
      const catalog = await this.orgCatalog();
      return new Map(catalog.tests.map((test) => [test.id, test.name]));
    } catch {
      return new Map();
    }
  }

  private async testsOfWorkflow(workflow: WorkflowSummary): Promise<string[]> {
    if (workflow.testIds !== null) return workflow.testIds;
    const cached = this.workflowTests.get(workflow.id);
    if (cached !== undefined && this.now() - cached.at < ORG_TTL_MS * 4) return cached.testIds;
    const info = obj(await this.cli.json(["workflow", "info", workflow.id]));
    const testIds = arr(info.tests).map((test) => str(obj(test).id)).filter((id): id is string => id !== null);
    this.workflowTests.set(workflow.id, { testIds, at: this.now() });
    return testIds;
  }

  async catalog(scope: BrowserScope, projectRoot: string | null, force = false): Promise<Catalog> {
    const org = await this.orgCatalog(force);
    if (scope === "org") {
      return { scope, projectLinked: false, fallbackReason: null, ...org };
    }
    const link = projectRoot === null ? null : await readProjectLink(projectRoot);
    if (link === null) {
      return {
        scope: "org",
        projectLinked: false,
        fallbackReason:
          projectRoot === null
            ? "This project's checkout is not on this machine, so its Revyl files can't be read."
            : "This project has no Revyl config yet. Run revyl init in its repo to link it.",
        ...org,
      };
    }
    const tests = org.tests.filter(
      (test) =>
        link.testIds.has(test.id) ||
        link.testNames.has(test.name) ||
        (test.appId !== null && link.appIds.has(test.appId)) ||
        (test.appName !== null && link.appNames.has(test.appName)),
    );
    const testIds = new Set(tests.map((test) => test.id));
    const appIds = new Set([...link.appIds, ...tests.map((test) => test.appId).filter((id): id is string => id !== null)]);
    const apps = org.apps.filter((app) => appIds.has(app.id) || link.appNames.has(app.name));
    const workflows: WorkflowSummary[] = [];
    for (const workflow of org.workflows.slice(0, 50)) {
      try {
        const ids = await this.testsOfWorkflow(workflow);
        if (ids.some((id) => testIds.has(id))) workflows.push({ ...workflow, testIds: ids });
      } catch {
        // A workflow we cannot read is left out of project scope.
      }
    }
    return { scope, projectLinked: true, fallbackReason: null, apps, tests, workflows, loadedAt: org.loadedAt };
  }
}
