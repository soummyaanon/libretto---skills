import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const port = Number.parseInt(process.env.PORT ?? "4177", 10);
const jobs = new Map();

const extractCandidatesScript = `
await page.waitForTimeout(3000);
const text = await page.locator('body').innerText();
const chunks = text
  .split(/\\n(?=LinkedIn Member\\b)/)
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.startsWith('LinkedIn Member'));
const candidates = chunks.slice(0, 10).map((chunk) => {
  const lines = chunk.split('\\n').map((line) => line.trim()).filter(Boolean);
  const headline = lines[1] || '';
  return {
    displayName: lines[0] || 'LinkedIn Member',
    headline,
    location: lines.find((line) =>
      line !== headline &&
      (
        /,\\s*(India|Maharashtra|Karnataka|Telangana|Tamil Nadu|Gujarat|West Bengal)/i.test(line) ||
        /^(India|Greater Bengaluru Area|Bengaluru|Mumbai|Pune|Gurugram|Hyderabad|Kolkata)\\b/i.test(line)
      )
    ) || '',
    evidence: lines.filter((line) => /\\bAI\\b|founder|engineer|building|voice|enterprise|product|automation/i.test(line)).slice(0, 4)
  };
}).filter((candidate) => candidate.headline);
return { url: page.url(), candidates };
`;

const extractProfilePostsScript = `
await page.waitForTimeout(4000);
const links = await page.locator('a[href*="/feed/update/"]').evaluateAll((anchors) => {
  const seen = new Set();
  return anchors
    .map((anchor) => ({
      url: anchor.href,
      text: (anchor.innerText || '').trim()
    }))
    .filter((item) => {
      if (!item.url || !item.text || item.text.length < 20) return false;
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
});
return { url: page.url(), posts: links };
`;

const extractCurrentPostScript = `
await page.waitForTimeout(4000);
const bodyText = await page.locator('body').innerText();
const lines = bodyText
  .split('\\n')
  .map((line) => line.trim())
  .filter(Boolean);
const start = lines.findIndex((line) => line === 'Feed post');
const endMarkers = ['Like', 'Comment', 'Repost', 'Send', 'Be the first to comment'];
const contentLines = [];
for (const line of lines.slice(start >= 0 ? start + 1 : 0)) {
  if (endMarkers.includes(line) && contentLines.length > 4) break;
  contentLines.push(line);
}
return {
  url: page.url(),
  text: contentLines.join('\\n'),
  rawText: bodyText.slice(0, 6000)
};
`;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolveBody(body));
    req.on("error", rejectBody);
  });
}

