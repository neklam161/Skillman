// popup.js — Skillman

// ── State ──────────────────────────────────────────────────────────────────
let allSkills      = [];
let customSkills   = [];   // #3 — URL-installed skills
let installedNames = new Set();
let selectedNames  = new Set();
let activeTag      = "all";
let searchQuery    = "";

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
const orbIcon       = document.getElementById("orb-icon");

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  const res = await chrome.runtime.sendMessage({ type: "GET_INSTALLED" });
  installedNames = new Set((res.installed || []).map(s => s.name));

  // Load custom (URL-installed) skills from storage (#3)
  const customRes = await chrome.storage.local.get("customSkills");
  customSkills = customRes.customSkills || [];

  // Recover session if popup was closed mid-install (#2)
  const sessionRes = await chrome.runtime.sendMessage({ type: "GET_SESSION" });
  if (sessionRes.session) {
    recoverSession(sessionRes.session);
    return;
  }

  await loadRegistry();
}

// ── Session recovery (#2) ──────────────────────────────────────────────────
function recoverSession(session) {
  showOverlay();
  progressSub.textContent = "Install in progress...";
  progressItems.innerHTML = "";
  btnDone.style.display = "none";

  for (const skill of session.skills) {
    const status = session.progress?.[skill.name] || "pending";
    appendProgressRow(skill, status);
  }

  attachProgressListener(session.skills);
}

// ── Not logged in (#1) ─────────────────────────────────────────────────────
function showNotLoggedIn() {
  progressItems.innerHTML = `
    <div style="text-align:center;padding:20px 10px;display:flex;flex-direction:column;align-items:center;gap:10px">
      <div style="font-size:28px">🔐</div>
      <div style="font-weight:600;font-size:13px;color:var(--text)">Not logged in to Claude</div>
      <div style="font-size:11px;color:var(--text-2);line-height:1.6">
        Please log in to
        <a href="https://claude.ai" target="_blank" style="color:var(--accent-2)">claude.ai</a>
        and try again.
      </div>
    </div>
  `;
  orbIcon.textContent = "🔐";
}

// ── Registry ───────────────────────────────────────────────────────────────
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
  allSkills.forEach(s => (s.tags || []).forEach(t => tagSet.add(t)));

  tagFiltersEl.innerHTML = `<button class="tag active" data-tag="all">All</button>`;
  [...tagSet].sort().forEach(tag => {
    const btn = document.createElement("button");
    btn.className = "tag";
    btn.dataset.tag = tag;
    btn.textContent = tag;
    tagFiltersEl.appendChild(btn);
  });

  tagFiltersEl.addEventListener("click", e => {
    const btn = e.target.closest(".tag");
    if (!btn) return;
    document.querySelectorAll(".tag").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeTag = btn.dataset.tag;
    renderSkills();
  });
}

// ── Render skills (#3 — shows custom installs too) ─────────────────────────
function renderSkills() {
  const q = searchQuery.toLowerCase();
  listEl.innerHTML = "";

  const filtered = allSkills.filter(skill => {
    const matchesTag = activeTag === "all" || (skill.tags || []).includes(activeTag);
    const matchesSearch = !q ||
      skill.name.toLowerCase().includes(q) ||
      (skill.display_name || "").toLowerCase().includes(q) ||
      (skill.description || "").toLowerCase().includes(q);
    return matchesTag && matchesSearch;
  });

  if (filtered.length === 0 && customSkills.length === 0) {
    listEl.innerHTML = `<div class="empty">No skills found</div>`;
    return;
  }

  filtered.forEach(skill => listEl.appendChild(buildSkillCard(skill)));

  // Custom/URL-installed skills section (#3)
  const filteredCustom = customSkills.filter(skill =>
    !q ||
    skill.name.toLowerCase().includes(q) ||
    (skill.display_name || "").toLowerCase().includes(q)
  );

  if (filteredCustom.length > 0) {
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Installed from URL";
    listEl.appendChild(label);
    filteredCustom.forEach(skill => listEl.appendChild(buildSkillCard(skill, true)));
  }
}

