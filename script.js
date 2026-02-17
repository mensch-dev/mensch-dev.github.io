const PROFILE = Object.freeze({
    brand: "Mensch",
    username: "richmensch",
    userId: 295052682
});

const API_HOSTS = Object.freeze({
    groups: ["https://groups.roproxy.com", "https://groups.roblox.com"],
    games: ["https://games.roproxy.com", "https://games.roblox.com"]
});

const ROLIMONS_GAMELIST_URL = "https://api.rolimons.com/games/v1/gamelist";
const CACHE_KEY = "mensch_portfolio_snapshot_v2";
const ROLIMONS_CACHE_KEY = "mensch_rolimons_gamelist_v1";
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const CACHE_FAILOVER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

const TOTAL_VISITS_ID = "totalVisits";
const TOTAL_MEMBERS_ID = "totalMembers";
const TOTAL_PLAYING_ID = "totalPlaying";

const refreshButton = document.getElementById("refreshButton");
const statusLine = document.getElementById("statusLine");
const updatedAt = document.getElementById("updatedAt");
const groupsGrid = document.getElementById("groupsGrid");

const numberFormatter = new Intl.NumberFormat("en-US");

refreshButton.addEventListener("click", () => {
    loadPortfolioStats();
});

loadPortfolioStats();
enableBackgroundEffects();

async function loadPortfolioStats() {
    setLoadingState(true);
    const cachedSnapshot = readSnapshot(CACHE_KEY, CACHE_MAX_AGE_MS);

    if (cachedSnapshot) {
        renderSnapshot(cachedSnapshot, true);
        setStatus("Showing cached stats while refreshing...");
    } else {
        setStatus("Loading live Roblox stats...");
    }

    try {
        const [userGames, ownedGroups] = await Promise.all([
            getUserGames(PROFILE.userId),
            getOwnedGroups(PROFILE.userId)
        ]);

        const groupGamesSets = await mapWithConcurrency(ownedGroups, 2, async (group) => {
            return getGroupGamesSafe(group.id);
        });

        const allGames = collectGames(userGames, groupGamesSets.flat());
        const universeIds = allGames.map((game) => game.universeId);

        const rolimonsPlayersByPlace = await getRolimonsPlayersByPlaceSafe();
        const universePlayingById = rolimonsPlayersByPlace.size === 0
            ? await getUniversePlayingById(universeIds)
            : new Map();

        const totals = buildTotals(ownedGroups, allGames, rolimonsPlayersByPlace, universePlayingById);

        const snapshot = {
            totals,
            ownedGroups,
            universeCount: allGames.length,
            updatedAtMs: Date.now()
        };

        writeSnapshot(CACHE_KEY, snapshot);
        renderSnapshot(snapshot, false);
        if (rolimonsPlayersByPlace.size > 0) {
            setStatus(`Live data loaded from ${snapshot.universeCount} universes.`);
        } else {
            setStatus(`Live data loaded from ${snapshot.universeCount} universes (playing fallback mode).`);
        }
    } catch (error) {
        console.error("Failed to load portfolio stats:", error);

        const failoverSnapshot = readSnapshot(CACHE_KEY, CACHE_FAILOVER_MAX_AGE_MS);
        if (failoverSnapshot) {
            renderSnapshot(failoverSnapshot, true);
            setStatus("Live refresh failed. Showing last saved stats.");
        } else {
            setStatus("Unable to load live stats right now. Please try Refresh Live Stats.");
            setStatText(TOTAL_VISITS_ID, "-");
            setStatText(TOTAL_MEMBERS_ID, "-");
            setStatText(TOTAL_PLAYING_ID, "-");
            groupsGrid.innerHTML = "<p class='empty-groups'>Owned groups could not be loaded right now.</p>";
            updatedAt.textContent = "-";
        }
    } finally {
        setLoadingState(false);
    }
}

function renderSnapshot(snapshot, isCached) {
    if (!snapshot) {
        return;
    }

    animateStat(TOTAL_VISITS_ID, Number(snapshot.totals.visits ?? 0));
    animateStat(TOTAL_MEMBERS_ID, Number(snapshot.totals.groupMembers ?? 0));
    animateStat(TOTAL_PLAYING_ID, Number(snapshot.totals.playing ?? 0));

    renderOwnedGroups(Array.isArray(snapshot.ownedGroups) ? snapshot.ownedGroups : []);

    const date = new Date(Number(snapshot.updatedAtMs || Date.now()));
    updatedAt.textContent = isCached ? `${date.toLocaleString()} (cached)` : date.toLocaleString();
}

