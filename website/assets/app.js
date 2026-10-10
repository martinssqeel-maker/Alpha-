// Alpha AI Workspace — landing page behaviour.
// Resolves the latest GitHub release so the download button is never stale.

const REPO = "martinssqeel-maker/Alpha-";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

function formatSize(bytes) {
  if (!bytes || bytes < 0) return null;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function setText(selector, value) {
  if (!value) return;
  document.querySelectorAll(selector).forEach((el) => {
    el.textContent = value;
  });
}

function setDownload(url) {
  document.querySelectorAll("[data-download]").forEach((el) => {
    el.setAttribute("href", url);
    el.setAttribute("rel", "noopener");
  });
}

async function resolveLatestRelease() {
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();

    const version = String(release.tag_name || "").replace(/^v/i, "");
    const asset = (release.assets || []).find((a) => /\.exe$/i.test(a.name));

    if (version) setText("[data-version]", version);
    if (asset) {
      setDownload(asset.browser_download_url);
      const size = formatSize(asset.size);
      if (size) setText("[data-size-hint]", `~${size.replace(" ", " ")} installer`);
    }
  } catch (err) {
    // Offline or rate-limited: keep the graceful fallback link.
    console.warn("Could not resolve latest release:", err && err.message);
    setDownload(FALLBACK_URL);
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
  resolveLatestRelease();
});
