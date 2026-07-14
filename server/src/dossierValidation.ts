import { isIP } from "node:net";
import type { ResearchDossier } from "./providers.js";

export interface DossierValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export interface SafeSourceMetadata {
  readonly url: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly fetchedAt: string;
}

export interface SafeSourceFetcherOptions {
  readonly fetchImpl?: typeof fetch;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly now?: () => string;
}

export function validateDossier(dossier: ResearchDossier): DossierValidationResult {
  const issues: string[] = [];
  const sourceIds = new Set(dossier.sources.map((source) => source.id));

  if (dossier.groundingMetadata.length === 0) {
    issues.push("missing grounding metadata");
  }
  if (dossier.claims.length === 0) {
    issues.push("missing source-backed claims");
  }
  if (dossier.chronology.length === 0) {
    issues.push("missing chronology");
  }
  if (dossier.dailyLifeDetails.length === 0) {
    issues.push("missing daily-life details");
  }

  for (const claim of dossier.claims) {
    if (claim.sourceIds.length === 0) {
      issues.push(`unsupported claim ${claim.id}: no source IDs`);
    }
    for (const sourceId of claim.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        issues.push(`unsupported claim ${claim.id}: unknown source ${sourceId}`);
      }
    }
  }

  const years = extractYears([...dossier.chronology, ...dossier.dailyLifeDetails, ...dossier.claims.map((claim) => claim.text)]);
  if (years.length >= 2 && Math.max(...years) - Math.min(...years) > 1500) {
    issues.push("conflicting dates span more than 1500 years");
  }
  if (dossier.era && years.some((year) => !eraContainsYear(dossier.era ?? "", year))) {
    issues.push("conflicting dates fall outside the requested era");
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

export async function safeSourceFetcher(
  url: string,
  options: SafeSourceFetcherOptions = {}
): Promise<SafeSourceMetadata> {
  if (!options.fetchImpl || !options.resolveHost) {
    throw new Error("Live source fetching is disabled; provide a controlled fetch implementation and resolver");
  }

  const fetchImpl = options.fetchImpl;
  const resolveHost = options.resolveHost;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxBytes ?? 256_000;
  const now = options.now ?? (() => new Date().toISOString());
  let currentUrl = await validateSafeUrl(url, resolveHost);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);

    try {
      const response = await fetchImpl(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect response missing location");
        }
        if (redirectCount === maxRedirects) {
          throw new Error("Redirect limit exceeded");
        }

        currentUrl = await validateSafeUrl(new URL(location, currentUrl).toString(), resolveHost);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Source fetch failed: ${response.status}`);
      }

      const contentLength = readContentLength(response.headers.get("content-length"));
      if (contentLength !== undefined && contentLength > maxBytes) {
        throw new Error("Source response exceeds size limit");
      }

      const text = await readLimitedText(response, maxBytes);
      return {
        url,
        finalUrl: currentUrl.toString(),
        title: extractHtmlTitle(text),
        contentType: sanitizeHeader(response.headers.get("content-type")),
        contentLength: contentLength ?? new TextEncoder().encode(text).byteLength,
        fetchedAt: now()
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Redirect limit exceeded");
}

async function validateSafeUrl(
  url: string,
  resolveHost: (hostname: string) => Promise<readonly string[]>
): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS source URLs are allowed");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error("Private or local source hosts are blocked");
  }
  const addresses = await resolveHost(parsed.hostname);
  if (addresses.length === 0) {
    throw new Error("Source host did not resolve");
  }
  if (addresses.some(isBlockedHost)) {
    throw new Error("Private or local source hosts are blocked");
  }

  return parsed;
}

function isBlockedHost(hostname: string): boolean {
  const lower = normalizeHostname(hostname);
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    return true;
  }

  const ipVersion = isIP(lower);
  if (ipVersion === 4) {
    return isBlockedIPv4(lower);
  }
  if (ipVersion === 6) {
    return isBlockedIPv6(lower);
  }

  return false;
}

function isBlockedIPv4(address: string): boolean {
  const [first = 0, second = 0] = address.split(".").map(Number);

  return first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19));
}

function isBlockedIPv6(address: string): boolean {
  const hextets = parseIPv6Hextets(address);
  if (!hextets) {
    return true;
  }

  const mappedIPv4 = parseIPv4MappedIPv6(hextets);
  if (mappedIPv4) {
    return isBlockedIPv4(mappedIPv4);
  }

  const [firstHextet = 0, secondHextet = 0] = hextets;
  const isUnspecified = hextets.every((hextet) => hextet === 0);
  const isLoopback = hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1;

  return isUnspecified ||
    isLoopback ||
    firstHextet >= 0xfc00 && firstHextet <= 0xfdff ||
    firstHextet >= 0xfe80 && firstHextet <= 0xfebf ||
    firstHextet >= 0xff00 ||
    (firstHextet === 0x2001 && secondHextet === 0x0db8) ||
    firstHextet === 0x2002;
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) {
    return lower.slice(1, -1);
  }

  return lower;
}

function parseIPv4MappedIPv6(hextets: readonly number[]): string | undefined {
  if (
    hextets.length !== 8 ||
    hextets.slice(0, 5).some((hextet) => hextet !== 0) ||
    hextets[5] !== 0xffff
  ) {
    return undefined;
  }

  const high = hextets[6] ?? 0;
  const low = hextets[7] ?? 0;
  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff
  ].join(".");
}

function parseIPv6Hextets(address: string): readonly number[] | undefined {
  const withoutZone = address.split("%")[0] ?? address;
  const withEmbeddedIPv4 = normalizeEmbeddedIPv4(withoutZone);
  const parts = withEmbeddedIPv4.split("::");
  if (parts.length > 2) {
    return undefined;
  }

  const left = splitIPv6Side(parts[0] ?? "");
  const right = splitIPv6Side(parts[1] ?? "");
  if (!left || !right) {
    return undefined;
  }

  const missingCount = parts.length === 2 ? 8 - left.length - right.length : 0;
  if (missingCount < 0 || (parts.length === 1 && left.length !== 8)) {
    return undefined;
  }

  return [...left, ...Array.from({ length: missingCount }, () => 0), ...right];
}

function normalizeEmbeddedIPv4(address: string): string {
  const lastColon = address.lastIndexOf(":");
  if (lastColon < 0) {
    return address;
  }

  const maybeIPv4 = address.slice(lastColon + 1);
  if (isIP(maybeIPv4) !== 4) {
    return address;
  }

  const [first = 0, second = 0, third = 0, fourth = 0] = maybeIPv4.split(".").map(Number);
  const high = ((first << 8) | second).toString(16);
  const low = ((third << 8) | fourth).toString(16);
  return `${address.slice(0, lastColon)}:${high}:${low}`;
}

function splitIPv6Side(value: string): readonly number[] | undefined {
  if (!value) {
    return [];
  }

  const hextets = value.split(":").map((segment) => {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return undefined;
    }

    return Number.parseInt(segment, 16);
  });

  if (hextets.some((hextet) => hextet === undefined)) {
    return undefined;
  }

  return hextets as readonly number[];
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let byteLength = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    byteLength += result.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new Error("Source response exceeds size limit");
    }
    chunks.push(decoder.decode(result.value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

function readContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeHeader(value: string | null): string | undefined {
  return value?.replace(/[\r\n]/g, "").slice(0, 120);
}

function extractHtmlTitle(text: string): string | undefined {
  const lower = text.toLowerCase();
  const titleOpenStart = lower.indexOf("<title");
  if (titleOpenStart < 0) {
    return undefined;
  }

  const titleOpenEnd = lower.indexOf(">", titleOpenStart);
  const titleCloseStart = lower.indexOf("</title>", titleOpenEnd);
  if (titleOpenEnd < 0 || titleCloseStart < 0 || titleCloseStart <= titleOpenEnd) {
    return undefined;
  }

  return text.slice(titleOpenEnd + 1, titleCloseStart).replace(/\s+/g, " ").trim().slice(0, 160);
}

function extractYears(values: readonly string[]): readonly number[] {
  return values.flatMap((value) => {
    const matches = value.match(/\b([1-9][0-9]{2,3}|20[0-9]{2})\b/g) ?? [];
    return matches.map(Number);
  });
}

function eraContainsYear(era: string, year: number): boolean {
  const parsedCentury = parseCentury(era);
  if (parsedCentury !== undefined) {
    const century = parsedCentury;
    return year >= ((century - 1) * 100) + 1 && year <= century * 100;
  }

  const eraYears = extractYears([era]);
  if (eraYears.length === 0) {
    return true;
  }
  if (eraYears.length >= 2) {
    return year >= Math.min(...eraYears) && year <= Math.max(...eraYears);
  }
  if (eraYears.length === 1) {
    const eraYear = eraYears[0] ?? year;
    return Math.abs(year - eraYear) <= 100;
  }

  return true;
}

function parseCentury(era: string): number | undefined {
  const tokens = tokenize(era);
  const centuryIndex = tokens.indexOf("century");
  if (centuryIndex <= 0) {
    return undefined;
  }

  const candidate = tokens[centuryIndex - 1];
  const digits = [...candidate].filter((character) => character >= "0" && character <= "9").join("");
  if (digits.length === 0) {
    return undefined;
  }

  const century = Number(digits);
  return Number.isInteger(century) && century > 0 ? century : undefined;
}

function tokenize(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";

  for (const character of value.toLowerCase()) {
    const isLetter = character >= "a" && character <= "z";
    const isDigit = character >= "0" && character <= "9";
    if (isLetter || isDigit) {
      current += character;
    } else if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
