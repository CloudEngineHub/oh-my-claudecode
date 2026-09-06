/**
 * Run-directory containment for graph runtime persistence (P1-3).
 *
 * Every persisted artifact lives under `<runsRoot>/<run_id>/`. A run_id is
 * descriptor-supplied and therefore untrusted: resolving it must never let a
 * traversal-shaped id or a symlinked run directory redirect writes outside
 * the runs root. resolveRunDir validates, creates, and containment-checks
 * the directory with a Linux directory FD, failing closed on any escape or
 * on platforms without that primitive.
 */
export interface RunDirHandle {
    readonly path: string;
    readonly device: number;
    readonly inode: number;
}
/**
 * Resolve (and create) the contained run directory for one run.
 *
 * Returns the plain `join(runsRoot, runId)` path so existing relative
 * behaviors stay stable; containment is enforced against an open directory
 * FD before returning. Throws RangeError("invalid run_id") on malformed ids
 * and Error on symlinked or escaping directories.
 */
export declare function resolveRunDir(runsRoot: string, runId: string): string;
/** Resolve a run directory and capture the directory identity for safe I/O. */
export declare function resolveRunDirHandle(runsRoot: string, runId: string): RunDirHandle;
//# sourceMappingURL=run-dir.d.ts.map