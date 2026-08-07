import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for the duplicated shebang that shipped in every release up
 * to and including v1.2.0.
 *
 * tsup injects `#!/usr/bin/env node` into every bundle via `banner.js`. When a
 * source entrypoint also carried its own shebang, the built file began with two
 * of them. Node strips only a shebang on line 1, so the second one parsed as
 * code and `cloudcost` died on startup with
 * `SyntaxError: Invalid or unexpected token`.
 *
 * The pre-existing CLI tests all execute `src/cli.ts` directly, so none of them
 * ever loaded the artifact users actually run. These assertions deliberately
 * target the built output and the source invariant that produces it.
 */

const ROOT = process.cwd();
const BANNER = "#!/usr/bin/env node";

// The source invariant: tsup owns the shebang, so no entrypoint may declare one.
describe("source entrypoints", () => {
  for (const entry of ["src/cli.ts", "src/index.ts"]) {
    it(`${entry} does not declare its own shebang (tsup's banner supplies it)`, () => {
      const src = readFileSync(join(ROOT, entry), "utf8");
      expect(src.startsWith("#!")).toBe(false);
      // Line-level, not substring: prose may legitimately mention the banner.
      expect(src.split("\n").filter((l) => l.trimStart().startsWith("#!"))).toHaveLength(0);
    });
  }
});

// The built artifact: what npm actually ships and what `cloudcost` actually runs.
const dist = (f: string) => join(ROOT, "dist", f);
const built = existsSync(dist("cli.js")) && existsSync(dist("index.js"));

describe.runIf(built)("built bin files", () => {
  for (const file of ["cli.js", "index.js"]) {
    it(`dist/${file} has exactly one shebang, on line 1`, () => {
      const lines = readFileSync(dist(file), "utf8").split("\n");
      expect(lines[0]).toBe(BANNER);
      expect(lines.filter((l) => l.startsWith("#!"))).toHaveLength(1);
    });
  }

  it("dist/cli.js actually starts under node", () => {
    // --help exits 0 and prints usage; before the fix this threw SyntaxError.
    const out = execFileSync(process.execPath, [dist("cli.js"), "--help"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(out).toMatch(/usage/i);
  });
});
