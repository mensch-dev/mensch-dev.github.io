const PROFILE = Object.freeze({
    brand: "Mensch",
    username: "richmensch",
    userId: 295052682,
    sinceYear: 2018
});

const API_HOSTS = Object.freeze({
    users: ["https://users.roproxy.com"],
    groups: ["https://groups.roproxy.com"],
    games: ["https://games.roproxy.com"]
});

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
    setStatus("Loading live Roblox stats...");

    try {
        const [userGames, ownedGroups] = await Promise.all([
            getUserGames(PROFILE.userId),
            getOwnedGroups(PROFILE.userId)
        ]);

        const groupGamesSets = await Promise.all(
            ownedGroups.map((group) => getGroupGames(group.id))
        );

        const allUniverseIds = collectUniverseIds(userGames, groupGamesSets.flat());
        const universeStats = await getUniverseStats(allUniverseIds);

        const totals = {
            visits: sumBy(universeStats, "visits"),
            groupMembers: sumBy(ownedGroups, "memberCount"),
            playing: sumBy(universeStats, "playing")
        };

        animateStat(TOTAL_VISITS_ID, totals.visits);
        animateStat(TOTAL_MEMBERS_ID, totals.groupMembers);
        animateStat(TOTAL_PLAYING_ID, totals.playing);

        renderOwnedGroups(ownedGroups);

        const gameText = allUniverseIds.length === 1 ? "game universe" : "game universes";
        setStatus(`Live data loaded from ${allUniverseIds.length} ${gameText}.`);
        updatedAt.textContent = new Date().toLocaleString();
    } catch (error) {
        console.error("Failed to load portfolio stats:", error);
        setStatus("Unable to load live stats right now. Please try Refresh Live Stats.");
        setStatText(TOTAL_VISITS_ID, "-");
        setStatText(TOTAL_MEMBERS_ID, "-");
        setStatText(TOTAL_PLAYING_ID, "-");
        groupsGrid.innerHTML = "<p class='empty-groups'>Owned groups could not be loaded right now.</p>";
        updatedAt.textContent = "-";
    } finally {
        setLoadingState(false);
    }
}

async function getOwnedGroups(userId) {
    const payload = await fetchJson("groups", `/v2/users/${userId}/groups/roles`);
    const roles = Array.isArray(payload.data) ? payload.data : [];
    const owned = roles
        .filter((entry) => isOwnedGroup(entry))
        .map((entry) => ({
            id: entry.group.id,
            name: entry.group.name,
            memberCount: Number(entry.group.memberCount ?? 0),
            roleName: entry.role?.name ?? "Owner"
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

function collectUniverseIds(userGames, groupGames) {
    const set = new Set();

    for (const game of userGames) {
        if (typeof game.id === "number") {
            set.add(game.id);
        }
    }

    for (const game of groupGames) {
        if (typeof game.id === "number") {
            set.add(game.id);
        }
    }

    return Array.from(set);
}

async function getUniverseStats(universeIds) {
    if (universeIds.length === 0) {
        return [];
    }

    const stats = [];
    const chunks = chunkArray(universeIds, 30);

    for (const chunk of chunks) {
        const response = await fetchJson("games", `/v1/games?universeIds=${chunk.join(",")}`);
        if (Array.isArray(response.data)) {
            stats.push(...response.data);
        }
    }

    return stats;
}

function chunkArray(values, chunkSize) {
    const chunks = [];
    for (let i = 0; i < values.length; i += chunkSize) {
        chunks.push(values.slice(i, i + chunkSize));
    }
    return chunks;
}

async function fetchJson(service, path) {
    const hosts = API_HOSTS[service];
    if (!hosts) {
        throw new Error(`Unknown API service: ${service}`);
    }

    let lastError = null;

    for (const host of hosts) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const response = await fetch(`${host}${path}`, {
                    method: "GET",
                    headers: { Accept: "application/json" }
                });

                if (!response.ok) {
                    throw new Error(`${response.status} ${response.statusText}`);
                }

                return await response.json();
            } catch (error) {
                lastError = error;
                await delay(225 * attempt);
            }
        }
    }

    throw lastError ?? new Error(`Request failed for ${service}${path}`);
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

function setLoadingState(isLoading) {
    refreshButton.disabled = isLoading;

    const statIds = [TOTAL_VISITS_ID, TOTAL_MEMBERS_ID, TOTAL_PLAYING_ID];
    for (const statId of statIds) {
        const el = document.getElementById(statId);
        if (!el) {
            continue;
        }
        if (isLoading) {
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