function createJob({ text, publish }) {
  const id = randomUUID();
  const session = `linkedin-poc-${id.slice(0, 8)}`;
  const job = {
    id,
    session,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: "",
  };

  jobs.set(id, job);

  const args = [
    "pnpm",
    "-s",
    "--filter",
    "libretto",
    "cli",
    "run",
    "./workflows/linkedin-post-draft.ts",
    "--headed",
    "--session",
    session,
    "--auth-profile",
    "linkedin.com",
    "--params",
    JSON.stringify({ text, publish }),
    "--stay-open-on-success",
  ];

  const child = spawn("corepack", args, {
    cwd: repoRoot,
    env: process.env,
  });

  child.stdout.on("data", (chunk) => {
    job.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    job.output += chunk.toString();
  });
  child.on("error", (error) => {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.output += `\n${error.message}`;
  });
  child.on("close", (code) => {
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

function runLibretto(args, onOutput) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("corepack", ["pnpm", "-s", "--filter", "libretto", "cli", ...args], {
      cwd: repoRoot,
      env: process.env,
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      output += value;
      onOutput(value);
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      output += value;
      onOutput(value);
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code === 0) {
        resolveRun(output);
        return;
      }
      rejectRun(new Error(output || `Libretto exited with code ${code}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function createDraft(candidate, goal, tone) {
  const topic = candidate.evidence[0] || candidate.headline;
  const closer =
    tone === "professional"
      ? "Would you be open to a quick conversation?"
      : "Would be open to connecting?";
  return `Hi, saw your LinkedIn result around ${topic}. Your work on ${candidate.headline} looked relevant to what I am exploring around ${goal}. ${closer}`;
}

function cleanPostText(text) {
  return text
    .replace(/\n\s*… more\s*/g, "\n")
    .replace(/^Post\s*/i, "")
    .replace(/^Feed post\s*/i, "")
    .replace(/^(.*?)\n\s*•.*?\n/im, "")
    .replace(/^\d+[a-z]?\s*•\s*/im, "")
    .replace(/^Follow\s*/gim, "")
    .replace(/\n\d+\s+reactions?.*$/ims, "")
    .replace(/\n(?:Like|Comment|Repost|Send)\s*$/ims, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function analyzePost(postText) {
  const text = cleanPostText(postText);
  const lowerText = text.toLowerCase();
  const topics = [
    lowerText.includes("debug") ? "debugging" : null,
    lowerText.includes("agent") || lowerText.includes("ai") ? "AI agents" : null,
    lowerText.includes("workflow") ? "workflows" : null,
    lowerText.includes("plugin") ? "developer tooling" : null,
    lowerText.includes("cursor") || lowerText.includes("claude") ? "coding assistants" : null,
    lowerText.includes("market") || lowerText.includes("stock") ? "market intelligence" : null,
  ].filter(Boolean);

  const firstSentence = text.split(/[.!?]\s+/)[0]?.slice(0, 180) || text.slice(0, 180);
  return {
    summary: firstSentence,
    topics: topics.length > 0 ? topics : ["product update"],
    signals: text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 24)
      .slice(0, 4),
  };
}

function createCommentDraft(postText, tone) {
  const analysis = analyzePost(postText);
  const lowerText = postText.toLowerCase();
  if (lowerText.includes("debugging for coding agents") || lowerText.includes("coding agents")) {
    return tone === "professional"
      ? "This is a useful direction. Debugging support for coding agents is becoming a real need, especially when teams want evidence instead of guesswork."
      : "This is useful. Debugging for coding agents is exactly where better tooling can save a lot of wasted guessing.";
  }
  if (lowerText.includes("claude code") || lowerText.includes("anthropic")) {
    return tone === "professional"
      ? "Great move. Developer tooling around AI is becoming one of the most important places to build right now."
      : "That is exciting. Developer tooling with AI is moving fast, and this feels like the right place to be building.";
  }
  if (lowerText.includes("arthion is coming")) {
    return tone === "professional"
      ? "Looking forward to seeing what Arthion brings. The positioning already sounds interesting."
      : "Excited to see what Arthion is cooking. Looking forward to the launch.";
  }
  if (lowerText.includes("arthmarket") || lowerText.includes("market analysis")) {
    return tone === "professional"
      ? "This is a useful direction. Real-time market data, technical indicators, and fundamentals in one AI workflow could remove a lot of tool-switching for analysis."
      : "This looks useful. Pulling quotes, indicators, fundamentals, and movers into one AI workflow could save a lot of back-and-forth during market research.";
  }
  const topic = analysis.topics[0] ?? "this";
  if (tone === "professional") {
    return `Strong point on ${topic}. I like how this connects the problem to a practical workflow instead of keeping it abstract. Curious to see how this evolves.`;
  }
  return `This is a solid take on ${topic}. I like the practical angle here, especially the focus on making the workflow actually usable.`;
}

function analyzeCandidate(candidate) {
  const evidence = candidate.evidence.length > 0 ? candidate.evidence : [candidate.headline];
  const lowerText = evidence.join(" ").toLowerCase();
  const topics = [
    lowerText.includes("ai") ? "AI" : null,
    lowerText.includes("machine learning") || lowerText.includes("ml") ? "machine learning" : null,
    lowerText.includes("engineer") ? "engineering" : null,
    lowerText.includes("founder") ? "founder/operator" : null,
    lowerText.includes("data") ? "data" : null,
  ].filter(Boolean);

  return {
    summary: `${candidate.headline} appears relevant based on visible LinkedIn search text.`,
    topics: topics.length > 0 ? topics : ["general technology"],
    signals: evidence,
    limitations:
      candidate.displayName === "LinkedIn Member"
        ? "LinkedIn did not expose a public name or profile URL in this search result, so full post analysis and direct DM are blocked."
        : "Only visible search-result text was analyzed in this POC.",
  };
}

function parseExecJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not find JSON output from Libretto.");
  }
  return JSON.parse(output.slice(start, end + 1));
}

function parseJsonOutput(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not find JSON output from Libretto inspection.");
  }
  return JSON.parse(output.slice(start, end + 1));
}

function buildCommentPostScript(comment) {
  return `
const comment = ${JSON.stringify(comment)};
await page.waitForTimeout(3000);
const editor = page.locator('[aria-label="Text editor for creating comment"], [contenteditable="true"]').last();
await editor.click();
await page.keyboard.insertText(comment);
await page.waitForTimeout(1000);
const buttons = page.getByRole('button', { name: /^Comment$/ });
await buttons.last().click();
await page.waitForTimeout(3000);
return { url: page.url(), status: 'comment-submitted', comment };
`;
}

function createProfileCommentJob({ profileUrl, limit, tone, publishComments }) {
  const id = randomUUID();
  const session = `linkedin-profile-${id.slice(0, 8)}`;
  const job = {
    id,
    type: "profile-comments",
    session,
    status: "running",
    step: "Opening profile",
    progress: { processed: 0, total: limit },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: "",
    results: [],
  };

  jobs.set(id, job);

  queueMicrotask(async () => {
    try {
      await runLibretto(["open", profileUrl, "--headed", "--session", session], (value) => {
        job.output += value;
      });

      job.step = "Finding visible profile posts";
      const rawPosts = await runLibretto(["exec", "--session", session, extractProfilePostsScript], (value) => {
        job.output += value;
      });
      const extracted = parseExecJson(rawPosts);
      const posts = extracted.posts.slice(0, limit);
      job.progress.total = posts.length;

      for (const post of posts) {
        job.step = `Analyzing post ${job.progress.processed + 1}/${posts.length}`;
        await runLibretto(["exec", "--session", session, `await page.goto(${JSON.stringify(post.url)}, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000); return { url: page.url() };`], (value) => {
          job.output += value;
        });

        const rawPostContext = await runLibretto(["exec", "--session", session, extractCurrentPostScript], (value) => {
          job.output += value;
        });
        const currentPost = parseExecJson(rawPostContext);
        const postText = cleanPostText(currentPost.text || post.text);
        const analysis = analyzePost(postText);
        const commentDraft = createCommentDraft(postText, tone);
        const result = {
          postUrl: post.url,
          postText,
          rawPostText: currentPost.rawText,
          analysis,
          commentDraft,
          status: publishComments ? "posting-comment" : "drafted",
        };

        job.results.push(result);
        job.progress.processed = job.results.length;

        if (publishComments) {
          job.step = `Posting comment ${job.progress.processed}/${posts.length}`;
          await runLibretto(["exec", "--session", session, buildCommentPostScript(commentDraft)], (value) => {
            job.output += value;
          });
          result.status = "commented";
        }

        await delay(1_500);
      }

      job.status = "completed";
      job.step = publishComments ? "Completed comment posting" : "Completed comment drafts";
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.step = "Failed";
      job.finishedAt = new Date().toISOString();
      job.output += `\n${error instanceof Error ? error.message : String(error)}`;
    }
  });

  return job;
}

function createOutreachJob({ query, limit, goal, tone }) {
  const id = randomUUID();
  const session = `linkedin-long-${id.slice(0, 8)}`;
  const job = {
    id,
    type: "outreach",
    session,
    status: "running",
    step: "Starting LinkedIn search",
    progress: { processed: 0, total: limit },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: "",
    results: [],
  };

  jobs.set(id, job);

  queueMicrotask(async () => {
    try {
      const searchUrl = new URL("https://www.linkedin.com/search/results/people/");
      searchUrl.searchParams.set("keywords", query);

      job.step = "Opening LinkedIn";
      await runLibretto(
        [
          "open",
          searchUrl.toString(),
          "--headed",
          "--session",
          session,
        ],
        (value) => {
          job.output += value;
        },
      );

      job.step = "Extracting visible candidates";
      const raw = await runLibretto(["exec", "--session", session, extractCandidatesScript], (value) => {
        job.output += value;
      });
      const extracted = parseJsonOutput(raw);
      const candidates = extracted.candidates.slice(0, limit);
      job.progress.total = candidates.length;

      for (const candidate of candidates) {
        job.step = `Analyzing ${candidate.headline}`;
        await delay(2_000);
        const analysis = analyzeCandidate(candidate);
        const dmDraft = createDraft(candidate, goal, tone);
        job.results.push({
          ...candidate,
          analysis,
          dmDraft,
          draft: dmDraft,
          nextAction:
            candidate.displayName === "LinkedIn Member"
              ? "Open this result manually in LinkedIn or search by a visible profile/company before DM."
              : "Review the DM draft before sending.",
          canDm: false,
        });
        job.progress.processed = job.results.length;
      }

      job.status = "completed";
      job.step = "Completed draft generation";
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = "failed";
      job.step = "Failed";
      job.finishedAt = new Date().toISOString();
      job.output += `\n${error instanceof Error ? error.message : String(error)}`;
    }
  });

  return job;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(join(__dirname, "linkedin-post-poc.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const rawBody = await readBody(req);
      const parsed = JSON.parse(rawBody);
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      const publish = parsed.publish === true;

      if (!text) {
        sendJson(res, 400, { error: "Post text is required." });
        return;
      }

      const job = createJob({ text, publish });
      sendJson(res, 202, job);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/outreach-jobs") {
      const rawBody = await readBody(req);
      const parsed = JSON.parse(rawBody);
      const query = typeof parsed.query === "string" && parsed.query.trim()
        ? parsed.query.trim()
        : "AI engineer India";
      const goal = typeof parsed.goal === "string" && parsed.goal.trim()
        ? parsed.goal.trim()
        : "browser automation and AI agent workflow help";
      const tone = parsed.tone === "professional" ? "professional" : "casual";
      const requestedLimit = Number.parseInt(String(parsed.limit ?? "5"), 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(10, requestedLimit))
        : 5;

      const job = createOutreachJob({ query, limit, goal, tone });
      sendJson(res, 202, job);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/profile-comment-jobs") {
      const rawBody = await readBody(req);
      const parsed = JSON.parse(rawBody);
      const profileUrl = typeof parsed.profileUrl === "string" ? parsed.profileUrl.trim() : "";
      const tone = parsed.tone === "professional" ? "professional" : "casual";
      const publishComments = parsed.publishComments === true;
      const requestedLimit = Number.parseInt(String(parsed.limit ?? "2"), 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(5, requestedLimit))
        : 2;

      if (!/^https:\/\/www\.linkedin\.com\/in\/[^/]+\/?/.test(profileUrl)) {
        sendJson(res, 400, { error: "Paste a valid LinkedIn profile URL." });
        return;
      }

      const job = createProfileCommentJob({ profileUrl, limit, tone, publishComments });
      sendJson(res, 202, job);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = url.pathname.slice("/api/jobs/".length);
      const job = jobs.get(id);
      if (!job) {
        sendJson(res, 404, { error: "Job not found." });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(res, 500, { error: message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`LinkedIn POC running at http://127.0.0.1:${port}`);
});