function buildTotals(ownedGroups, allGames, rolimonsPlayersByPlace, universePlayingById) {
    let visits = 0;
    let playing = 0;
    for (const game of allGames) {
        visits += Number(game.placeVisits ?? 0);

        const placeId = Number(game.rootPlaceId ?? 0);
        const rolimonsPlaying = placeId > 0 ? rolimonsPlayersByPlace.get(placeId) : undefined;
        const fallbackPlaying = Number(universePlayingById.get(game.universeId) ?? 0);
        playing += Number(rolimonsPlaying ?? fallbackPlaying);
    }

    return {
        visits,
        groupMembers: sumBy(ownedGroups, "memberCount"),
        playing
    };
}

async function getOwnedGroups(userId) {
    const payload = await fetchJson("groups", `/v2/users/${userId}/groups/roles`);
    const roles = Array.isArray(payload.data) ? payload.data : [];
    const owned = roles
        .filter((entry) => isOwnedGroup(entry))
        .map((entry) => ({
            id: Number(entry.group.id),
            name: entry.group.name,
            memberCount: Number(entry.group.memberCount ?? 0)
        }));

    const deduped = new Map();
    for (const group of owned) {
        deduped.set(group.id, group);
    }

    return Array.from(deduped.values()).sort((a, b) => b.memberCount - a.memberCount);
}

function isOwnedGroup(entry) {
    const rank = entry?.role?.rank;
    return typeof rank === "number" && rank >= 255;
}

async function getUserGames(userId) {
    return getPagedGames(`/v2/users/${userId}/games?accessFilter=Public&limit=50&sortOrder=Asc`);
}

async function getGroupGames(groupId) {
    return getPagedGames(`/v2/groups/${groupId}/games?accessFilter=Public&limit=50&sortOrder=Asc`);
}

async function getGroupGamesSafe(groupId) {
    try {
        return await getGroupGames(groupId);
    } catch (error) {
        console.warn(`Skipping group ${groupId} due to API error:`, error);
        return [];
    }
}

async function getPagedGames(path) {
    const games = [];
    let cursor = null;

    do {
        const pagePath = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
        const payload = await fetchJson("games", pagePath);
        const pageData = Array.isArray(payload.data) ? payload.data : [];
        games.push(...pageData);
        cursor = payload.nextPageCursor;
    } while (cursor);

    return games;
}

function collectGames(userGames, groupGames) {
    const map = new Map();

    for (const game of [...userGames, ...groupGames]) {
        const universeId = Number(game.id ?? 0);
        const rootPlaceId = Number(game.rootPlace?.id ?? 0);
        const placeVisits = Number(game.placeVisits ?? 0);
        if (universeId <= 0) {
            continue;
        }
        map.set(universeId, { universeId, rootPlaceId, placeVisits });
    }

    return Array.from(map.values());
}

async function getRolimonsPlayersByPlace() {
    const cached = readSnapshot(ROLIMONS_CACHE_KEY, CACHE_MAX_AGE_MS);
    if (cached && cached.playersByPlace) {
        return toNumberMap(cached.playersByPlace);
    }

    const payload = await fetchAbsoluteJson(ROLIMONS_GAMELIST_URL);
    const games = payload?.games ?? {};
    const playersByPlace = {};

    for (const [placeIdString, details] of Object.entries(games)) {
        const placeId = Number(placeIdString);
        if (!Array.isArray(details) || placeId <= 0) {
            continue;
        }
        playersByPlace[placeId] = Number(details[1] ?? 0);
    }

    writeSnapshot(ROLIMONS_CACHE_KEY, {
        playersByPlace,
        updatedAtMs: Date.now()
    });

    return toNumberMap(playersByPlace);
}

async function getRolimonsPlayersByPlaceSafe() {
    try {
        return await getRolimonsPlayersByPlace();
    } catch (error) {
        console.warn("Rolimons playing API unavailable, using Roblox playing fallback.", error);
        return new Map();
    }
}

async function getUniversePlayingById(universeIds) {
    if (universeIds.length === 0) {
        return new Map();
    }

    const playingById = new Map();
    const chunks = [];
    for (let index = 0; index < universeIds.length; index += 100) {
        chunks.push(universeIds.slice(index, index + 100));
    }

    const responses = await mapWithConcurrency(chunks, 1, async (chunk) => {
        return fetchJson("games", `/v1/games?universeIds=${chunk.join(",")}`);
    });

    for (const response of responses) {
        const items = Array.isArray(response.data) ? response.data : [];
        for (const item of items) {
            const universeId = Number(item.id ?? 0);
            if (universeId <= 0) {
                continue;
            }
            playingById.set(universeId, Number(item.playing ?? 0));
        }
    }

    return playingById;
}

