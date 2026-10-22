// Alpha AI Workspace — landing page behaviour.
//
// The landing page explains the product and routes visitors to Get Started /
// Sign in. It deliberately does NOT offer an installer: the download lives in
// the account area, behind a session the API checks server-side.
//
// The only thing fetched here is the current release *version label*, from the
// same public GitHub Releases API the desktop updater uses. It is decoration —
// if the lookup fails (offline, rate-limited) the page keeps the generic
// "current release" wording and nothing else changes.

const REPO = "martinssqeel-maker/Alpha-";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

function setText(selector, value) {
  if (!value) return;
  document.querySelectorAll(selector).forEach((el) => {
    el.textContent = value;
  });
}

/**
 * Point a link at the exact tagged release.
 *
 * The site never hardcodes a version: the release published on GitHub is the
 * source of truth, so a v1.0.7 publish makes every page show v1.0.7 with no code
 * change. Elements carry a static fallback href (the releases page) that stays
 * in place if this lookup fails, which is what an offline or rate-limited
 * visitor sees.
 */
function setReleaseLinks(tag) {
  if (!tag) return;
  const href = `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`;
  document.querySelectorAll("[data-release-link]").forEach((el) => {
    el.setAttribute("href", href);
    el.setAttribute("rel", "noopener");
  });
  document.querySelectorAll("[data-release-tag]").forEach((el) => {
    el.textContent = `v${String(tag).replace(/^v/i, "")}`;
  });
}

async function resolveReleaseVersion() {
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    const tag = String(release.tag_name || "");
    const version = tag.replace(/^v/i, "");
    if (version) setText("[data-version]", version);
    setReleaseLinks(tag || `v${version}`);
  } catch (err) {
    console.warn("Could not resolve the current release version:", err && err.message);
  }
}

function setupReveal() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const targets = document.querySelectorAll(".section-head, .card, .steps li, .req, .cta-card, .window");
  if (reduce || !("IntersectionObserver" in window)) return;

  targets.forEach((el) => {
    el.style.opacity = "0";
    el.style.transform = "translateY(16px)";
    el.style.transition = "opacity .6s ease, transform .6s ease";
  });

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.style.opacity = "1";
          entry.target.style.transform = "none";
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );

  targets.forEach((el) => io.observe(el));
}

document.addEventListener("DOMContentLoaded", () => {
  setupReveal();
  resolveReleaseVersion();
});
