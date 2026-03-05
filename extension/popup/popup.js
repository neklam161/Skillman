// popup.js — Skillman popup logic

// ── State ──────────────────────────────────────────────────────────────────
let allSkills = [];
let installedNames = new Set();
let selectedNames = new Set();
let activeTag = "all";
let searchQuery = "";

// ── DOM refs ───────────────────────────────────────────────────────────────
const listEl        = document.getElementById("skills-list");
const loadingEl     = document.getElementById("loading");
const tagFiltersEl  = document.getElementById("tag-filters");
const searchEl      = document.getElementById("search");
const selectedCount = document.getElementById("selected-count");
const btnInstall    = document.getElementById("btn-install");
const btnRefresh    = document.getElementById("btn-refresh");
const overlay       = document.getElementById("overlay");
const progressItems = document.getElementById("progress-items");
const progressSub   = document.getElementById("progress-subtitle");
const btnDone       = document.getElementById("btn-done");

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  // Load installed list from storage
  const res = await chrome.runtime.sendMessage({ type: "GET_INSTALLED" });
  installedNames = new Set((res.installed || []).map((s) => s.name));

  // Fetch registry
  await loadRegistry();
}

async function loadRegistry() {
  loadingEl.style.display = "flex";
  listEl.innerHTML = "";
  listEl.appendChild(loadingEl);

  btnRefresh.classList.add("spinning");

  const res = await chrome.runtime.sendMessage({ type: "FETCH_REGISTRY" });

  btnRefresh.classList.remove("spinning");

  if (!res.ok) {
    loadingEl.innerHTML = `<span style="color:var(--red)">Failed to load registry</span>`;
    return;
  }

  allSkills = res.data;
  buildTagFilters();
  renderSkills();
}

// ── Tag filters ────────────────────────────────────────────────────────────
function buildTagFilters() {
  const tagSet = new Set();
  allSkills.forEach((s) => (s.tags || []).forEach((t) => tagSet.add(t)));

  tagFiltersEl.innerHTML = `<button class="tag active" data-tag="all">All</button>`;
  [...tagSet].sort().forEach((tag) => {
    const btn = document.createElement("button");
    btn.className = "tag";
    btn.dataset.tag = tag;
    btn.textContent = tag;
    tagFiltersEl.appendChild(btn);
  });

  tagFiltersEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".tag");
    if (!btn) return;
    document.querySelectorAll(".tag").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTag = btn.dataset.tag;
    renderSkills();
  });
}

// ── Render skills ──────────────────────────────────────────────────────────
function renderSkills() {
  const q = searchQuery.toLowerCase();

  const filtered = allSkills.filter((skill) => {
    const matchesTag =
      activeTag === "all" || (skill.tags || []).includes(activeTag);
    const matchesSearch =
      !q ||
      skill.name.toLowerCase().includes(q) ||
      (skill.display_name || "").toLowerCase().includes(q) ||
      (skill.description || "").toLowerCase().includes(q);
    return matchesTag && matchesSearch;
  });

  listEl.innerHTML = "";

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty">No skills found</div>`;
    return;
  }

  filtered.forEach((skill) => {
    const card = buildSkillCard(skill);
    listEl.appendChild(card);
  });
}

function buildSkillCard(skill) {
  const isInstalled = installedNames.has(skill.name);
  const isSelected  = selectedNames.has(skill.name);

  const card = document.createElement("div");
  card.className = `skill-card${isSelected ? " selected" : ""}${isInstalled ? " installed" : ""}`;
  card.dataset.name = skill.name;

  card.innerHTML = `
    <div class="skill-icon">${skill.icon || "🔧"}</div>
    <div class="skill-info">
      <div class="skill-name-row">
        <span class="skill-name">${skill.display_name || skill.name}</span>
        ${isInstalled ? `<span class="installed-badge">installed</span>` : `<span class="skill-author">${skill.author || "community"}</span>`}
      </div>
      <div class="skill-desc">${skill.description}</div>
    </div>
    <div class="skill-check">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  `;

  card.addEventListener("click", () => toggleSkill(skill.name));
  return card;
}

function toggleSkill(name) {
  if (selectedNames.has(name)) {
    selectedNames.delete(name);
  } else {
    selectedNames.add(name);
  }
  // Update card UI
  const card = listEl.querySelector(`[data-name="${name}"]`);
  if (card) card.classList.toggle("selected", selectedNames.has(name));

  updateFooter();
}

function updateFooter() {
  const n = selectedNames.size;
  selectedCount.textContent = n === 0
    ? "0 skills selected"
    : `${n} skill${n > 1 ? "s" : ""} selected`;
  btnInstall.disabled = n === 0;
}

