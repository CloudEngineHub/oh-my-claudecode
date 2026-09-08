/**
 * lookout CLI adapter tests: drive the real commander command so the
 * documented exit-code contract (0 clear / 1 --strict / 2 usage+scan
 * error), JSON stdout, and command registration cannot regress silently.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { lookoutCommand } from "../lookout.js";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "omc-lookout-cli-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "readme.md"), "x\n");
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function run(args: string[]): Promise<void> {
  await lookoutCommand().parseAsync(args, { from: "user" });
}

describe("lookout CLI adapter", () => {
  it("emits the machine-readable report on --json (exit 0)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["scan", "--brief", "hello world", "--json", "--repo", makeRepo()]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(report.summary.verdict).toBe("clear");
    expect(report.findings).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("exits 1 on --strict with a review-recommended verdict", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["scan", "--brief", "git push origin +main", "--strict", "--json", "--repo", makeRepo()]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("remaps missing option values to exit 2", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rejection = run(["scan", "--brief"]);
    await expect(rejection).rejects.toMatchObject({ exitCode: 2 });
    process.exitCode = undefined;
  });

  it("exits 2 with an error message for an unreadable briefing file", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["scan", "--brief", "@/nonexistent/omc-lookout-cli-brief.txt"]);
    expect(process.exitCode).toBe(2);
    expect(errorSpy.mock.calls[0]![0]).toContain("Cannot read briefing file");
    process.exitCode = undefined;
  });

  it("exits 2 for a nonexistent --repo path (fail closed)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(["scan", "--repo", "/nonexistent/omc-lookout-cli-repo"]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });
});
