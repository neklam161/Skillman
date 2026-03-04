// service_worker.js — Skillman background worker
// Handles: registry fetching, skill downloading, zip creation, install orchestration

const REGISTRY_URL =
  "https://raw.githubusercontent.com/your-org/skillman-registry/main/registry.json";

// ── Registry ──────────────────────────────────────────────────────────────────

async function fetchRegistry() {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    // Fall back to bundled registry (registry.json lives in extension root)
    const url = chrome.runtime.getURL("registry.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Could not load bundled registry");
    return await res.json();
  }
}

// ── Skill downloading & zipping ───────────────────────────────────────────────

async function downloadSkillFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download skill: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_REGISTRY") {
    fetchRegistry()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }

  if (message.type === "INSTALL_SKILLS") {
    handleInstall(message.skills, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
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
  // Download all .skill files (they're already zips)
  const blobs = [];
  for (const skill of skills) {
    try {
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "downloading" });
      const buffer = await downloadSkillFile(skill.source);
      blobs.push({ skill, buffer });
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "downloaded" });
    } catch (e) {
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "error", message: e.message });
    }
  }

  if (blobs.length === 0) return;

  // Open claude.ai settings tab
  notifyPopup({ type: "STATUS", message: "Opening Claude settings..." });

  let claudeTab;
  const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });

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

  // Wait for page load
  await waitForTabLoad(claudeTab.id);
  await sleep(2000);

  // Inject skills one by one
  for (const { skill, buffer } of blobs) {
    try {
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "installing" });

      // Convert buffer to base64 to pass via scripting API
      const base64 = bufferToBase64(buffer);

      await chrome.scripting.executeScript({
        target: { tabId: claudeTab.id },
        func: injectSkillUpload,
        args: [skill.name, base64],
      });

      await sleep(2500); // Give claude.ai time to process each upload

      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "installed" });
    } catch (e) {
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "error", message: e.message });
    }
  }

  // Save installed skills to storage
  const existing = await getInstalled();
  const updated = [
    ...existing.filter((s) => !blobs.find((b) => b.skill.name === s.name)),
    ...blobs.map((b) => ({ name: b.skill.name, installedAt: Date.now() })),
  ];
  await chrome.storage.local.set({ installed: updated });

  notifyPopup({ type: "DONE" });
}

// ── Injected into claude.ai page ──────────────────────────────────────────────
// This function runs IN the claude.ai page context

function injectSkillUpload(skillName, base64Data) {
  return new Promise((resolve, reject) => {
    try {
      // Convert base64 back to blob
      const binary = atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const file = new File([blob], `${skillName}.skill`, { type: "application/zip" });

      // Find the file input for skill upload
      // Claude.ai uses a hidden <input type="file"> triggered by a button
      const fileInputs = document.querySelectorAll('input[type="file"]');
      let skillInput = null;

      for (const input of fileInputs) {
        if (
          input.accept?.includes("zip") ||
          input.accept?.includes(".skill") ||
          input.closest("[data-testid*='skill']") ||
          input.closest("[class*='skill']")
        ) {
          skillInput = input;
          break;
        }
      }

      // Fallback: find the Skills section upload button and click it first
      if (!skillInput) {
        const buttons = Array.from(document.querySelectorAll("button"));
        const uploadBtn = buttons.find(
          (b) =>
            b.textContent?.toLowerCase().includes("upload") ||
            b.textContent?.toLowerCase().includes("add skill") ||
            b.getAttribute("aria-label")?.toLowerCase().includes("skill")
        );
        if (uploadBtn) uploadBtn.click();

        // Re-check for file input after click
        setTimeout(() => {
          const inputs = document.querySelectorAll('input[type="file"]');
          const input = inputs[inputs.length - 1]; // most recently added
          if (input) {
            injectFile(input, file, resolve, reject);
          } else {
            reject(new Error("Could not find skill upload input"));
          }
        }, 800);
        return;
      }

      injectFile(skillInput, file, resolve, reject);
    } catch (e) {
      reject(e);
    }

    function injectFile(input, file, resolve, reject) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(resolve, 1000);
      } catch (e) {
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
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
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
  });
}

async function getInstalled() {
  return new Promise((resolve) => {
    chrome.storage.local.get("installed", (res) => resolve(res.installed || []));
  });
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // popup may be closed, ignore
}
