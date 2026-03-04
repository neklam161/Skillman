// service_worker.js — Skillman background worker
// Handles: registry fetching, skill downloading, zip creation, install orchestration

const REGISTRY_URL =
  "https://raw.githubusercontent.com/neklam161/Skillman/main/registry/registry.json";

// ── Registry ──────────────────────────────────────────────────────────────────

async function fetchRegistry() {
  try {
    console.log("[Skillman] Fetching registry from:", REGISTRY_URL);
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log("[Skillman] Registry loaded from GitHub:", data.length, "skills");
    return data;
  } catch (e) {
    console.warn("[Skillman] Remote registry failed:", e.message, "— falling back to bundled registry");
    const url = chrome.runtime.getURL("registry.json");
    console.log("[Skillman] Loading bundled registry from:", url);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Could not load bundled registry");
    const data = await res.json();
    console.log("[Skillman] Bundled registry loaded:", data.length, "skills");
    return data;
  }
}

// ── Skill downloading ─────────────────────────────────────────────────────────

async function downloadSkillFile(url) {
  console.log("[Skillman] Downloading skill from:", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download skill: HTTP ${res.status} from ${url}`);
  const buffer = await res.arrayBuffer();
  console.log("[Skillman] Downloaded", buffer.byteLength, "bytes");
  return buffer;
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_REGISTRY") {
    fetchRegistry()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => {
        console.error("[Skillman] FETCH_REGISTRY error:", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === "INSTALL_SKILLS") {
    handleInstall(message.skills, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[Skillman] INSTALL_SKILLS error:", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === "GET_INSTALLED") {
    chrome.storage.local.get("installed", (res) => {
      sendResponse({ installed: res.installed || [] });
    });
    return true;
  }
});

// ── Install orchestration ─────────────────────────────────────────────────────

async function handleInstall(skills, tabId) {
  console.log("[Skillman] Starting install for:", skills.map(s => s.name));

  // Step 1: Download all .skill files
  const blobs = [];
  for (const skill of skills) {
    try {
      console.log(`[Skillman] Downloading: ${skill.name} from ${skill.source}`);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "downloading" });
      const buffer = await downloadSkillFile(skill.source);
      blobs.push({ skill, buffer });
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "downloaded" });
      console.log(`[Skillman] Download OK: ${skill.name}`);
    } catch (e) {
      console.error(`[Skillman] Download FAILED for ${skill.name}:`, e.message);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "error", message: e.message });
    }
  }

  console.log(`[Skillman] Downloaded ${blobs.length}/${skills.length} skills successfully`);

  if (blobs.length === 0) {
    console.error("[Skillman] Nothing downloaded — aborting install");
    notifyPopup({ type: "STATUS", message: "Download failed. Check console for details." });
    notifyPopup({ type: "DONE" });
    return;
  }

  // Step 2: Open claude.ai settings
  notifyPopup({ type: "STATUS", message: "Opening Claude settings..." });
  console.log("[Skillman] Opening claude.ai/settings/capabilities...");

  let claudeTab;
  try {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
    console.log(`[Skillman] Found ${tabs.length} existing claude.ai tab(s)`);

    if (tabs.length > 0) {
      claudeTab = tabs[0];
      await chrome.tabs.update(claudeTab.id, {
        url: "https://claude.ai/settings/capabilities",
        active: true,
      });
    } else {
      claudeTab = await chrome.tabs.create({
        url: "https://claude.ai/settings/capabilities",
        active: true,
      });
    }
    console.log(`[Skillman] Using tab ID: ${claudeTab.id}`);
  } catch (e) {
    console.error("[Skillman] Failed to open claude.ai tab:", e.message);
    notifyPopup({ type: "STATUS", message: "Failed to open Claude. Are you logged in?" });
    notifyPopup({ type: "DONE" });
    return;
  }

  // Step 3: Wait for page to fully load
  console.log("[Skillman] Waiting for page load...");
  await waitForTabLoad(claudeTab.id);
  await sleep(3000);
  console.log("[Skillman] Page ready. Starting injection...");

  // Step 4: Inject each skill
  for (const { skill, buffer } of blobs) {
    try {
      console.log(`[Skillman] Injecting skill: ${skill.name}`);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "installing" });
      notifyPopup({ type: "STATUS", message: `Installing ${skill.display_name || skill.name}...` });

      const base64 = bufferToBase64(buffer);
      console.log(`[Skillman] base64 size: ${base64.length} chars`);

      const results = await chrome.scripting.executeScript({
        target: { tabId: claudeTab.id },
        func: injectSkillUpload,
        args: [skill.name, base64],
      });

      console.log(`[Skillman] Injection result for ${skill.name}:`, JSON.stringify(results));

      await sleep(3000);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "installed" });
      console.log(`[Skillman] Install complete: ${skill.name}`);
    } catch (e) {
      console.error(`[Skillman] Injection FAILED for ${skill.name}:`, e.message);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "error", message: e.message });
    }
  }

  // Step 5: Save to local storage
  const existing = await getInstalled();
  const updated = [
    ...existing.filter((s) => !blobs.find((b) => b.skill.name === s.name)),
    ...blobs.map((b) => ({ name: b.skill.name, installedAt: Date.now() })),
  ];
  await chrome.storage.local.set({ installed: updated });
  console.log("[Skillman] Saved to storage:", updated.map(s => s.name));

  notifyPopup({ type: "STATUS", message: "Done!" });
  notifyPopup({ type: "DONE" });
}

// ── Injected into claude.ai page ──────────────────────────────────────────────
// NOTE: This function runs inside the claude.ai page context — no extension APIs available

function injectSkillUpload(skillName, base64Data) {
  return new Promise((resolve, reject) => {
    console.log("[Skillman-inject] Starting injection for:", skillName);

    try {
      // Convert base64 back to blob
      const binary = atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const file = new File([blob], `${skillName}.skill`, { type: "application/zip" });
      console.log("[Skillman-inject] Created File:", file.name, file.size, "bytes");

      // Strategy 1: Look for existing file input
      const allInputs = document.querySelectorAll('input[type="file"]');
      console.log("[Skillman-inject] File inputs on page:", allInputs.length);

      let skillInput = null;
      for (const input of allInputs) {
        const accepts = input.accept || "";
        const parentText = input.closest("[class]")?.textContent?.toLowerCase() || "";
        if (accepts.includes("zip") || accepts.includes(".skill") || parentText.includes("skill")) {
          skillInput = input;
          console.log("[Skillman-inject] Matched input, accept:", accepts);
          break;
        }
      }

      // Strategy 2: Click the upload button first
      if (!skillInput) {
        console.log("[Skillman-inject] No direct input — looking for upload button...");
        const allButtons = Array.from(document.querySelectorAll("button, [role='button']"));
        const btnTexts = allButtons.map(b => b.textContent?.trim()).filter(Boolean);
        console.log("[Skillman-inject] All buttons:", JSON.stringify(btnTexts.slice(0, 30)));

        const uploadBtn = allButtons.find(btn => {
          const text = (btn.textContent || "").toLowerCase();
          const label = (btn.getAttribute("aria-label") || "").toLowerCase();
          return text.includes("upload") || text.includes("add skill") ||
                 text.includes("import") || label.includes("upload") || label.includes("skill");
        });

        if (uploadBtn) {
          console.log("[Skillman-inject] Clicking upload button:", uploadBtn.textContent?.trim());
          uploadBtn.click();
          setTimeout(() => {
            const inputs = document.querySelectorAll('input[type="file"]');
            console.log("[Skillman-inject] Inputs after click:", inputs.length);
            if (inputs.length > 0) {
              injectFileIntoInput(inputs[inputs.length - 1], file, resolve, reject);
            } else {
              reject(new Error("No file input found after clicking upload button"));
            }
          }, 1000);
          return;
        }

        reject(new Error("Could not find upload button. Page buttons: " + JSON.stringify(btnTexts.slice(0, 10))));
        return;
      }

      injectFileIntoInput(skillInput, file, resolve, reject);

    } catch (e) {
      console.error("[Skillman-inject] Error:", e.message);
      reject(e);
    }

    function injectFileIntoInput(input, file, resolve, reject) {
      try {
        console.log("[Skillman-inject] Injecting file into input");
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        console.log("[Skillman-inject] File injected OK");
        setTimeout(resolve, 1500);
      } catch (e) {
        console.error("[Skillman-inject] Inject failed:", e.message);
        reject(e);
      }
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 8000); // fallback timeout
  });
}

async function getInstalled() {
  return new Promise((resolve) => {
    chrome.storage.local.get("installed", (res) => resolve(res.installed || []));
  });
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
