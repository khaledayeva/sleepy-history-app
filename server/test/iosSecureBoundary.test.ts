import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

function findRepoRoot(start: string): string {
  let current = start;

  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, "ios", "project.yml"))) {
      return current;
    }
    current = path.dirname(current);
  }

  throw new Error(`Could not find repo root from ${start}`);
}

const repoRoot = findRepoRoot(import.meta.dirname);
const iosRoot = path.join(repoRoot, "ios");
const scannedExtensions = new Set([".plist", ".swift", ".yml", ".yaml"]);
const skippedDirectories = new Set([
  "SleepyHistory.xcodeproj",
  "build",
  "DerivedData"
]);

const providerSecretNames = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "ELEVENLABS_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_MODEL"
];

const staticAuthTokenPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\b(owner|device|enrollment)[_-]?token\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{12,}["']/i,
  /\bAuthorization\s*[:=]\s*["'][^"']+["']/i
];

async function listIOSSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry);
    const metadata = await stat(fullPath);

    if (metadata.isDirectory()) {
      if (skippedDirectories.has(entry) || entry.endsWith(".xcassets")) {
        return [];
      }
      return listIOSSourceFiles(fullPath);
    }

    return scannedExtensions.has(path.extname(entry)) ? [fullPath] : [];
  }));

  return files.flat();
}

describe("iOS secure configuration boundary", () => {
  it("does not include provider secret names or static auth tokens in iOS sources", async () => {
    const files = await listIOSSourceFiles(iosRoot);

    assert.ok(files.length > 0, "expected iOS source files to be scanned");

    for (const file of files) {
      const contents = await readFile(file, "utf8");
      const relativePath = path.relative(repoRoot, file);

      for (const secretName of providerSecretNames) {
        assert.equal(
          contents.includes(secretName),
          false,
          `${relativePath} must not reference provider secret ${secretName}`
        );
      }

      for (const pattern of staticAuthTokenPatterns) {
        assert.equal(
          pattern.test(contents),
          false,
          `${relativePath} must not include a static authorization token`
        );
      }
    }
  });
});