// ── Install ────────────────────────────────────────────────────────────────
async function handleInstall() {
  const skills = allSkills.filter((s) => selectedNames.has(s.name));
  if (skills.length === 0) return;

  // Show overlay
  overlay.style.display = "flex";
  progressItems.innerHTML = "";
  progressSub.textContent = `Installing ${skills.length} skill${skills.length > 1 ? "s" : ""}…`;
  btnDone.style.display = "none";

  // Build progress rows
  const itemMap = {};
  skills.forEach((skill) => {
    const row = document.createElement("div");
    row.className = "progress-item";
    row.innerHTML = `
      <div class="progress-item-icon">${skill.icon || "🔧"}</div>
      <div class="progress-item-name">${skill.display_name || skill.name}</div>
      <div class="status-indicator pending" id="ind-${skill.name}"></div>
      <div class="progress-item-status status-pending" id="st-${skill.name}">pending</div>
    `;
    progressItems.appendChild(row);
    itemMap[skill.name] = row;
  });

  // Listen for progress messages from service worker
  const progressListener = (message) => {
    if (message.type === "PROGRESS") {
      const ind = document.getElementById(`ind-${message.skill}`);
      const st  = document.getElementById(`st-${message.skill}`);
      if (ind && st) {
        ind.className = `status-indicator ${message.status}`;
        st.className  = `progress-item-status status-${message.status}`;
        st.textContent = message.status;
      }
    }
    if (message.type === "STATUS") {
      progressSub.textContent = message.message;
    }
    if (message.type === "DONE") {
      progressSub.textContent = "All done!";
      btnDone.style.display = "block";
      // Update local installed set
      skills.forEach((s) => installedNames.add(s.name));
      selectedNames.clear();
      updateFooter();
      chrome.runtime.onMessage.removeListener(progressListener);
    }
  };

  chrome.runtime.onMessage.addListener(progressListener);

  // Kick off install
  await chrome.runtime.sendMessage({ type: "INSTALL_SKILLS", skills });
}

// ── Events ─────────────────────────────────────────────────────────────────
btnRefresh.addEventListener("click", loadRegistry);
btnInstall.addEventListener("click", handleInstall);
btnDone.addEventListener("click", () => {
  overlay.style.display = "none";
  renderSkills(); // refresh to show "installed" badges
});

searchEl.addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderSkills();
});

// ── Start ──────────────────────────────────────────────────────────────────
init();

// ── URL Install ────────────────────────────────────────────────────────────

const urlPanel      = document.getElementById("url-panel");
const urlInput      = document.getElementById("url-input");
const urlHint       = document.getElementById("url-hint");
const btnUrl        = document.getElementById("btn-url");
const btnUrlInstall = document.getElementById("btn-url-install");

// Toggle URL panel
btnUrl.addEventListener("click", () => {
  const open = urlPanel.style.display !== "none";
  urlPanel.style.display = open ? "none" : "block";
  btnUrl.classList.toggle("active", !open);
  if (!open) urlInput.focus();
});

// Validate + preview URL as user types
urlInput.addEventListener("input", () => {
  const raw = urlInput.value.trim();
  if (!raw) { setHint("", ""); return; }

  const parsed = parseGitHubUrl(raw);
  if (!parsed) {
    setHint("Must be a GitHub URL to a .skill file or skill folder", "error");
    return;
  }
  if (parsed.type === "file") {
    setHint(`✓ Skill file: ${parsed.name}`, "ok");
  } else if (parsed.type === "folder") {
    setHint(`✓ Skill folder: ${parsed.name} — will fetch SKILL.md`, "ok");
  }
});

urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") installFromUrl(); });
btnUrlInstall.addEventListener("click", installFromUrl);

