// The --live API read wrapper: a fetch or parse failure becomes an `unreadable`
// observation in the report, never an aborted run.
import { type ApiPage, type ReadReport, Unreadable } from "@openadviser/ai-catalog-readers-kit";

export async function apiRead(
  report: ReadReport,
  live: boolean,
  source: string,
  envName: string,
  run: () => Promise<ApiPage<unknown>[]>,
  env: Record<string, string | undefined> = process.env,
): Promise<ApiPage<unknown>[]> {
  if (!live || env[envName] === undefined) return [];
  try {
    report.accountScope = { keyEnv: envName };
    return await run();
  } catch (error) {
    report.readings.push({
      kind: "observation",
      provider: report.provider,
      outcome: "unreadable",
      reasons: [
        {
          code: error instanceof Unreadable ? error.code : "fetch-failed",
          message: `the Models API read failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      source,
    });
    return [];
  }
}
