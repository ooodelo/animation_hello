const MIN_ACTIVE = 3;
const MAX_ACTIVE = 4;
const ASSET_DIRECTORY = "assets/";
const PNG_EXTENSION = /\.png$/i;
const FLAKE_SIZE = parseFloat(
  getComputedStyle(document.documentElement).getPropertyValue("--flake-size")
);

let stage = null;
let hasInitialized = false;
let initInProgress = false;

const state = {
  images: [],
  activeFlakes: [],
  lastTime: null,
  nextSpawn: 0,
  areas: [],
  areaUsage: Object.create(null),
  seededRandom: createSeededRandom(Date.now()),
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

function createSeededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function randomRange(min, max, rand = Math.random) {
  return min + (max - min) * rand();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createNoise(rand) {
  const phases = [rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2];
  const frequencies = [randomRange(0.08, 0.18, rand), randomRange(0.18, 0.32, rand), randomRange(0.32, 0.52, rand)];
  const weights = [0.6, 0.3, 0.1];
  return function (t) {
    let value = 0;
    for (let i = 0; i < 3; i += 1) {
      value += weights[i] * Math.sin(t * frequencies[i] + phases[i]);
    }
    return value;
  };
}

function computeEnvelope(y, size, height) {
  const enter = clamp((y + size) / size, 0, 1);
  const exit = clamp((height - y) / size, 0, 1);
  return Math.pow(Math.min(enter, exit), 0.85);
}

function recalcAreas() {
  if (!stage) {
    return;
  }
  const rect = stage.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const nextAreas = [
    { name: "left", min: width * 0.05, max: width * 0.35 },
    { name: "center", min: width * 0.35, max: width * 0.65 },
    { name: "right", min: width * 0.65, max: width * 0.95 },
  ].map((area) => ({
    ...area,
    center: (area.min + area.max) / 2,
    width: area.max - area.min,
    height,
  }));
  const areaMap = Object.fromEntries(nextAreas.map((area) => [area.name, area]));
  for (const area of nextAreas) {
    if (!(area.name in state.areaUsage)) {
      state.areaUsage[area.name] = 0;
    }
  }
  for (const flake of state.activeFlakes) {
    const updated = areaMap[flake.area.name];
    if (updated) {
      flake.area = updated;
      const half = flake.size / 2;
      flake.baseX = clamp(flake.baseX, updated.min + half, updated.max - half);
    }
  }
  state.areas = nextAreas;
}

class Flake {
  constructor({ image, area, baseX, speed, seed, initialOffset }) {
    this.image = image;
    this.area = area;
    this.baseX = baseX;
    this.speed = speed;
    this.size = FLAKE_SIZE;
    this.y = -this.size - (initialOffset || 0);
    this.seed = seed;
    this.noiseClock = randomRange(0, 1000, state.seededRandom);

    const rand = createSeededRandom(seed);
    this.horizontalNoise = createNoise(rand);
    this.driftNoise = createNoise(rand);
    this.verticalNoise = createNoise(rand);
    this.tiltNoise = createNoise(rand);

    this.swayAmplitude = randomRange(12, 20, rand);
    this.driftAmplitude = randomRange(4, 10, rand);
    this.verticalAmplitude = randomRange(3, 6, rand);
    this.tiltAmplitude = randomRange(2, 6, rand);

    this.element = document.createElement("div");
    this.element.className = "flake";
    this.element.style.width = `${this.size}px`;
    this.element.style.height = `${this.size}px`;

    const img = document.createElement("img");
    img.src = image.src;
    img.alt = "";
    this.element.appendChild(img);
  }

  update(dt, boundsHeight) {
    this.y += this.speed * dt;
    this.noiseClock += dt;
    const envelope = computeEnvelope(this.y, this.size, boundsHeight);

    const sway = this.horizontalNoise(this.noiseClock) * this.swayAmplitude * envelope;
    const drift = this.driftNoise(this.noiseClock * 0.65) * this.driftAmplitude * envelope;
    const vertical = this.verticalNoise(this.noiseClock * 0.9) * this.verticalAmplitude * envelope;
    const tilt = this.tiltNoise(this.noiseClock * 0.75) * this.tiltAmplitude * envelope;

    const half = this.size / 2;
    const areaMin = this.area.min + half;
    const areaMax = this.area.max - half;
    const xCenter = clamp(this.baseX + sway + drift, areaMin, areaMax);
    const x = xCenter - half;
    const y = this.y + vertical;

    this.element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
  }

  isOutOfView(boundsHeight) {
    return this.y >= boundsHeight + this.size;
  }
}

function encodeAssetPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeAssetName(candidate) {
  if (!candidate) {
    return "";
  }
  let sanitized = candidate.trim();
  sanitized = sanitized.replace(/^(\.\/)+/, "");
  sanitized = sanitized.replace(/^(\.\\)+/, "");
  sanitized = sanitized.replace(/^\/+/, "");
  if (sanitized.startsWith(ASSET_DIRECTORY)) {
    sanitized = sanitized.slice(ASSET_DIRECTORY.length);
  }
  const [cleanPath] = sanitized.split(/[?#]/);
  try {
    return decodeURIComponent(cleanPath);
  } catch (error) {
    return cleanPath;
  }
}

function uniquePngNames(entries) {
  const seen = new Set();
  const names = [];
  for (const entry of entries) {
    const normalized = normalizeAssetName(entry);
    if (
      !normalized ||
      normalized.includes("..") ||
      !PNG_EXTENSION.test(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    names.push(normalized);
  }
  return names;
}

async function loadFromDirectoryListing() {
  try {
    const response = await fetch(ASSET_DIRECTORY, { cache: "no-store" });
    if (!response.ok) {
      return [];
    }
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      if (Array.isArray(data)) {
        return uniquePngNames(data);
      }
      if (Array.isArray(data?.icons)) {
        return uniquePngNames(data.icons);
      }
    }
    const text = await response.text();
    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const anchors = Array.from(doc.querySelectorAll("a[href]"));
      const hrefs = anchors.map((anchor) => anchor.getAttribute("href"));
      const fromAnchors = uniquePngNames(hrefs);
      if (fromAnchors.length) {
        return fromAnchors;
      }
    }
    const plainMatches = text.match(/[^\s"']+\.png/gi) || [];
    return uniquePngNames(plainMatches);
  } catch (error) {
    console.warn("Не удалось получить список файлов из каталога assets:", error);
    return [];
  }
}

async function loadFromManifestFile() {
  try {
    const response = await fetch(`${ASSET_DIRECTORY}manifest.json`, { cache: "no-store" });
    if (!response.ok) {
      return [];
    }
    const entries = await response.json();
    return uniquePngNames(Array.isArray(entries) ? entries : entries?.icons ?? []);
  } catch (error) {
    console.warn("Не удалось загрузить manifest.json:", error);
    return [];
  }
}

async function loadIconCatalog() {
  if (Array.isArray(window.SNOWFALL_ASSETS) && window.SNOWFALL_ASSETS.length) {
    return uniquePngNames(window.SNOWFALL_ASSETS);
  }
  const fromListing = await loadFromDirectoryListing();
  if (fromListing.length) {
    return fromListing;
  }
  const fromManifest = await loadFromManifestFile();
  if (fromManifest.length) {
    return fromManifest;
  }
  return [];
}

async function preloadImages() {
  const entries = await loadIconCatalog();
  if (!entries.length) {
    throw new Error(
      "Не удалось обнаружить PNG-иконки в папке assets. Проверьте содержимое каталога и настройки сервера."
    );
  }
  const preloadPromises = entries.map(
    (name) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () =>
          resolve({
            src: `${ASSET_DIRECTORY}${encodeAssetPath(name)}`,
            width: img.naturalWidth,
            height: img.naturalHeight,
            inUse: false,
            name,
          });
        img.onerror = () => reject(new Error(`Не удалось загрузить ${name}`));
        img.src = `${ASSET_DIRECTORY}${encodeAssetPath(name)}`;
      })
  );
  return Promise.all(preloadPromises);
}

function pickArea() {
  const areas = state.areas;
  const sorted = [...areas].sort((a, b) => {
    const usageA = state.areaUsage[a.name] ?? 0;
    const usageB = state.areaUsage[b.name] ?? 0;
    if (usageA !== usageB) {
      return usageA - usageB;
    }
    return state.seededRandom() - 0.5;
  });
  return sorted[0];
}

function pickImage() {
  const available = state.images.filter((image) => !image.inUse);
  if (!available.length) {
    return null;
  }
  const index = Math.floor(state.seededRandom() * available.length);
  return available[index];
}

function spawnFlake({ force = false, initialOffset = 0 } = {}) {
  if (!force && state.activeFlakes.length >= MAX_ACTIVE) {
    return false;
  }
  if (!stage) {
    return false;
  }
  const image = pickImage();
  if (!image) {
    return false;
  }
  const area = pickArea();
  const seed = Math.floor(state.seededRandom() * 1e9);
  const areaSpan = area.width * 0.2;
  const baseX = clamp(
    area.center + randomRange(-areaSpan, areaSpan, state.seededRandom),
    area.min + FLAKE_SIZE / 2,
    area.max - FLAKE_SIZE / 2
  );
  const stageHeight = stage.getBoundingClientRect().height;
  const speed = randomRange(stageHeight / 14, stageHeight / 9, state.seededRandom);
  const flake = new Flake({ image, area, baseX, speed, seed, initialOffset });
  image.inUse = true;
  state.activeFlakes.push(flake);
  state.areaUsage[area.name] = (state.areaUsage[area.name] ?? 0) + 1;
  stage.appendChild(flake.element);
  return true;
}

function recycleFlake(flake) {
  flake.image.inUse = false;
  state.areaUsage[flake.area.name] = Math.max(0, (state.areaUsage[flake.area.name] ?? 1) - 1);
  if (stage && flake.element.parentNode === stage) {
    stage.removeChild(flake.element);
  }
}

function ensurePopulation(timestamp) {
  while (state.activeFlakes.length < MIN_ACTIVE) {
    const created = spawnFlake({ force: true, initialOffset: randomRange(20, 120, state.seededRandom) });
    if (!created) {
      break;
    }
  }
  if (
    state.activeFlakes.length < MAX_ACTIVE &&
    timestamp >= state.nextSpawn &&
    spawnFlake({ initialOffset: 0 })
  ) {
    state.nextSpawn = timestamp + randomRange(520, 980, state.seededRandom);
  }
}

function animationLoop(timestamp) {
  if (!stage) {
    return;
  }
  if (!state.lastTime) {
    state.lastTime = timestamp;
    state.nextSpawn = timestamp + randomRange(400, 840, state.seededRandom);
  }
  const dt = Math.min((timestamp - state.lastTime) / 1000, 0.035);
  state.lastTime = timestamp;

  const boundsHeight = stage.getBoundingClientRect().height;

  for (let i = state.activeFlakes.length - 1; i >= 0; i -= 1) {
    const flake = state.activeFlakes[i];
    flake.update(state.reducedMotion ? dt * 0.35 : dt, boundsHeight);
    if (flake.isOutOfView(boundsHeight)) {
      recycleFlake(flake);
      state.activeFlakes.splice(i, 1);
    }
  }

  ensurePopulation(timestamp);
  requestAnimationFrame(animationLoop);
}

async function init() {
  if (hasInitialized || initInProgress) {
    return;
  }
  stage = document.getElementById("snow-stage");
  if (!stage) {
    console.warn("Не удалось инициализировать снегопад: элемент со сценой не найден.");
    return;
  }
  initInProgress = true;
  try {
    state.activeFlakes.length = 0;
    state.areaUsage = Object.create(null);
    state.lastTime = null;
    state.nextSpawn = 0;
    if (stage) {
      stage.innerHTML = "";
    }
    recalcAreas();
    state.images = await preloadImages();
    if (state.images.length < MIN_ACTIVE) {
      throw new Error(
        `Для стабильного потока требуется минимум ${MIN_ACTIVE} уникальных иконок. Найдено: ${state.images.length}.`
      );
    }
    const initialCount = Math.min(MAX_ACTIVE, Math.max(MIN_ACTIVE, state.images.length));
    for (let i = 0; i < initialCount; i += 1) {
      spawnFlake({
        force: true,
        initialOffset: randomRange(i * 40, i * 60 + 80, state.seededRandom),
      });
    }
    requestAnimationFrame(animationLoop);
    hasInitialized = true;
  } catch (error) {
    if (stage) {
      stage.innerHTML = `<div style="padding: 24px; font-size: 16px; line-height: 1.5; color: #374151;">${error.message}</div>`;
    }
    console.error(error);
  } finally {
    initInProgress = false;
  }
}

window.addEventListener("resize", () => {
  recalcAreas();
});

function bootstrapSnowfall() {
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        init();
      },
      { once: true }
    );
  } else {
    init();
  }
}

bootstrapSnowfall();

