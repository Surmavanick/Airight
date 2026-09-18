/* Aright — site behaviour
   Loader, scroll reveals, counters, nav, tabs, contact form. No dependencies. */

// Set this to the address that should receive "Request Access" messages.
// Until it is set, the form explains that the inbox is not connected yet.
const CONTACT_EMAIL = "";

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let reduceMotion = motionQuery.matches;
motionQuery.addEventListener?.("change", (event) => {
  reduceMotion = event.matches;
});

/* ---------- Loader ---------- */
document.body.classList.add("is-loading");
const loader = document.getElementById("loader");
const loaderStart = performance.now();
let loaderFinishQueued = false;

function finishLoader() {
  if (loaderFinishQueued) return;
  loaderFinishQueued = true;
  const minVisible = reduceMotion ? 0 : 180;
  const wait = Math.max(0, minVisible - (performance.now() - loaderStart));
  setTimeout(() => {
    loader.classList.add("is-done");
    document.body.classList.remove("is-loading");
    document.dispatchEvent(new CustomEvent("loader:done"));
  }, wait);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", finishLoader, { once: true });
} else {
  finishLoader();
}
// Independent safety net: remote fonts and below-fold media never trap the UI.
setTimeout(finishLoader, 1500);

/* ---------- Reveal on scroll ---------- */
const revealEls = document.querySelectorAll(".reveal");
const revealClasses = ["reveal", "reveal--left", "reveal--right", "reveal--scale", "in"];

function finishReveal(el) {
  el.classList.add("has-revealed");
  el.classList.remove(...revealClasses);
}

function revealElement(el) {
  if (reduceMotion) {
    finishReveal(el);
    return;
  }

  el.classList.add("in");
  const delay = Number.parseFloat(getComputedStyle(el).getPropertyValue("--d")) || 0;
  setTimeout(() => finishReveal(el), 850 + delay * 1000);
}

function startReveals() {
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(revealElement);
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        revealElement(entry.target);
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -7% 0px" }
  );
  revealEls.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const alreadyVisible = rect.top < window.innerHeight && rect.bottom > 0;
    if (alreadyVisible) revealElement(el);
    else io.observe(el);
  });
}

if (loader.classList.contains("is-done")) startReveals();
else document.addEventListener("loader:done", startReveals, { once: true });

/* ---------- Counters ---------- */
function animateCount(el) {
  const target = Number(el.dataset.count);
  if (reduceMotion) {
    el.textContent = String(target);
    return;
  }
  const duration = 1400;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const counters = document.querySelectorAll("[data-count]");
function startCounters() {
  if ("IntersectionObserver" in window) {
    const cio = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          animateCount(entry.target);
          cio.unobserve(entry.target);
        }
      },
      { threshold: 0.6 }
    );
    counters.forEach((el) => cio.observe(el));
  } else {
    counters.forEach(animateCount);
  }
}

/* ---------- Donut chart ---------- */
function startDonuts() {
  document.querySelectorAll(".donut__fill").forEach((circle) => {
    const pct = Number(circle.dataset.pct || 0);
    const circumference = 2 * Math.PI * Number(circle.getAttribute("r"));
    circle.style.strokeDasharray = String(circumference);
    const setOffset = () => {
      circle.style.strokeDashoffset = String(circumference * (1 - pct / 100));
    };
    if (reduceMotion || !("IntersectionObserver" in window)) {
      setOffset();
      return;
    }
    const dio = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOffset();
          dio.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    dio.observe(circle);
  });
}

if (loader.classList.contains("is-done")) {
  startCounters();
  startDonuts();
} else {
  document.addEventListener("loader:done", startCounters, { once: true });
  document.addEventListener("loader:done", startDonuts, { once: true });
}

/* ---------- Nav ---------- */
const nav = document.getElementById("nav");
const navToggle = document.getElementById("navToggle");
const navLinks = [...document.querySelectorAll(".nav__link")];
const mobileNavQuery = window.matchMedia("(max-width: 959px)");

