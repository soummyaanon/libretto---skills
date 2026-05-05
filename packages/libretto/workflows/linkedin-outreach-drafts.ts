import { workflow } from "libretto";

type OutreachInput = {
  query?: string;
  limit?: number;
  goal?: string;
  tone?: "casual" | "professional";
};

type CandidateDraft = {
  displayName: string;
  headline: string;
  location: string;
  evidence: string[];
  relevanceScore: number;
  draft: string;
};

const DEFAULT_QUERY = "AI founders India";
const DEFAULT_GOAL = "browser automation and AI agent workflow help";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringParam(
  input: Record<string, unknown>,
  key: keyof OutreachInput,
  fallback: string,
): string {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberParam(
  input: Record<string, unknown>,
  key: keyof OutreachInput,
  fallback: number,
): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function buildSearchUrl(query: string): string {
  const url = new URL("https://www.linkedin.com/search/results/people/");
  url.searchParams.set("keywords", query);
  return url.toString();
}

function parseCandidates(pageText: string, limit: number): CandidateDraft[] {
  const chunks = pageText
    .split(/\n(?=LinkedIn Member\b)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("LinkedIn Member"));

  return chunks
    .map((chunk) => {
      const lines = chunk
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const displayName = lines[0] ?? "LinkedIn Member";
      const headline = lines[1] ?? "";
      const location =
        lines.find((line) => /\bIndia\b|Bengaluru|Mumbai|Pune|Gurugram/i.test(line)) ?? "";
      const evidence = lines
        .filter((line) => /\bAI\b|founder|building|voice|enterprise|product|policy/i.test(line))
        .slice(0, 4);
      const relevanceScore = evidence.reduce((score, line) => {
        const lower = line.toLowerCase();
        return (
          score +
          (lower.includes("ai") ? 2 : 0) +
          (lower.includes("founder") ? 2 : 0) +
          (lower.includes("building") ? 1 : 0) +
          (lower.includes("voice") ? 1 : 0) +
          (lower.includes("product") ? 1 : 0)
        );
      }, 0);

      return {
        displayName,
        headline,
        location,
        evidence,
        relevanceScore,
        draft: "",
      };
    })
    .filter((candidate) => candidate.headline)
    .sort((left, right) => right.relevanceScore - left.relevanceScore)
    .slice(0, limit);
}

function createDraft(candidate: CandidateDraft, goal: string, tone: string): string {
  const topic = candidate.evidence[0] || candidate.headline;
  const greeting = candidate.displayName === "LinkedIn Member" ? "Hi" : `Hi ${candidate.displayName}`;
  const closer =
    tone === "casual"
      ? "Would be open to connecting?"
      : "Would you be open to a quick conversation?";

  return `${greeting}, saw your LinkedIn result around ${topic}. Your work on ${candidate.headline} looked relevant to what I am exploring around ${goal}. ${closer}`;
}

export default workflow("linkedin-outreach-drafts", async ({ page }, rawInput) => {
  const input = asRecord(rawInput);
  const query = stringParam(input, "query", DEFAULT_QUERY);
  const goal = stringParam(input, "goal", DEFAULT_GOAL);
  const tone = stringParam(input, "tone", "casual");
  const limit = numberParam(input, "limit", 5);

  await page.goto(buildSearchUrl(query), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);

  const pageText = await page.locator("body").innerText();
  const candidates = parseCandidates(pageText, limit).map((candidate) => ({
    ...candidate,
    draft: createDraft(candidate, goal, tone),
  }));

  return {
    query,
    goal,
    searchedUrl: page.url(),
    candidates,
    note: "Draft-only workflow. It does not send messages, connect, or perform contact actions.",
  };
});
