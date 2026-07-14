import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "test", "scripts"];
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(path));
    } else if (/\.(ts|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

for (const root of roots) {
  for (const file of await walk(root)) {
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");

    lines.forEach((line, index) => {
      if (/\s+$/.test(line)) {
        failures.push(`${file}:${index + 1}: trailing whitespace`);
      }
      if (line.includes("\t")) {
        failures.push(`${file}:${index + 1}: tab character`);
      }
    });
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("lint passed\n");
}
