const isExtension = Boolean(globalThis.chrome?.storage?.local && chrome.runtime?.id);
const canvas = isExtension ? document.createElement("img") : document.getElementById("myCanvas");
canvas.classList.add("mood-blocker-police");
canvas.alt = "";
canvas.hidden = true;

const sprites = Object.fromEntries(
    Object.entries({
        peek: "beek2.png",
        half: "half.png",
        ready: "jump.png",
        going: "cop2.png",
        pulling: "pulling2.png",
        tired: "tired2.png",
    }).map(([pose, file]) => [
        pose,
        isExtension ? chrome.runtime.getURL("animation/images/" + file) : "images/" + file,
    ])
);

let blockedSites = [];
let storageRead = 0;
let busy = false;

async function refreshBlockedSites() {
    const read = ++storageRead;
    try {
        const { activeMood, moods } = await chrome.storage.local.get(["activeMood", "moods"]);
        if (read !== storageRead) return;

        const sites = activeMood && moods?.[activeMood]?.blockedSites;
        blockedSites = Array.isArray(sites)
            ? sites.filter(site => typeof site === "string").map(site => site.trim().toLowerCase()).filter(Boolean)
            : [];
        if (!busy) canvas.hidden = true;
    } catch (error) {
        console.debug("[Mood Blocker] Could not load the animation blocklist.", error);
    }
}

if (isExtension) {
    document.documentElement.append(canvas);
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && (changes.activeMood || changes.moods)) {
            refreshBlockedSites();
        }
    });
    refreshBlockedSites();
}

function isBlockedLink(link) {
    if (!isExtension) return true;

    let destination;
    try {
        destination = new URL(link.href, document.baseURI);
    } catch {
        return false;
    }

    if (destination.protocol !== "http:" && destination.protocol !== "https:") return false;

    const hostname = destination.hostname.toLowerCase().replace(/\.+$/, "");
    return blockedSites.some(site => hostname === site || hostname.endsWith("." + site));
}

function showPose(pose) {
    canvas.src = sprites[pose];
    canvas.hidden = false;
}

document.addEventListener("pointermove", event => {
    if (busy) return;

    // Look near the pointer without scanning every link on the page.
    const link = document.elementFromPoint(event.clientX, event.clientY)?.closest("a[href]");
    if (!link || !isBlockedLink(link)) {
        canvas.hidden = true;
        return;
    }

    const rect = link.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const distance = Math.hypot(event.clientX - centerX, event.clientY - rect.top - rect.height / 2);
    canvas.style.left = Math.max(0, Math.min(centerX - 75, innerWidth - 150)) + "px";
    canvas.style.top = "auto";
    showPose(distance > 180 ? "peek" : distance > 70 ? "half" : "ready");
});

document.addEventListener("click", event => {
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.hasAttribute("href"));
    if (!link || !isBlockedLink(link)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;

    busy = true;
    playAnimation(link).catch(error => {
        console.debug("[Mood Blocker] Could not play the link animation.", error);
    });
}, true);

async function playAnimation(link) {
    const rect = link.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.left + rect.width / 2 - 25, innerWidth - 50));
    const y = Math.max(0, Math.min(rect.top + rect.height / 2 - 25, innerHeight - 50));
    const shift = Math.max(0, Math.min(300, innerWidth - 50 - x));

    canvas.classList.add("mood-blocker-police-jumping");
    canvas.style.left = x + "px";
    canvas.style.top = y + "px";
    showPose("going");

    let linkCopy;
    try {
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!reducedMotion) {
            await canvas.animate(
                [{ transform: "translateY(" + (innerHeight - 50 - y) + "px)" }, { transform: "translateY(0)" }],
                { duration: 600, easing: "ease-out" }
            ).finished;

            linkCopy = document.createElement("span");
            linkCopy.className = "mood-blocker-pulled-link";
            linkCopy.textContent = link.textContent.trim() || new URL(link.href, document.baseURI).hostname;
            linkCopy.setAttribute("aria-hidden", "true");
            linkCopy.style.left = rect.left + "px";
            linkCopy.style.top = rect.top + "px";
            document.documentElement.append(linkCopy);
            link.classList.add("mood-blocker-link-in-animation");
            showPose("pulling");

            const pull = [{ transform: "translateX(0)" }, { transform: "translateX(" + shift + "px)" }];
            await Promise.all([canvas, linkCopy].map(element =>
                element.animate(pull, { duration: 850, easing: "ease-out" }).finished
            ));
        }

        linkCopy?.remove();
        if (!isExtension) link.remove();
        canvas.style.left = (x + (reducedMotion ? 0 : shift)) + "px";
        showPose("tired");
        await new Promise(resolve => setTimeout(resolve, 1000));
    } finally {
        linkCopy?.remove();
        link.classList.remove("mood-blocker-link-in-animation");
        canvas.classList.remove("mood-blocker-police-jumping");
        canvas.hidden = true;
        busy = false;
    }
}
