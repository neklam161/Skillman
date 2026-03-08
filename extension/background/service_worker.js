// service_worker.js — Skillman background worker
// Handles: registry fetching, skill downloading, install orchestration

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
    console.warn("[Skillman] Remote registry failed:", e.message, "— falling back to bundled");
    const url = chrome.runtime.getURL("registry.json");
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
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buffer = await res.arrayBuffer();
  console.log("[Skillman] Downloaded", buffer.byteLength, "bytes");
  return buffer;
}

// ── FIX #4: SHA-256 integrity verification ────────────────────────────────────
//
// Each skill in registry.json carries a "sha256" field (hex string).
// After downloading, we hash the buffer with SubtleCrypto and compare.
// If they don't match we throw — the install is aborted for that skill.

async function verifySHA256(buffer, expectedHex) {
  if (!expectedHex) {
    // No hash in registry entry — skip verification but warn.
    // Once all skills are hashed this branch should never be hit.
    console.warn("[Skillman] No sha256 in registry entry — skipping integrity check");
    return;
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  const actualHex  = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  if (actualHex !== expectedHex.toLowerCase()) {
    throw new Error(
      `Integrity check failed for skill.\n` +
      `Expected: ${expectedHex}\n` +
      `Got:      ${actualHex}\n` +
      `The file may have been tampered with or the registry is out of date.`
    );
  }

  console.log("[Skillman] Integrity OK:", actualHex.slice(0, 16) + "…");
}

// ── FIX #3: Safe base64 encoding (no stack overflow on large files) ───────────
//
// The naive approach — btoa(String.fromCharCode(...new Uint8Array(buffer))) —
// spreads the entire array as function arguments and crashes the JS engine
// on files larger than ~5 MB (call stack limit).
//
// This version processes bytes in 8 KB chunks so it works on any file size.

function bufferToBase64(buffer) {
  const bytes     = new Uint8Array(buffer);
  const chunkSize = 8192; // 8 KB per chunk — well within stack limits
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_REGISTRY") {
    fetchRegistry()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "INSTALL_SKILLS") {
    handleInstall(message.skills)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[Skillman] INSTALL_SKILLS error:", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === "INSTALL_ZIPPED") {
    handleInstallZipped(message.skillName, message.zipBase64)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[Skillman] INSTALL_ZIPPED error:", err);
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

  if (message.type === "GET_SESSION") {
    chrome.storage.local.get("session", (res) => {
      sendResponse({ session: res.session || null });
    });
    return true;
  }
});

// ── Session state helpers ─────────────────────────────────────────────────────

async function setSession(data) {
  await chrome.storage.local.set({ session: data });
}

async function clearSession() {
  await chrome.storage.local.remove("session");
}

// ── Tab close detection ───────────────────────────────────────────────────────

function waitForTabClose(tabId) {
  return new Promise((resolve) => {
    const listener = (id) => {
      if (id === tabId) {
        chrome.tabs.onRemoved.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onRemoved.addListener(listener);
  });
}

// ── Login check ───────────────────────────────────────────────────────────────

async function checkLoggedIn(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const url = window.location.href;
      const isLoginPage =
        url.includes("/login") ||
        url.includes("/sign-in") ||
        url.includes("claude.ai/login") ||
        document.title.toLowerCase().includes("sign in") ||
        !!document.querySelector('input[type="password"]');
      return { url, isLoginPage };
    }
  });
  return results?.[0]?.result || { isLoginPage: false };
}

// ── Install orchestration ─────────────────────────────────────────────────────