async function installFromUrl() {
  const raw = urlInput.value.trim();
  if (!raw) return;

  const parsed = parseGitHubUrl(raw);
  if (!parsed) {
    setHint("Invalid GitHub URL — paste a link to a .skill file or skill folder", "error");
    return;
  }

  // Close panel
  urlPanel.style.display = "none";
  btnUrl.classList.remove("active");
  urlInput.value = "";
  setHint("", "");

  // Show overlay
  overlay.style.display = "flex";
  progressItems.innerHTML = "";
  btnDone.style.display = "none";

  const skillName = parsed.name;

  const row = document.createElement("div");
  row.className = "progress-item";
  row.innerHTML = `
    <div class="progress-item-icon">🔗</div>
    <div class="progress-item-name">${skillName}</div>
    <div class="status-indicator pending" id="ind-${skillName}"></div>
    <div class="progress-item-status status-pending" id="st-${skillName}">pending</div>
  `;
  progressItems.appendChild(row);

  const updateStatus = (status, msg) => {
    const ind = document.getElementById(`ind-${skillName}`);
    const st  = document.getElementById(`st-${skillName}`);
    if (ind) ind.className = `status-indicator ${status}`;
    if (st)  { st.className = `progress-item-status status-${status}`; st.textContent = status; }
    if (msg) progressSub.textContent = msg;
  };

  try {
    let skill;

    if (parsed.type === "file") {
      // Direct .skill file — pass straight to service worker
      progressSub.textContent = "Downloading skill file…";
      updateStatus("downloading");
      skill = {
        name: skillName,
        display_name: skillName,
        description: "Installed from URL",
        icon: "🔗",
        source: parsed.rawUrl,
        tags: ["custom"],
        author: "custom"
      };

      const progressListener = (message) => {
        if (message.type === "PROGRESS") updateStatus(message.status);
        if (message.type === "STATUS") progressSub.textContent = message.message;
        if (message.type === "DONE") {
          progressSub.textContent = "Done!";
          btnDone.style.display = "block";
          chrome.runtime.onMessage.removeListener(progressListener);
        }
      };
      chrome.runtime.onMessage.addListener(progressListener);
      await chrome.runtime.sendMessage({ type: "INSTALL_SKILLS", skills: [skill] });

    } else if (parsed.type === "folder") {
      // Skill folder — fetch files from GitHub API, zip them, install
      progressSub.textContent = "Fetching skill folder from GitHub…";
      updateStatus("downloading");

      const zipBuffer = await fetchAndZipSkillFolder(parsed, (msg) => {
        progressSub.textContent = msg;
      });

      updateStatus("installing", "Installing skill…");

      // Send as a pre-zipped base64 buffer to service worker
      await chrome.runtime.sendMessage({
        type: "INSTALL_ZIPPED",
        skillName,
        zipBase64: arrayBufferToBase64(zipBuffer)
      });

      updateStatus("installed", "Done!");
      btnDone.style.display = "block";
    }

  } catch (e) {
    updateStatus("error");
    progressSub.textContent = `Error: ${e.message}`;
    btnDone.style.display = "block";
  }
}

// Fetch all files in a GitHub skill folder and zip them using MiniZip
async function fetchAndZipSkillFolder(parsed, onProgress) {
  const { user, repo, branch, path } = parsed;
  const apiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${path}?ref=${branch}`;

  onProgress("Fetching file list from GitHub API…");
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`GitHub API error: HTTP ${res.status} — is the repo public?`);
  const files = await res.json();

  if (!Array.isArray(files)) throw new Error("Expected a folder — paste a folder URL, not a file URL");

  const hasSKILLmd = files.some(f => f.name === "SKILL.md");
  if (!hasSKILLmd) throw new Error("No SKILL.md found — is this a valid Claude skill folder?");

  const zip = new window.MiniZip();
  const folderName = parsed.name;

  // Download each file and add to zip
  for (const file of files) {
    if (file.type !== "file") continue;
    onProgress(`Fetching ${file.name}…`);
    const fileRes = await fetch(file.download_url);
    if (!fileRes.ok) throw new Error(`Failed to fetch ${file.name}: HTTP ${fileRes.status}`);
    const buf = await fileRes.arrayBuffer();
    zip.add(`${folderName}/${file.name}`, buf);
  }

  onProgress("Packaging skill…");
  return zip.generate();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Parse any GitHub URL into a structured object
// Returns: { type: "file"|"folder", name, rawUrl?, user, repo, branch, path }
function parseGitHubUrl(url) {
  url = url.trim();

  // Already raw .skill URL
  if (url.startsWith("https://raw.githubusercontent.com/") && url.endsWith(".skill")) {
    const parts = url.replace("https://raw.githubusercontent.com/", "").split("/");
    const [user, repo, branch, ...pathParts] = parts;
    const name = pathParts[pathParts.length - 1].replace(".skill", "");
    return { type: "file", name, rawUrl: url, user, repo, branch, path: pathParts.join("/") };
  }

  // GitHub blob .skill file: /blob/branch/path/to/file.skill
  const blobMatch = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.skill)$/
  );
  if (blobMatch) {
    const [, user, repo, branch, path] = blobMatch;
    const name = path.split("/").pop().replace(".skill", "");
    const rawUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`;
    return { type: "file", name, rawUrl, user, repo, branch, path };
  }

  // GitHub tree folder: /tree/branch/path/to/folder
  const treeMatch = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/
  );
  if (treeMatch) {
    const [, user, repo, branch, path] = treeMatch;
    const name = path.split("/").pop();
    return { type: "folder", name, user, repo, branch, path };
  }

  // GitHub folder without /tree/ (just /user/repo/path)
  const plainMatch = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  );
  if (plainMatch) {
    const [, user, repo, maybeBlob, branch, path] = plainMatch;
    if (maybeBlob !== "blob" && maybeBlob !== "tree") return null;
  }

  return null;
}

function setHint(text, type) {
  urlHint.textContent = text;
  urlHint.className = `url-hint ${type}`;
}
