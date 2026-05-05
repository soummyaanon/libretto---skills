#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const VALID_AXES = new Set([
  "data",
  "control-flow",
  "concurrency",
  "config",
  "deps",
  "env",
  "contract",
]);

function parseArgs(argv) {
  const args = {
    hypothesesPath: "",
    artifactsDir: "",
    auto: false,
    reproLogPath: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--hypotheses") {
      args.hypothesesPath = argv[++i] ?? "";
    } else if (token === "--artifacts-dir") {
      args.artifactsDir = argv[++i] ?? "";
    } else if (token === "--repro-log") {
      args.reproLogPath = argv[++i] ?? "";
    } else if (token === "--auto") {
      args.auto = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!args.hypothesesPath) {
    throw new Error("Missing required flag: --hypotheses <path>");
  }
  if (!args.artifactsDir) {
    throw new Error("Missing required flag: --artifacts-dir <path>");
  }
  if (!args.reproLogPath) {
    throw new Error("Missing required flag: --repro-log <path>");
  }

  return args;
}

function loadHypotheses(hypothesesPath) {
  const raw = fs.readFileSync(hypothesesPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Hypotheses file must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("Hypotheses file cannot be empty");
  }
  return parsed.map((h, idx) => {
    const id = String(h.id ?? `H${idx + 1}`);
    const origin = String(h.origin ?? "primary");
    const axis = String(h.axis ?? "");
    const claim = String(h.claim ?? "").trim();
    const exp = String(h.exp ?? "").trim();
    const cost = String(h.cost ?? "medium");
    const command = String(h.command ?? "").trim();
    const killIf = String(h.killIf ?? "").trim();

    if (!VALID_AXES.has(axis)) {
      throw new Error(`Hypothesis ${id}: invalid axis "${axis}"`);
    }
    if (!claim) {
      throw new Error(`Hypothesis ${id}: missing claim`);
    }
    if (!["probe", "assertion", "test"].includes(exp)) {
      throw new Error(`Hypothesis ${id}: exp must be probe/assertion/test`);
    }
    if (!command) {
      throw new Error(`Hypothesis ${id}: missing command`);
    }
    if (!["exit0", "exitNonZero"].includes(killIf)) {
      throw new Error(`Hypothesis ${id}: killIf must be exit0 or exitNonZero`);
    }
    return { id, origin, axis, claim, exp, cost, command, killIf };
  });
}

function enforceCoverage(hypotheses) {
  const axes = new Set(hypotheses.map((h) => h.axis));
  if (axes.size < 4) {
    throw new Error(
      `Need hypotheses across at least 4 axes; found ${axes.size}: ${[...axes].join(", ")}`,
    );
  }
}

function renderGate1(hypotheses) {
  const lines = [
    "| ID | Origin | Axis | Claim (<=80 chars) | Exp | Cost |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const h of hypotheses) {
    const claim = h.claim.length > 80 ? `${h.claim.slice(0, 77)}...` : h.claim;
    lines.push(`| ${h.id} | ${h.origin} | ${h.axis} | ${claim} | ${h.exp} | ${h.cost} |`);
  }
  return lines.join("\n");
}

function renderGate2(results) {
  const rank = { killed: 0, survived: 1, inconclusive: 2 };
  const sorted = [...results].sort((a, b) => rank[a.verdict] - rank[b.verdict]);
  const lines = [
    "| ID | Origin | Axis | Verdict | Evidence (<=60 chars) |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of sorted) {
    const evidence = r.evidence.length > 60 ? `${r.evidence.slice(0, 57)}...` : r.evidence;
    lines.push(`| ${r.id} | ${r.origin} | ${r.axis} | ${r.verdict} | ${evidence} |`);
  }
  return lines.join("\n");
}

function runExperiment(h, artifactsDir) {
  const result = spawnSync("bash", ["-lc", h.command], {
    encoding: "utf8",
    cwd: process.cwd(),
  });

  const code = typeof result.status === "number" ? result.status : 1;
  const logPath = path.join(artifactsDir, `${h.id}.log`);
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  fs.writeFileSync(logPath, combined, "utf8");

  if (result.error) {
    return {
      verdict: "inconclusive",
      evidence: `spawn error: ${result.error.message}`,
      exitCode: code,
      logPath,
    };
  }

  const isKill = (h.killIf === "exit0" && code === 0) || (h.killIf === "exitNonZero" && code !== 0);
  const verdict = isKill ? "killed" : "survived";
  const evidence = `exit=${code}; killIf=${h.killIf}`;
  return { verdict, evidence, exitCode: code, logPath };
}

async function gate1(hypotheses, auto) {
  const table = renderGate1(hypotheses);
  console.log("\n## Gate 1 — hypothesis review");
  console.log(table);

  if (auto) {
    console.log("\n[auto] selected: run all");
    return "run-all";
  }

  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question("\n[Enter] run all · [e] edit · [s] skip -> ")).trim().toLowerCase();
  rl.close();

  if (answer === "s") {
    return "skip";
  }
  if (answer === "e") {
    return "edit";
  }
  return "run-all";
}

function shipGuard(results) {
  const survived = results.filter((r) => r.verdict === "survived").length;
  const inconclusive = results.filter((r) => r.verdict === "inconclusive").length;
  const s = survived + inconclusive;
  return { s, survived, inconclusive };
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.artifactsDir, { recursive: true });

  const hypotheses = loadHypotheses(args.hypothesesPath);
  enforceCoverage(hypotheses);

  const gate1Decision = await gate1(hypotheses, args.auto);
  if (gate1Decision === "skip") {
    console.log("\nSkipped by user.");
    process.exit(0);
  }
  if (gate1Decision === "edit") {
    console.log("\nEdit selected. Update hypotheses JSON and rerun.");
    process.exit(2);
  }

  console.log("\n## Running experiments sequentially");
  const results = [];
  for (const h of hypotheses) {
    console.log(`- ${h.id}: ${h.command}`);
    const r = runExperiment(h, args.artifactsDir);
    results.push({ id: h.id, origin: h.origin, axis: h.axis, ...r });
    console.log(`  verdict=${r.verdict} (${r.evidence}) log=${r.logPath}`);
  }

  const gate2 = renderGate2(results);
  console.log("\n## Gate 2 — survival review");
  console.log(gate2);

  fs.writeFileSync(path.join(args.artifactsDir, "gate1.md"), renderGate1(hypotheses), "utf8");
  fs.writeFileSync(path.join(args.artifactsDir, "gate2.md"), gate2, "utf8");
  fs.writeFileSync(
    path.join(args.artifactsDir, "summary.json"),
    JSON.stringify(
      {
        reproLog: args.reproLogPath,
        hypothesesPath: args.hypothesesPath,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  const { s, survived, inconclusive } = shipGuard(results);
  console.log(`\nS = survived(${survived}) + inconclusive(${inconclusive}) = ${s}`);

  if (s !== 1) {
    console.error(
      `\n${s} hypotheses still alive. Shipping fix now = guessing which one. Run another round of falsification, or explicitly accept you're guessing?`,
    );
    process.exit(3);
  }

  const winner = results.find((r) => r.verdict === "survived" || r.verdict === "inconclusive");
  console.log(`\nSingle survivor: ${winner?.id}. Safe to implement minimal fix and promote a regression test.`);
}

main().catch((error) => {
  console.error(`debug-go failed: ${error.message}`);
  process.exit(1);
});
