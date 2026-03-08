#!/usr/bin/env node
/**
 * scripts/download-fonts.js
 *
 * Downloads all WOFF2 font files needed by Skillman into
 * extension/assets/fonts/
 *
 * Usage:
 *   node scripts/download-fonts.js
 *
 * Requirements: Node 18+ (uses built-in fetch)
 * For older Node: npm install node-fetch and add the import at the top.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "../extension/assets/fonts");

// These are stable Google Fonts CDN URLs for WOFF2 files.
// If they ever change, run the CSS API URL through a browser with
// a modern User-Agent and copy the src() URLs from the response.
const FONTS = [
  // Syne
  {
    file: "syne-400.woff2",
    url: "https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_04uQ.woff2",
  },
  {
    file: "syne-500.woff2",
    url: "https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_0uuQ.woff2",
  },
  {
    file: "syne-600.woff2",
    url: "https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_3CvA.woff2",
  },
  {
    file: "syne-700.woff2",
    url: "https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_37vA.woff2",
  },
  {
    file: "syne-800.woff2",
    url: "https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_2qvA.woff2",
  },
  // DM Mono
  {
    file: "dm-mono-300.woff2",
    url: "https://fonts.gstatic.com/s/dmmono/v14/aFTU7PB1QTsUX8KYvrGyIYSnbKX9iu10WQ.woff2",
  },
  {
    file: "dm-mono-400.woff2",
    url: "https://fonts.gstatic.com/s/dmmono/v14/aFTR7PB1QTsUX8KYth2orYEdIgn_.woff2",
  },
  {
    file: "dm-mono-500.woff2",
    url: "https://fonts.gstatic.com/s/dmmono/v14/aFTU7PB1QTsUX8KYvrGyIYSnfKf9iu10WQ.woff2",
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`Created ${OUT_DIR}`);
  }

  let ok = 0;
  let fail = 0;

  for (const { file, url } of FONTS) {
    const dest = path.join(OUT_DIR, file);
    process.stdout.write(`  Downloading ${file}... `);
    try {
      await download(url, dest);
      const size = fs.statSync(dest).size;
      console.log(`✓  (${(size / 1024).toFixed(1)} KB)`);
      ok++;
    } catch (e) {
      console.log(`✗  ${e.message}`);
      fail++;
    }
  }

  console.log(`\n${ok} downloaded, ${fail} failed.`);
  if (fail > 0) {
    console.log(
      "\nFor failed files, open the URL manually in a browser and save the file."
    );
    process.exit(1);
  }
}

main();
