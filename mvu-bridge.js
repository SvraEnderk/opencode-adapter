import { createMvuStatusFetch, isOfficialMvuFrame, normalizeMvuGeneration, resolveMvuRoute } from './mvu-adapter.js';

/** Attach only to same-origin TavernHelper script frames loading the official MVU bundle. */
export function installMvuBridge({ enabled, getSession, parseYaml, onResult, onAttached }) {
    const watched = new WeakSet();
    const installed = new WeakMap();
    function attach(frame) {
        if (!isOfficialMvuFrame(frame.id, frame.getAttribute('srcdoc'))) return;
        let win;
        try { win = frame.contentWindow; if (!win || win.document.readyState === 'loading') return; }
        catch { return; }
        if (typeof win.generateRaw !== 'function') return;
        const previous = installed.get(frame);
        if (previous?.fetch === win.fetch && previous?.generateRaw === win.generateRaw) return;
        const nativeFetch = win.fetch.bind(win);
        const patchedFetch = createMvuStatusFetch(nativeFetch, { origin: location.origin, enabled, parseYaml, onResult });
        win.fetch = patchedFetch;
        const wrapped = {};
        for (const name of ['generateRaw', 'generate']) {
            const original = win[name];
            if (typeof original !== 'function') continue;
            wrapped[name] = async function (config, ...args) {
                if (!enabled() || !resolveMvuRoute(config?.custom_api?.apiurl)) return original.call(this, config, ...args);
                const route = resolveMvuRoute(config.custom_api.apiurl);
                // Validate credentials before creating/persisting a session.
                normalizeMvuGeneration(config);
                const session = route.plan === 'go' ? await getSession() : null;
                return original.call(this, normalizeMvuGeneration(config, session?.id), ...args);
            };
            win[name] = wrapped[name];
        }
        installed.set(frame, { fetch: patchedFetch, generateRaw: wrapped.generateRaw });
        onAttached?.();
    }
    function watch(frame) {
        if (!watched.has(frame)) { frame.addEventListener('load', () => attach(frame)); watched.add(frame); }
        attach(frame);
    }
    function inspect(node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IFRAME') watch(node);
        for (const frame of node.querySelectorAll('iframe[id^="TH-script--"]')) watch(frame);
    }
    inspect(document.documentElement);
    const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) inspect(node);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => observer.disconnect();
}
