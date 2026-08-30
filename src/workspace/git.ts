import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout.trimEnd();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args.join(" ")} failed`);
  }
}

export async function gitStatus(root: string): Promise<string> {
  return git(root, ["status", "--short", "--branch"]);
}

export async function gitDiff(root: string, staged = false): Promise<string> {
  const args = ["diff", "--no-ext-diff", "--no-color"];
  if (staged) args.push("--cached");
  return git(root, args);
}

export async function gitBranch(root: string): Promise<string> {
  return git(root, ["branch", "--show-current"]);
}