function toNumberMap(objectValue) {
    const map = new Map();
    for (const [key, value] of Object.entries(objectValue || {})) {
        map.set(Number(key), Number(value));
    }
    return map;
}

async function mapWithConcurrency(items, concurrency, handler) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= items.length) {
                return;
            }
            results[currentIndex] = await handler(items[currentIndex], currentIndex);
        }
    }

    const workers = [];
    const count = Math.min(concurrency, items.length);
    for (let i = 0; i < count; i += 1) {
        workers.push(worker());
    }

    await Promise.all(workers);
    return results;
}

async function fetchJson(service, path) {
    const hosts = API_HOSTS[service];
    if (!hosts) {
        throw new Error(`Unknown API service: ${service}`);
    }

    let lastError = null;
    for (const host of hosts) {
        try {
            return await fetchAbsoluteJson(`${host}${path}`);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError ?? new Error(`Request failed for ${service}${path}`);
}

async function fetchAbsoluteJson(url) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        let timeout = null;
        try {
            const controller = new AbortController();
            timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const response = await fetch(url, {
                method: "GET",
                headers: { Accept: "application/json" },
                signal: controller.signal
            });

            if (!response.ok) {
                const retryAfterRaw = Number(response.headers.get("retry-after"));
                const err = new Error(`${response.status} ${response.statusText}`);
                err.status = response.status;
                err.retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1000 : null;
                throw err;
            }

            return await response.json();
        } catch (error) {
            lastError = error;
            const backoffMs = Number(error.retryAfterMs) > 0
                ? Number(error.retryAfterMs)
                : 300 * attempt * attempt;
            await delay(backoffMs);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    throw lastError ?? new Error(`Request failed for ${url}`);
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function sumBy(items, key) {
    return items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
}

function renderOwnedGroups(groups) {
    if (!groups.length) {
        groupsGrid.innerHTML = "<p class='empty-groups'>No owned groups were found.</p>";
        return;
    }

    groupsGrid.innerHTML = groups
        .map((group) => {
            return `
                <article class="group-card">
                    <p class="group-name">${escapeHtml(group.name)}</p>
                    <p class="group-meta">${numberFormatter.format(group.memberCount)} members</p>
                    <a class="group-link" href="https://www.roblox.com/communities/${group.id}" target="_blank" rel="noreferrer">Open Group</a>
                </article>
            `;
        })
        .join("");
}

function readSnapshot(key, maxAgeMs) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }

        const updatedAtMs = Number(parsed.updatedAtMs ?? 0);
        if (updatedAtMs <= 0) {
            return null;
        }

        if (Date.now() - updatedAtMs > maxAgeMs) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}

function writeSnapshot(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify(data));
    } catch {
        // Ignore storage errors in private mode or full quotas.
    }
}

function setLoadingState(isLoading) {
    refreshButton.disabled = isLoading;

    const statIds = [TOTAL_VISITS_ID, TOTAL_MEMBERS_ID, TOTAL_PLAYING_ID];
    for (const statId of statIds) {
        const el = document.getElementById(statId);
        if (!el) {
            continue;
        }
        if (isLoading && el.textContent.trim() === "") {
            el.classList.add("loading");
            el.textContent = "...";
        } else {
            el.classList.remove("loading");
        }
    }
}

function animateStat(elementId, target) {
    const el = document.getElementById(elementId);
    if (!el) {
        return;
    }

    el.classList.remove("loading");

    const durationMs = 900;
    const startTime = performance.now();

    function tick(now) {
        const progress = Math.min((now - startTime) / durationMs, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = Math.round(target * eased);
        el.textContent = numberFormatter.format(value);

        if (progress < 1) {
            requestAnimationFrame(tick);
        }
    }

    requestAnimationFrame(tick);
}

function setStatText(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) {
        el.classList.remove("loading");
        el.textContent = text;
    }
}

function setStatus(text) {
    statusLine.textContent = text;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function enableBackgroundEffects() {
    const root = document.body;

    window.addEventListener("pointermove", (event) => {
        const x = (event.clientX / window.innerWidth) * 100;
        const y = (event.clientY / window.innerHeight) * 100;
        root.style.setProperty("--spot-x", `${x.toFixed(2)}%`);
        root.style.setProperty("--spot-y", `${y.toFixed(2)}%`);
    });
}
