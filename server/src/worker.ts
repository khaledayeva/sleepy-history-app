import { loadConfig } from "./config.js";
import { createHostedRuntime, type HostedGenerationWorker } from "./productionRuntime.js";

export interface WorkerOptions {
  readonly once?: boolean;
  readonly worker?: Pick<HostedGenerationWorker, "runOnce" | "start">;
}

export interface WorkerResult {
  readonly ok: true;
  readonly processedJobs: number;
}

export async function runWorker(options: WorkerOptions = {}): Promise<WorkerResult> {
  const worker = options.worker ?? createHostedRuntime(loadConfig()).worker;
  if (options.once) {
    const health = await worker.runOnce();
    return {
      ok: true,
      processedJobs: health.processedJobs
    };
  }

  worker.start();
  await new Promise(() => undefined);

  return {
    ok: true,
    processedJobs: 0
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const once = process.argv.includes("--once");
  runWorker({ once })
    .then((result) => {
      process.stdout.write(`Sleepy History worker started; processed ${result.processedJobs} jobs\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