async function handleInstall(skills) {
  console.log("[Skillman] Starting install for:", skills.map(s => s.name));

  await setSession({
    skills: skills.map(s => ({ name: s.name, display_name: s.display_name, icon: s.icon })),
    progress: {},
    status: "starting",
    startedAt: Date.now()
  });

  // Step 1: Download + verify all .skill files
  const blobs = [];
  for (const skill of skills) {
    try {
      console.log(`[Skillman] Downloading: ${skill.name}`);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "downloading" });
      await updateSessionProgress(skill.name, "downloading");

      const buffer = await downloadSkillFile(skill.source);

      // FIX #4: Verify integrity before proceeding
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "verifying" });
      await updateSessionProgress(skill.name, "verifying");
      await verifySHA256(buffer, skill.sha256);

      blobs.push({ skill, buffer });

      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "downloaded" });
      await updateSessionProgress(skill.name, "downloaded");
      console.log(`[Skillman] Download + verify OK: ${skill.name}`);
    } catch (e) {
      console.error(`[Skillman] Download/verify FAILED for ${skill.name}:`, e.message);

      // Surface integrity failures differently from network errors
      const isIntegrityError = e.message.startsWith("Integrity check failed");
      notifyPopup({
        type: "PROGRESS",
        skill: skill.name,
        status: "error",
        message: isIntegrityError
          ? "Integrity check failed — skill file may be corrupted"
          : e.message
      });
      await updateSessionProgress(skill.name, "error");
    }
  }

  if (blobs.length === 0) {
    console.error("[Skillman] Nothing downloaded — aborting");
    notifyPopup({ type: "STATUS", message: "All downloads failed. Check your internet connection." });
    notifyPopup({ type: "DONE", hadErrors: true });
    await clearSession();
    return;
  }

  // Step 2: Open claude.ai skills page
  notifyPopup({ type: "STATUS", message: "Opening Claude..." });
  await setSession({ status: "opening_claude" });

  let claudeTab;
  try {
    const skillsTabs = await chrome.tabs.query({ url: "https://claude.ai/customize/skills" });
    const anyTabs    = await chrome.tabs.query({ url: "https://claude.ai/*" });

    if (skillsTabs.length > 0) {
      claudeTab = skillsTabs[0];
      console.log(`[Skillman] Already on skills page, tab ${claudeTab.id}`);
    } else if (anyTabs.length > 0) {
      claudeTab = await chrome.tabs.create({
        url: "https://claude.ai/customize/skills",
        active: false,
        index: anyTabs[0].index + 1,
        windowId: anyTabs[0].windowId,
      });
    } else {
      claudeTab = await chrome.tabs.create({
        url: "https://claude.ai/customize/skills",
        active: false,
      });
    }
    console.log(`[Skillman] Using tab ID: ${claudeTab.id}`);
  } catch (e) {
    console.error("[Skillman] Failed to open tab:", e.message);
    notifyPopup({ type: "STATUS", message: "Could not open Claude. Try again." });
    notifyPopup({ type: "DONE", hadErrors: true });
    await clearSession();
    return;
  }

  // Step 3: Wait for page load, watching for tab close
  console.log("[Skillman] Waiting for page load...");
  notifyPopup({ type: "STATUS", message: "Waiting for Claude to load..." });

  const tabClosed  = waitForTabClose(claudeTab.id);
  const pageLoaded = waitForTabLoad(claudeTab.id);

  const winner = await Promise.race([
    pageLoaded.then(() => "loaded"),
    tabClosed.then(() => "closed"),
  ]);

  if (winner === "closed") {
    console.warn("[Skillman] Tab was closed before page loaded");
    notifyPopup({ type: "STATUS", message: "The Claude tab was closed. Install cancelled." });
    notifyPopup({ type: "DONE", hadErrors: true });
    await clearSession();
    return;
  }

  await sleep(3000);

  // Step 4: Check login
  console.log("[Skillman] Checking login status...");
  let loginCheck;
  try {
    loginCheck = await checkLoggedIn(claudeTab.id);
  } catch (e) {
    loginCheck = { isLoginPage: false };
  }

  if (loginCheck.isLoginPage) {
    console.warn("[Skillman] User is not logged in:", loginCheck.url);
    notifyPopup({
      type: "STATUS",
      message: "⚠️ You're not logged in to Claude. Please log in and try again."
    });
    notifyPopup({ type: "NOT_LOGGED_IN" });
    notifyPopup({ type: "DONE", hadErrors: true });
    await clearSession();
    return;
  }

  console.log("[Skillman] Logged in, page ready. Starting injection...");

  // Step 5: Inject each skill
  for (const { skill, buffer } of blobs) {
    const tabStillOpen = await chrome.tabs.get(claudeTab.id).then(() => true).catch(() => false);
    if (!tabStillOpen) {
      console.warn("[Skillman] Tab closed mid-install");
      notifyPopup({ type: "STATUS", message: "Claude tab was closed mid-install. Some skills may not have installed." });
      notifyPopup({ type: "DONE", hadErrors: true });
      await clearSession();
      return;
    }

    try {
      console.log(`[Skillman] Injecting: ${skill.name}`);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "installing" });
      notifyPopup({ type: "STATUS", message: `Installing ${skill.display_name || skill.name}...` });
      await updateSessionProgress(skill.name, "installing");

      const base64 = bufferToBase64(buffer); // FIX #3: now safe for large files
      const results = await chrome.scripting.executeScript({
        target: { tabId: claudeTab.id },
        func: injectSkillUpload,
        args: [skill.name, base64],
      });

      console.log(`[Skillman] Inject result for ${skill.name}:`, JSON.stringify(results));
      await sleep(3000);

      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "installed" });
      await updateSessionProgress(skill.name, "installed");
    } catch (e) {
      console.error(`[Skillman] Inject FAILED for ${skill.name}:`, e.message);
      notifyPopup({ type: "PROGRESS", skill: skill.name, status: "error", message: e.message });
      await updateSessionProgress(skill.name, "error");
    }
  }

  // Step 6: Persist installed list
  const existing = await getInstalled();
  const updated = [
    ...existing.filter((s) => !blobs.find((b) => b.skill.name === s.name)),
    ...blobs.map((b) => ({ name: b.skill.name, installedAt: Date.now() })),
  ];
  await chrome.storage.local.set({ installed: updated });
  console.log("[Skillman] Saved to storage:", updated.map(s => s.name));

  try { await chrome.tabs.remove(claudeTab.id); } catch(e) {}

  notifyPopup({ type: "STATUS", message: "All done!" });
  notifyPopup({ type: "DONE", hadErrors: false });
  await clearSession();
}

