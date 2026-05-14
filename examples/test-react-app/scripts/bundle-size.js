#!/usr/bin/env node
/**
 * Bundle size reporter + snapshot diff tool.
 *
 * Usage:
 *   node scripts/bundle-size.js show
 *   node scripts/bundle-size.js save <name>
 *   node scripts/bundle-size.js compare <before> <after>
 *
 * Snapshots are written to ./.bundle-snapshots/<name>.json
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BUILD_DIR = path.resolve(__dirname, "..", "dist");
const SNAPSHOT_DIR = path.resolve(__dirname, "..", ".bundle-snapshots");

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      out.push(...walk(p, base));
    } else {
      out.push({
        path: path.relative(base, p).replace(/\\/g, "/"),
        size: stat.size,
        gzip: zlib.gzipSync(fs.readFileSync(p)).length,
      });
    }
  }
  return out;
}

function classify(rel) {
  if (/\.js$/.test(rel)) {
    if (/nuggets?\//i.test(rel) || /\/nugget[-_]/i.test(rel) || /^nugget[-_]/i.test(rel)) return "nuggets";
    if (/chunks?\//i.test(rel)) return "chunks";
    return "main";
  }
  if (/\.css(\.map)?$/.test(rel)) return "css";
  if (/\.html?$/.test(rel)) return "html";
  if (/\.map$/.test(rel)) return "sourcemaps";
  if (/nugget-manifest\.json$/i.test(rel)) return "manifest";
  return "other";
}

// Which load phase does each category belong to?
//   initial  → ships on first page load (entry + vendors + html + global css)
//   lazy     → only loads on user interaction or viewport intersection
//   artifact → build-time output, never shipped to the browser
const LOAD_PHASE = {
  main: "initial",
  html: "initial",
  css: "initial",
  chunks: "lazy",
  nuggets: "lazy",
  manifest: "artifact",
  sourcemaps: "artifact",
  other: "artifact",
};

function summarize(files) {
  const byCat = {};
  const phaseTotals = {
    initial: { size: 0, gzip: 0 },
    lazy: { size: 0, gzip: 0 },
    artifact: { size: 0, gzip: 0 },
  };
  let totalSize = 0;
  let totalGzip = 0;
  for (const f of files) {
    const cat = classify(f.path);
    const phase = LOAD_PHASE[cat] || "artifact";
    byCat[cat] ??= { count: 0, size: 0, gzip: 0, phase };
    byCat[cat].count++;
    byCat[cat].size += f.size;
    byCat[cat].gzip += f.gzip;
    phaseTotals[phase].size += f.size;
    phaseTotals[phase].gzip += f.gzip;
    totalSize += f.size;
    totalGzip += f.gzip;
  }
  return { byCat, phaseTotals, totalSize, totalGzip, fileCount: files.length };
}

function fmt(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function printSummary(label, summary) {
  console.log(`\n=== ${label} ===`);
  console.log(`  ${pad("category", 12)} ${pad("phase", 9)} ${pad("files", 6)} ${pad("raw", 12)} gzip`);
  console.log(`  ${"-".repeat(58)}`);
  // Sort by phase (initial first, then lazy, then artifact), then by category.
  const phaseOrder = { initial: 0, lazy: 1, artifact: 2 };
  const cats = Object.keys(summary.byCat).sort((a, b) => {
    const pa = phaseOrder[summary.byCat[a].phase] ?? 9;
    const pb = phaseOrder[summary.byCat[b].phase] ?? 9;
    return pa - pb || a.localeCompare(b);
  });
  for (const cat of cats) {
    const { count, size, gzip, phase } = summary.byCat[cat];
    console.log(`  ${pad(cat, 12)} ${pad(phase, 9)} ${pad(count, 6)} ${pad(fmt(size), 12)} ${fmt(gzip)}`);
  }
  console.log(`  ${"-".repeat(58)}`);
  const { initial, lazy, artifact } = summary.phaseTotals;
  console.log(`  ${pad("INITIAL", 12)} ${pad("", 9)} ${pad("", 6)} ${pad(fmt(initial.size), 12)} ${fmt(initial.gzip)}    ← shipped on first page load`);
  console.log(`  ${pad("LAZY", 12)} ${pad("", 9)} ${pad("", 6)} ${pad(fmt(lazy.size), 12)} ${fmt(lazy.gzip)}    ← only on click / scroll`);
  if (artifact.size > 0) {
    console.log(`  ${pad("artifact", 12)} ${pad("", 9)} ${pad("", 6)} ${pad(fmt(artifact.size), 12)} ${fmt(artifact.gzip)}    ← build-time only`);
  }
  console.log(`  ${pad("TOTAL", 12)} ${pad("", 9)} ${pad(summary.fileCount, 6)} ${pad(fmt(summary.totalSize), 12)} ${fmt(summary.totalGzip)}`);
}

function snapshotPath(name) {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  return path.join(SNAPSHOT_DIR, `${name}.json`);
}

function diff(before, after, key) {
  const a = before;
  const b = after;
  const d = b - a;
  const pct = a === 0 ? "n/a" : `${((d / a) * 100).toFixed(2)}%`;
  const sign = d > 0 ? "+" : d < 0 ? "-" : "";
  return `${fmt(a)} → ${fmt(b)}  (${sign}${fmt(Math.abs(d))} / ${pct})`;
}

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === "show") {
  if (!fs.existsSync(BUILD_DIR)) {
    console.error(`Build dir not found: ${BUILD_DIR}\nRun "npm run build" first.`);
    process.exit(1);
  }
  const files = walk(BUILD_DIR);
  printSummary(`current build (${path.relative(process.cwd(), BUILD_DIR)})`, summarize(files));
} else if (cmd === "save") {
  const name = rest[0];
  if (!name) {
    console.error("Usage: node scripts/bundle-size.js save <name>");
    process.exit(1);
  }
  if (!fs.existsSync(BUILD_DIR)) {
    console.error(`Build dir not found: ${BUILD_DIR}`);
    process.exit(1);
  }
  const files = walk(BUILD_DIR);
  const summary = summarize(files);
  printSummary(`Snapshot "${name}"`, summary);
  fs.writeFileSync(
    snapshotPath(name),
    JSON.stringify({ name, takenAt: new Date().toISOString(), summary, files }, null, 2)
  );
  console.log(`\n  → saved to .bundle-snapshots/${name}.json`);
} else if (cmd === "compare") {
  const [aName, bName] = rest;
  if (!aName || !bName) {
    console.error("Usage: node scripts/bundle-size.js compare <before> <after>");
    process.exit(1);
  }
  const a = JSON.parse(fs.readFileSync(snapshotPath(aName), "utf8")).summary;
  const b = JSON.parse(fs.readFileSync(snapshotPath(bName), "utf8")).summary;
  printSummary(`Before: ${aName}`, a);
  printSummary(`After:  ${bName}`, b);

  // Fall back to zeros if snapshot predates phase tracking.
  const aPhase = a.phaseTotals || { initial: { size: 0, gzip: 0 }, lazy: { size: 0, gzip: 0 } };
  const bPhase = b.phaseTotals || { initial: { size: 0, gzip: 0 }, lazy: { size: 0, gzip: 0 } };

  console.log(`\n=== INITIAL Δ (${aName} → ${bName})  — what users actually download on first page load ===`);
  console.log(`  raw  : ${diff(aPhase.initial.size, bPhase.initial.size)}`);
  console.log(`  gzip : ${diff(aPhase.initial.gzip, bPhase.initial.gzip)}`);

  console.log(`\n=== LAZY Δ — only paid when interactions / scrolling happen ===`);
  console.log(`  raw  : ${diff(aPhase.lazy.size, bPhase.lazy.size)}`);
  console.log(`  gzip : ${diff(aPhase.lazy.gzip, bPhase.lazy.gzip)}`);

  console.log(`\n=== TOTAL Δ (everything in the build, including lazy + artifacts) ===`);
  console.log(`  raw  : ${diff(a.totalSize, b.totalSize)}`);
  console.log(`  gzip : ${diff(a.totalGzip, b.totalGzip)}`);

  console.log(`\n  per category (raw):`);
  const allCats = new Set([...Object.keys(a.byCat), ...Object.keys(b.byCat)]);
  for (const cat of [...allCats].sort()) {
    const av = a.byCat[cat]?.size ?? 0;
    const bv = b.byCat[cat]?.size ?? 0;
    const phase = a.byCat[cat]?.phase || b.byCat[cat]?.phase || "?";
    console.log(`    ${pad(cat, 12)} ${pad(`[${phase}]`, 11)} ${diff(av, bv)}`);
  }
} else {
  console.error(`Unknown command: ${cmd}\nUsage:\n  show\n  save <name>\n  compare <before> <after>`);
  process.exit(1);
}
