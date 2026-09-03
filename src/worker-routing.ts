import type { HerdrWorker, ReviewFinding } from "./types.js";

export function uniqueOwnerForPath(workers: HerdrWorker[], path: string): HerdrWorker | undefined {
  const matches = workers.filter((worker) => worker.owns.some((scope) => scope.endsWith("/**") ? path.startsWith(scope.slice(0, -3)) : scope === path));
  return matches.length === 1 ? matches[0] : undefined;
}

export function correctionRoute(workers: HerdrWorker[], findings: ReviewFinding[]): { kind: "worker"; worker: HerdrWorker } | { kind: "pi-lead" } {
  const owners = findings.map((finding) => finding.file ? uniqueOwnerForPath(workers, finding.file) : undefined);
  const owner = owners[0];
  return owner && owners.every((candidate) => candidate?.id === owner.id) ? { kind: "worker", worker: owner } : { kind: "pi-lead" };
}

export function correctionOwner(file: string | undefined, workers: HerdrWorker[]): HerdrWorker | undefined {
  return file ? uniqueOwnerForPath(workers, file) : undefined;
}