function setMenuOpen(open) {
  nav.classList.toggle("is-open", open);
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

navToggle.addEventListener("click", () => {
  setMenuOpen(!nav.classList.contains("is-open"));
});

mobileNavQuery.addEventListener?.("change", (event) => {
  if (!event.matches) setMenuOpen(false);
});

document.querySelectorAll("#navMenu a").forEach((a) => {
  a.addEventListener("click", () => {
    setMenuOpen(false);
  });
});

document.addEventListener("click", (e) => {
  if (!nav.contains(e.target)) {
    setMenuOpen(false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && nav.classList.contains("is-open")) {
    setMenuOpen(false);
    navToggle.focus();
  }
});

// Scroll spy: highlight the nav link for the section in view.
const spyTargets = navLinks
  .map((link) => {
    const id = link.getAttribute("href");
    return id && id.startsWith("#") ? { link, el: document.querySelector(id) } : null;
  })
  .filter((t) => t && t.el);

function updateNav() {
  const scrollY = window.scrollY;
  nav.classList.toggle("is-scrolled", scrollY > 40);

  const marker = scrollY + window.innerHeight * 0.35;
  let current = spyTargets[0];
  for (const t of spyTargets) {
    if (t.el.offsetTop <= marker) current = t;
  }
  const contact = document.getElementById("contact");
  if (contact && contact.offsetTop <= marker) current = null;
  spyTargets.forEach((t) => {
    const active = t === current;
    t.link.classList.toggle("is-active", active);
    if (active) t.link.setAttribute("aria-current", "page");
    else t.link.removeAttribute("aria-current");
  });
}

/* ---------- Scroll updates ---------- */
let ticking = false;

function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    updateNav();
    ticking = false;
  });
}

window.addEventListener("scroll", onScroll, { passive: true });
updateNav();

/* ---------- Product tabs ---------- */
const tabTitles = {
  scoring: "Score every AI-generated asset across your entire organization",
  evidence: "Keep prompts, sources, and decisions in one defensible evidence vault",
  plan: "Turn every score into an action plan your team can actually finish",
  agents: "Let workflow agents run the routine steps and escalate only what matters",
};

const appTitle = document.getElementById("appTitle");
const productPanel = document.getElementById("productPanel");
const tabs = [...document.querySelectorAll(".tab")];
let titleTimer;

function activateTab(tab, moveFocus = false) {
  tabs.forEach((t) => {
    const active = t === tab;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", String(active));
    t.setAttribute("tabindex", active ? "0" : "-1");
  });

  if (productPanel) productPanel.setAttribute("aria-labelledby", tab.id);
  if (moveFocus) tab.focus();

  const next = tabTitles[tab.dataset.tab];
  if (next && appTitle) {
    clearTimeout(titleTimer);
    if (reduceMotion) {
      appTitle.textContent = next;
      appTitle.classList.remove("is-changing");
      return;
    }

    appTitle.classList.add("is-changing");
    titleTimer = setTimeout(() => {
      appTitle.textContent = next;
      requestAnimationFrame(() => appTitle.classList.remove("is-changing"));
    }, 180);
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (e) => {
    let nextIndex;
    if (e.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (e.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") nextIndex = 0;
    if (e.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    e.preventDefault();
    activateTab(tabs[nextIndex], true);
  });
});

/* ---------- Contact form ---------- */
const form = document.getElementById("contactForm");
const note = document.getElementById("formNote");

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const email = String(data.get("email") || "").trim();
  const message = String(data.get("message") || "").trim();

  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    note.textContent = "Please add your name and a valid work email.";
    return;
  }

  if (!CONTACT_EMAIL) {
    note.textContent = "This preview is ready, but the request inbox still needs to be connected.";
    return;
  }

  const subject = encodeURIComponent(`Aright access request from ${name}`);
  const body = encodeURIComponent(`Name: ${name}\nEmail: ${email}\n\n${message}`);
  window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  note.textContent = "Opening your email client…";
  form.reset();
});

/* ---------- Footer year ---------- */
const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());

clearTimeout(window.__arightBootWatch);
document.documentElement.classList.remove("no-js", "boot-failed");
document.documentElement.classList.add("js", "js-ready");
