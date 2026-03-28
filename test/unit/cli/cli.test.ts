import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = join(process.cwd(), "src/cli.ts");

function makeTempDir(): string {
  const dir = join(tmpdir(), `cloudcost-cli-test-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTfFile(dir: string, content: string): string {
  const path = join(dir, "main.tf");
  writeFileSync(path, content);
  return path;
}

const SAMPLE_TF = `
resource "aws_instance" "web" {
  instance_type = "t3.micro"
  ami           = "ami-12345678"
}
`;

describe("CLI", () => {
  let tmpDir: string;

  it("shows usage when --help is passed", () => {
    const result = execSync(`node --import tsx/esm ${CLI_PATH} --help`, {
      env: { ...process.env, CLOUDCOST_LOG_LEVEL: "error" },
      encoding: "utf-8",
    });

    expect(result).toContain("Usage:");
    expect(result).toContain("analyze");
    expect(result).toContain("estimate");
    expect(result).toContain("compare");
    expect(result).toContain("optimize");
  });

  it("exits non-zero with no arguments", () => {
    let threw = false;
    try {
      execSync(`node --import tsx/esm ${CLI_PATH}`, {
        env: { ...process.env, CLOUDCOST_LOG_LEVEL: "error" },
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("analyze command produces JSON output with --json flag", () => {
    tmpDir = makeTempDir();
    writeTfFile(tmpDir, SAMPLE_TF);

    const result = execSync(`node --import tsx/esm ${CLI_PATH} analyze ${tmpDir} --json`, {
      env: { ...process.env, CLOUDCOST_LOG_LEVEL: "error" },
      encoding: "utf-8",
    });

    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty("resources");
    expect(Array.isArray(parsed.resources)).toBe(true);

    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("estimate command returns cost data", () => {
    tmpDir = makeTempDir();
    writeTfFile(tmpDir, SAMPLE_TF);

    const result = execSync(
      `node --import tsx/esm ${CLI_PATH} estimate ${tmpDir} --provider aws --json`,
      {
        env: { ...process.env, CLOUDCOST_LOG_LEVEL: "error" },
        encoding: "utf-8",
      },
    );

    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty("total_monthly");
    expect(typeof parsed.total_monthly).toBe("number");

    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });
});
