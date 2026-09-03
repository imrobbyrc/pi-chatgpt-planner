import type { HerdrExecutionContract, HerdrWorker } from "./types.js";

export type WorkerState = "pending" | "blocked" | "ready" | "starting" | "running" | "completed" | "failed" | "cancelled";
export function validateHerdrContract(contract: HerdrExecutionContract): void {
  if (contract.mode !== "herdr" || contract.workerModel !== "luna-max") throw new Error("Invalid Herdr execution contract: worker model is fixed to Luna Max.");
  const workers = contract.workers;
  if (workers.length < 1 || workers.length > 4) throw new Error("Invalid Herdr execution contract: worker count must be between 1 and 4.");
  const ids = new Set<string>();
  for (const worker of workers) {
    if (!worker.id || ids.has(worker.id)) throw new Error("Invalid Herdr execution contract: worker IDs must be unique.");
    if (!worker.objective.trim()) throw new Error(`Invalid Herdr worker ${worker.id}: objective is required.`);
    if (!worker.owns.length || worker.owns.some((scope) => !scope.trim())) throw new Error(`Invalid Herdr worker ${worker.id}: ownership is required.`);
    ids.add(worker.id);
  }
  for (const worker of workers) for (const dep of worker.dependsOn) if (dep === worker.id || !ids.has(dep)) throw new Error(`Invalid Herdr dependency: ${worker.id} -> ${dep}.`);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => { if (visiting.has(id)) throw new Error("Invalid Herdr execution contract: dependency cycle detected."); if (visited.has(id)) return; visiting.add(id); for (const dep of workers.find((w) => w.id === id)!.dependsOn) visit(dep); visiting.delete(id); visited.add(id); };
  for (const worker of workers) visit(worker.id);
}

/** Conservative glob overlap: broad, malformed, or uncertain scopes serialize. */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.some(isBroad) || b.some(isBroad)) return true;
  return a.some((left) => b.some((right) => left === right || left.startsWith(right.replace(/\*+$/, "")) || right.startsWith(left.replace(/\*+$/, ""))));
}
function isBroad(scope: string): boolean { return !/^[\w./*-]+$/.test(scope) || scope === "*" || scope === "**" || !scope.includes("/"); }

export function readyWorkers(workers: HerdrWorker[], states: Map<string, WorkerState>): HerdrWorker[] {
  return workers.filter((worker) => (states.get(worker.id) ?? "pending") === "pending" && worker.dependsOn.every((id) => states.get(id) === "completed"));
}
export function canRunTogether(a: HerdrWorker, b: HerdrWorker): boolean { return !scopesOverlap(a.owns, b.owns); }
