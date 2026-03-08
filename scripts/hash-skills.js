#!/usr/bin/env node
/**
 * scripts/hash-skills.js
 *
 * Reads every .skill file listed in registry/registry.json,
 * computes its SHA-256 hash, and writes the hash back into
 * the "sha256" field of that registry entry.
 *
 * Run this every time you publish or update a .skill file:
 *
 *   node scripts/hash-skills.js
 *
 * Requirements: Node 18+ (uses built-in crypto and fetch).
 * For older Node:  npm install node-fetch  and add the import.
 *
 * The script can hash files two ways:
 *   --local   Read .skill files from  skills/  folder on disk (default if files exist)
 *   --remote  Fetch .skill files from their "source" URL in the registry
 *
 * After running, commit the updated registry/registry.json.
 * The extension's bundled copy at extension/registry.json should also be
 * kept in sync — copy it over or set up a build step.
 */

const crypto = require("crypto");
const fs     = require("fs");
const https  = require("https");
const path   = require("path");

const REGISTRY_PATH   = path.join(__dirname, "../registry/registry.json");
const SKILLS_DIR      = path.join(__dirname, "../skills");
const USE_REMOTE      = process.argv.includes("--remote");

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fetchRemote(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  ()  => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error("Registry not found at", REGISTRY_PATH);
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  let updated = 0;
  let failed  = 0;

  for (const entry of registry) {
    const localPath = path.join(SKILLS_DIR, `${entry.name}.skill`);
    const useLocal  = !USE_REMOTE && fs.existsSync(localPath);

    process.stdout.write(`  ${entry.name} (${useLocal ? "local" : "remote"})... `);

    try {
      let buffer;

      if (useLocal) {
        buffer = fs.readFileSync(localPath);
      } else {
        if (!entry.source) throw new Error("No source URL in registry entry");
        buffer = await fetchRemote(entry.source);
      }

      const hash = sha256hex(buffer);
      entry.sha256 = hash;
      console.log(`✓  ${hash.slice(0, 16)}…`);
      updated++;
    } catch (e) {
      console.log(`✗  ${e.message}`);
      // Leave existing sha256 (or undefined) in place — don't null it out
      failed++;
    }
  }

  // Write updated registry back
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");

  // Also update the bundled copy inside the extension
  const extensionRegistryPath = path.join(__dirname, "../extension/registry.json");
  fs.writeFileSync(extensionRegistryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  console.log(`\nDone. ${updated} hashed, ${failed} failed.`);
  console.log(`Written to:\n  ${REGISTRY_PATH}\n  ${extensionRegistryPath}`);

  if (failed > 0) {
    console.warn("\n⚠️  Some skills could not be hashed. Fix the errors above and re-run.");
    process.exit(1);
  }
}

main().catch(e => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