function buildSkillCard(skill, isCustom = false) {
  const isInstalled = installedNames.has(skill.name);
  const isSelected  = selectedNames.has(skill.name);

  const card = document.createElement("div");
  card.className = ["skill-card", isSelected ? "selected" : "", isInstalled ? "installed" : "", isCustom ? "custom" : ""].filter(Boolean).join(" ");
  card.dataset.name = skill.name;

  const authorLabel = isInstalled
    ? `<span class="installed-badge">installed</span>`
    : isCustom
      ? `<span class="skill-author">custom</span>`
      : `<span class="skill-author">${skill.author || "community"}</span>`;

  card.innerHTML = `
    <div class="skill-icon">${skill.icon || "🔧"}</div>
    <div class="skill-info">
      <div class="skill-name-row">
        <span class="skill-name">${skill.display_name || skill.name}</span>
        ${authorLabel}
      </div>
      <div class="skill-desc">${skill.description || ""}</div>
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
  selectedNames.has(name) ? selectedNames.delete(name) : selectedNames.add(name);
  const card = listEl.querySelector(`[data-name="${name}"]`);
  if (card) card.classList.toggle("selected", selectedNames.has(name));
  updateFooter();
}

function updateFooter() {
  const n = selectedNames.size;
  selectedCount.textContent = n === 0 ? "0 skills selected" : `${n} skill${n > 1 ? "s" : ""} selected`;
  btnInstall.disabled = n === 0;
}

// ── Install from registry ──────────────────────────────────────────────────
async function handleInstall() {
  const skills = [...allSkills, ...customSkills].filter(s => selectedNames.has(s.name));
  if (skills.length === 0) return;

  showOverlay();
  progressItems.innerHTML = "";
  progressSub.textContent = `Installing ${skills.length} skill${skills.length > 1 ? "s" : ""}…`;
  btnDone.style.display = "none";
  orbIcon.textContent = "⚡";

  skills.forEach(skill => appendProgressRow(skill, "pending"));
  attachProgressListener(skills);

  await chrome.runtime.sendMessage({ type: "INSTALL_SKILLS", skills });
}

// ── Progress helpers ───────────────────────────────────────────────────────
function showOverlay() {
  overlay.style.display = "flex";
}

function appendProgressRow(skill, status = "pending") {
  const existing = document.getElementById(`ind-${skill.name}`);
  if (existing) { updateProgressRow(skill.name, status); return; }

  const row = document.createElement("div");
  row.className = `progress-item status-${status}`;
  row.id = `row-${skill.name}`;
  row.innerHTML = `
    <div class="progress-item-icon">${skill.icon || "🔧"}</div>
    <div class="progress-item-name">${skill.display_name || skill.name}</div>
    <div class="status-indicator ${status}" id="ind-${skill.name}"></div>
    <div class="progress-item-status status-${status}" id="st-${skill.name}">${status}</div>
  `;
  progressItems.appendChild(row);
}

function updateProgressRow(skillName, status) {
  const ind = document.getElementById(`ind-${skillName}`);
  const st  = document.getElementById(`st-${skillName}`);
  const row = document.getElementById(`row-${skillName}`);
  if (ind) ind.className = `status-indicator ${status}`;
  if (st)  { st.className = `progress-item-status status-${status}`; st.textContent = status; }
  if (row) row.className = `progress-item status-${status}`;
}

function attachProgressListener(skills) {
  const listener = (message) => {
    if (message.type === "PROGRESS") updateProgressRow(message.skill, message.status);
    if (message.type === "STATUS")   progressSub.textContent = message.message;
    if (message.type === "NOT_LOGGED_IN") showNotLoggedIn();
    if (message.type === "DONE") {
      orbIcon.textContent = message.hadErrors ? "⚠️" : "✅";
      progressSub.textContent = message.hadErrors ? "Finished with some errors." : "All done!";
      btnDone.style.display = "block";
      if (!message.hadErrors) skills.forEach(s => installedNames.add(s.name));
      selectedNames.clear();
      updateFooter();
      chrome.runtime.onMessage.removeListener(listener);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
}

// ── URL Install (#1 redesign, #4 multiple URLs) ────────────────────────────
const urlPanel      = document.getElementById("url-panel");
const urlTextarea   = document.getElementById("url-textarea");
const urlHint       = document.getElementById("url-hint");
const btnUrl        = document.getElementById("btn-url");
const btnUrlInstall = document.getElementById("btn-url-install");

btnUrl.addEventListener("click", () => {
  const open = urlPanel.style.display !== "none";
  urlPanel.style.display = open ? "none" : "block";
  btnUrl.classList.toggle("active", !open);
  if (!open) urlTextarea?.focus();
});

urlTextarea.addEventListener("input", () => {
  const lines = urlTextarea.value.split("
").map(l => l.trim()).filter(Boolean);
  if (!lines.length) { setHint("", ""); return; }
  const valid = lines.filter(l => parseGitHubUrl(l));
  const invalid = lines.length - valid.length;
  if (invalid === 0) {
    setHint(`✓ ${valid.length} URL${valid.length > 1 ? "s" : ""} ready`, "ok");
  } else {
    setHint(`${valid.length} valid, ${invalid} invalid`, invalid === lines.length ? "error" : "info");
  }
});

btnUrlInstall.addEventListener("click", installFromUrls);

async function installFromUrls() {
  const lines = urlTextarea.value.split("
").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;

  const parsedList = lines.map(parseGitHubUrl).filter(Boolean);
  if (!parsedList.length) { setHint("No valid GitHub URLs found", "error"); return; }

  // Close panel and clear textarea
  urlPanel.style.display = "none";
  btnUrl.classList.remove("active");
  urlTextarea.value = "";
  setHint("", "");

  showOverlay();
  progressItems.innerHTML = "";
  btnDone.style.display = "none";
  orbIcon.textContent = "⚡";
  progressSub.textContent = `Installing ${parsedList.length} skill${parsedList.length > 1 ? "s" : ""} from URL…`;

  parsedList.forEach(p => appendProgressRow({ name: p.name, display_name: p.name, icon: "🔗" }, "pending"));

  let anyError = false;

  for (const p of parsedList) {
    const skillName = p.name;
    try {
      if (p.type === "file") {
        updateProgressRow(skillName, "downloading");
        progressSub.textContent = `Downloading ${skillName}…`;

        const skill = { name: skillName, display_name: skillName, description: "Installed from URL", icon: "🔗", source: p.rawUrl, tags: ["custom"], author: "custom" };

        await new Promise((resolve) => {
          const listener = (msg) => {
            if (msg.type === "PROGRESS" && msg.skill === skillName) updateProgressRow(skillName, msg.status);
            if (msg.type === "DONE") { chrome.runtime.onMessage.removeListener(listener); resolve(); }
          };
          chrome.runtime.onMessage.addListener(listener);
          chrome.runtime.sendMessage({ type: "INSTALL_SKILLS", skills: [skill] });
        });

        await saveCustomSkill(skill);

      } else if (p.type === "folder") {
        updateProgressRow(skillName, "downloading");
        const zipBuffer = await fetchAndZipSkillFolder(p, msg => { progressSub.textContent = msg; });
        updateProgressRow(skillName, "installing");
        progressSub.textContent = `Installing ${skillName}…`;
        await chrome.runtime.sendMessage({ type: "INSTALL_ZIPPED", skillName, zipBase64: arrayBufferToBase64(zipBuffer) });
        updateProgressRow(skillName, "installed");
        await saveCustomSkill({ name: skillName, display_name: skillName, description: "Installed from GitHub folder", icon: "🔗", tags: ["custom"], author: "custom" });
      }
    } catch (e) {
      console.error("[Skillman] URL install failed for", skillName, e.message);
      updateProgressRow(skillName, "error");
      progressSub.textContent = `Error: ${e.message}`;
      anyError = true;
    }
  }

  orbIcon.textContent = anyError ? "⚠️" : "✅";
  progressSub.textContent = anyError ? "Finished with some errors." : "All done!";
  btnDone.style.display = "block";
}



async function saveCustomSkill(skill) {
  const res = await chrome.storage.local.get("customSkills");
  const existing = res.customSkills || [];
  const updated = [...existing.filter(s => s.name !== skill.name), skill];
  await chrome.storage.local.set({ customSkills: updated });
  customSkills = updated;
  installedNames.add(skill.name);
}

// ── GitHub folder fetch & zip (with subdirectory recursion #2) ────────────
async function fetchAndZipSkillFolder(parsed, onProgress, zip = null, baseName = null) {
  const { user, repo, branch, path } = parsed;
  const isRoot = zip === null;

  if (isRoot) {
    zip = new window.MiniZip();
    baseName = parsed.name;
  }

  const apiUrl = `https://api.github.com/repos/${user}/${repo}/contents/${path}?ref=${branch}`;
  onProgress(`Fetching ${path.split("/").pop()}…`);

  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`GitHub API error: HTTP ${res.status} — is the repo public?`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error("Expected a folder — paste a folder URL");

  if (isRoot && !items.some(f => f.name === "SKILL.md")) {
    throw new Error("No SKILL.md found — is this a valid Claude skill folder?");
  }

  for (const item of items) {
    if (item.type === "file") {
      onProgress(`Fetching ${item.name}…`);
      const fileRes = await fetch(item.download_url);
      if (!fileRes.ok) throw new Error(`Failed to fetch ${item.name}`);
      const buf = await fileRes.arrayBuffer();
      const rootPath = parsed.path.substring(0, parsed.path.lastIndexOf("/") + 1);
      const relativePath = item.path.startsWith(rootPath)
        ? item.path.slice(rootPath.length)
        : item.path.split("/").slice(-1)[0];
      zip.add(`${baseName}/${relativePath}`, buf);
    } else if (item.type === "dir") {
      await fetchAndZipSkillFolder(
        { user, repo, branch, path: item.path, name: parsed.name },
        onProgress, zip, baseName
      );
    }
  }

  if (isRoot) {
    onProgress("Packaging skill…");
    return zip.generate();
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Parse GitHub URL ───────────────────────────────────────────────────────
function parseGitHubUrl(url) {
  url = url.trim();

  if (url.startsWith("https://raw.githubusercontent.com/") && url.endsWith(".skill")) {
    const parts = url.replace("https://raw.githubusercontent.com/", "").split("/");
    const [user, repo, branch, ...pathParts] = parts;
    const name = pathParts[pathParts.length - 1].replace(".skill", "");
    return { type: "file", name, rawUrl: url, user, repo, branch, path: pathParts.join("/") };
  }

  const blobMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.skill)$/);
  if (blobMatch) {
    const [, user, repo, branch, path] = blobMatch;
    const name = path.split("/").pop().replace(".skill", "");
    return { type: "file", name, rawUrl: `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`, user, repo, branch, path };
  }

  const treeMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (treeMatch) {
    const [, user, repo, branch, path] = treeMatch;
    return { type: "folder", name: path.split("/").pop(), user, repo, branch, path };
  }

  return null;
}

function setHint(text, type) {
  urlHint.textContent = text;
  urlHint.className = `url-hint ${type}`;
}

// ── Events ─────────────────────────────────────────────────────────────────
btnRefresh.addEventListener("click", loadRegistry);
btnInstall.addEventListener("click", handleInstall);
btnDone.addEventListener("click", () => { overlay.style.display = "none"; renderSkills(); });
searchEl.addEventListener("input", e => { searchQuery = e.target.value; renderSkills(); });

// ── Start ──────────────────────────────────────────────────────────────────
init();
