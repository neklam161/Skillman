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
