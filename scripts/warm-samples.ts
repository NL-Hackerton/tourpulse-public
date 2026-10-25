// Operator-only: node --conditions=react-server --import tsx scripts/warm-samples.ts --start-date=2026-11-01 --mode=all
// Supply QLOO_API_KEY and provider-managed KV_REST_API_URL/TOKEN through the process environment.
// This writes real canonical preset results to private Redis, never to repository files.
import { z } from "zod";
import { tourTypes, tourTypeSchema } from "../src/lib/contracts";
import { warmCanonicalSample } from "../src/lib/samples";
import { redisConfigured } from "../src/lib/cache";
import { safeError } from "../src/lib/qloo";

async function main() {
  const options: Record<string, string> = {};
  for (const argument of process.argv.slice(2)) {
    const match = /^--(start-date|mode)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(options, match[1])) throw new Error("Use --start-date=YYYY-MM-DD and optionally --mode=music|standup|podcast|all.");
    options[match[1]] = match[2];
  }
  const startDate = z.iso.date().parse(options["start-date"]);
  const mode = z.union([tourTypeSchema, z.literal("all")]).parse(options.mode ?? "all");
  if (!redisConfigured() || !process.env.QLOO_API_KEY) throw new Error("Configure Qloo and shared Redis before warming samples.");
  for (const selected of mode === "all" ? tourTypes : [mode]) {
    const signal = AbortSignal.timeout(270000);
    const run = await warmCanonicalSample(selected, startDate, (event) => {
      if (event.type === "trace") console.info(`${selected}: ${event.trace.step} ${event.trace.status} count=${event.trace.count}`);
    }, signal);
    console.info(`${selected}: saved completed canonical sample revision=${run.revision} stops=${run.plan!.stops.length} ttlDays=7`);
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof z.ZodError ? "Invalid warm-sample arguments or runtime data; no sample was fabricated." : error instanceof Error && (error.message.startsWith("Use --") || error.message.startsWith("Configure Qloo")) ? error.message : safeError(error));
  process.exitCode = 1;
});
