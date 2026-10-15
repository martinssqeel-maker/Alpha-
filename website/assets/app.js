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

async function resolveReleaseVersion() {
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    const version = String(release.tag_name || "").replace(/^v/i, "");
    if (version) setText("[data-version]", version);
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
