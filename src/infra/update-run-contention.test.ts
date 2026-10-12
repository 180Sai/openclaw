import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { captureUpdateRunRedactionFacts } from "./update-run-codec.js";
import { persistInterruptedUpdateObservation } from "./update-run-interruption-store.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import {
  openUpdateRunWriter,
  recordUpdateRunMutationInWorker,
} from "./update-run-mutation.worker.js";
import { reconcileUpdateRunCandidatesInWorker } from "./update-run-reconciliation.worker.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const home = dirs.make("update-run-contention-");
const options = { env: { HOME: home, OPENCLAW_STATE_DIR: home } };
let runId: string;
let writer: ReturnType<typeof openUpdateRunWriter>;

beforeEach(async () => {
  runId = createUpdateRun({ trigger: "cli" }, options).runId;
  await closeOpenClawStateDatabaseAsync();
  writer = openUpdateRunWriter(options);
});

afterEach(async () => {
  writer.close();
  await closeOpenClawStateDatabaseAsync();
});

it.each([
  [
    "progress step",
    (admit: (stage: "transaction" | "commit") => void) =>
      recordUpdateRunMutationInWorker(
        {
          type: "updateRuns.recordStep",
          input: {
            runId,
            redactionFacts: captureUpdateRunRedactionFacts(options.env),
            step: { step: "candidate-state-snapshot", status: "in_progress" },
          },
        },
        options,
        admit,
        writer,
      ),
    ["transaction:free", "commit:held"],
  ],
  [
    "reconciliation",
    (admit: (stage: "transaction" | "commit") => void) =>
      reconcileUpdateRunCandidatesInWorker({ candidates: [], selection: {} }, options, admit),
    ["transaction:free", "commit:held"],
  ],
  [
    "interruption settlement",
    (admit: (stage: "transaction" | "commit") => void) =>
      persistInterruptedUpdateObservation(
        { expected: { ...getUpdateRun(runId, options)!, updatedAtMs: 0 }, detail: "fixture" },
        options,
        admit,
      ),
    ["transaction:free"],
  ],
])("leaves the writer free while the host decides %s admission", (_name, write, expected) => {
  const competitor = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  competitor.exec("PRAGMA busy_timeout = 0");
  const observed: string[] = [];
  try {
    write((stage) => {
      try {
        competitor.exec("BEGIN IMMEDIATE");
        competitor.exec("ROLLBACK");
        observed.push(`${stage}:free`);
      } catch (error) {
        if (!isSqliteLockError(error)) {
          throw error;
        }
        observed.push(`${stage}:held`);
      }
    });
  } finally {
    competitor.close();
  }
  expect(observed).toEqual(expected);
});
