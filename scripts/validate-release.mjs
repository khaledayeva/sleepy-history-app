import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const iosRoot = join(projectRoot, "ios");

const textExtensions = new Set([
  ".swift",
  ".plist",
  ".yml",
  ".yaml",
  ".json",
  ".pbxproj",
  ".xcworkspacedata",
]);

const providerKeyNames = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
];

const staticAuthPatterns = [
  /Authorization["']?\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._~+/=-]{12,}/,
  /bearerToken\s*=\s*"[^"$][^"]{11,}"/,
  /static(Token|Bearer|Auth)\s*=\s*"[^"$][^"]{11,}"/i,
];

const broadAtsPatterns = [
  /<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/,
  /NSAllowsArbitraryLoads\s*:\s*true/,
  /<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/,
  /NSExceptionAllowsInsecureHTTPLoads\s*:\s*true/,
];

const findings = [];

function extensionFor(path) {
  const match = path.match(/\.[^.]+$/);
  return match ? match[0] : "";
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "xcuserdata") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!textExtensions.has(extensionFor(path))) continue;

    const text = readFileSync(path, "utf8");
    for (const keyName of providerKeyNames) {
      if (text.includes(keyName)) {
        findings.push(`${path}: provider key name ${keyName} must not appear in iOS sources`);
      }
    }
    for (const pattern of staticAuthPatterns) {
      if (pattern.test(text)) {
        findings.push(`${path}: possible bundled static authorization token`);
      }
    }
    for (const pattern of broadAtsPatterns) {
      if (pattern.test(text)) {
        findings.push(`${path}: broad ATS exception is not allowed for release validation`);
      }
    }
  }
}

walk(iosRoot);

if (findings.length > 0) {
  console.error("release validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("release validation passed");