// ── INSTALL_ZIPPED (folder-based installs) ────────────────────────────────────

async function handleInstallZipped(skillName, zipBase64) {
  console.log("[Skillman] Installing zipped skill:", skillName);

  const binary = atob(zipBase64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const buffer = bytes.buffer;

  let claudeTab;
  const skillsTabs = await chrome.tabs.query({ url: "https://claude.ai/customize/skills" });
  const anyTabs    = await chrome.tabs.query({ url: "https://claude.ai/*" });
  if (skillsTabs.length > 0) {
    claudeTab = skillsTabs[0];
  } else if (anyTabs.length > 0) {
    claudeTab = await chrome.tabs.create({
      url: "https://claude.ai/customize/skills",
      active: false,
      index: anyTabs[0].index + 1,
      windowId: anyTabs[0].windowId,
    });
  } else {
    claudeTab = await chrome.tabs.create({ url: "https://claude.ai/customize/skills", active: false });
  }

  const tabClosed  = waitForTabClose(claudeTab.id);
  const pageLoaded = waitForTabLoad(claudeTab.id);
  const winner = await Promise.race([
    pageLoaded.then(() => "loaded"),
    tabClosed.then(() => "closed"),
  ]);

  if (winner === "closed") {
    throw new Error("Claude tab was closed before install could complete");
  }

  await sleep(3000);

  const loginCheck = await checkLoggedIn(claudeTab.id).catch(() => ({ isLoginPage: false }));
  if (loginCheck.isLoginPage) {
    throw new Error("Not logged in to Claude — please log in and try again");
  }

  const tabStillOpen = await chrome.tabs.get(claudeTab.id).then(() => true).catch(() => false);
  if (!tabStillOpen) throw new Error("Claude tab was closed");

  const base64 = bufferToBase64(buffer); // FIX #3: safe for large files
  await chrome.scripting.executeScript({
    target: { tabId: claudeTab.id },
    func: injectSkillUpload,
    args: [skillName, base64],
  });

  const existing = await getInstalled();
  const updated = [
    ...existing.filter(s => s.name !== skillName),
    { name: skillName, installedAt: Date.now() }
  ];
  await chrome.storage.local.set({ installed: updated });
  console.log("[Skillman] Zipped install saved:", skillName);
}

// ── FIX #2 (partial): Better injection error messages ─────────────────────────
//
// injectSkillUpload now returns a structured result object instead of
// resolving/rejecting silently, so the caller can surface a clear message
// when Claude's DOM changes.

function injectSkillUpload(skillName, base64Data) {
  return new Promise((resolve, reject) => {
    console.log("[Skillman-inject] Starting injection for:", skillName);
    try {
      const binary = atob(base64Data);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const file = new File([blob], `${skillName}.skill`, { type: "application/zip" });
      console.log("[Skillman-inject] Created File:", file.name, file.size, "bytes");

      const allInputs = document.querySelectorAll('input[type="file"]');
      console.log("[Skillman-inject] File inputs on page:", allInputs.length);

      let skillInput = null;
      for (const input of allInputs) {
        const accepts   = input.accept || "";
        const parentText = input.closest("[class]")?.textContent?.toLowerCase() || "";
        if (accepts.includes("zip") || accepts.includes(".skill") || parentText.includes("skill")) {
          skillInput = input;
          break;
        }
      }

      if (!skillInput) {
        const allButtons = Array.from(document.querySelectorAll("button, [role='button']"));
        const btnTexts   = allButtons.map(b => b.textContent?.trim()).filter(Boolean);
        console.log("[Skillman-inject] Buttons found:", JSON.stringify(btnTexts.slice(0, 20)));

        const uploadBtn = allButtons.find(btn => {
          const text  = (btn.textContent || "").toLowerCase();
          const label = (btn.getAttribute("aria-label") || "").toLowerCase();
          return text.includes("upload") || text.includes("add skill") ||
                 text.includes("import") || label.includes("upload") || label.includes("skill");
        });

        if (uploadBtn) {
          console.log("[Skillman-inject] Clicking upload button:", uploadBtn.textContent?.trim());
          uploadBtn.click();
          setTimeout(() => {
            const inputs = document.querySelectorAll('input[type="file"]');
            if (inputs.length > 0) {
              injectFileIntoInput(inputs[inputs.length - 1], file, resolve, reject);
            } else {
              // FIX #2: Actionable message when Claude's DOM has changed
              reject(new Error(
                "Could not find a file input after clicking the upload button. " +
                "Claude's page layout may have changed — please report this at " +
                "github.com/neklam161/Skillman/issues so we can update the extension."
              ));
            }
          }, 1000);
          return;
        }

        // FIX #2: Distinguish "wrong page" from "DOM changed"
        const onSkillsPage = window.location.pathname.includes("/customize/skills");
        if (!onSkillsPage) {
          reject(new Error(
            "Skillman could not reach the Claude skills page. " +
            "Please make sure you are logged in to claude.ai and try again."
          ));
        } else {
          reject(new Error(
            "Could not find the skill upload button. Claude's page layout may have " +
            "changed — please report this at github.com/neklam161/Skillman/issues."
          ));
        }
        return;
      }

      injectFileIntoInput(skillInput, file, resolve, reject);
    } catch (e) {
      console.error("[Skillman-inject] Unexpected error:", e.message);
      reject(new Error(`Injection error: ${e.message}`));
    }

    function injectFileIntoInput(input, file, resolve, reject) {
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input",  { bubbles: true }));
        console.log("[Skillman-inject] File injected OK");
        setTimeout(resolve, 1500);
      } catch (e) {
        reject(new Error(`Could not set file on input: ${e.message}`));
      }
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    setTimeout(resolve, 8000); // fallback
  });
}

async function getInstalled() {
  return new Promise((resolve) => {
    chrome.storage.local.get("installed", (res) => resolve(res.installed || []));
  });
}

async function updateSessionProgress(skillName, status) {
  const data = await new Promise(resolve =>
    chrome.storage.local.get("session", r => resolve(r.session))
  );
  if (!data) return;
  data.progress = data.progress || {};
  data.progress[skillName] = status;
  await chrome.storage.local.set({ session: data });
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
