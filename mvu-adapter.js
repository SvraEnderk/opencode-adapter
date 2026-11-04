import { resolveOpenCodeUrl } from './endpoints.js';
import { createStatusFetch } from './status-adapter.js';

// MVU normalizes a bare website URL to /v1 before dispatching to TavernHelper.
export function resolveMvuRoute(value) {
    const route = resolveOpenCodeUrl(value);
    if (route) return route;
    try {
        const url = new URL(value);
        if (url.pathname.replace(/\/+$/, '') !== '/v1') return null;
        url.pathname = '/';
        return resolveOpenCodeUrl(url.href);
    } catch { return null; }
}

export function isOfficialMvuFrame(id, srcdoc) {
    if (!String(id).startsWith('TH-script--')) return false;
    return /https:\/\/(?:[a-z0-9-]+\.)?jsdelivr\.net\/gh\/MagicalAstrogy\/MagVarUpdate(?:@[^\s'"<>/]+)?\/artifact\/bundle\.js(?:[?'"\s;]|$)/i.test(String(srcdoc));
}

function withExplicitAuth(headers, key) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) headers = {};
    const auth = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    return {
        ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')),
        // An explicit empty value also prevents using the host's unrelated saved key.
        Authorization: typeof key === 'string' && key.trim() ? `Bearer ${key.trim()}` : (auth ?? ''),
    };
}

/** This wrapper is installed in the official MVU iframe only, never globally. */
export function createMvuStatusFetch(fetchImpl, { origin, enabled = () => true, parseYaml, onResult = () => {}, retryDelayMs = 500 }) {
    const statusFetch = createStatusFetch(fetchImpl, { origin, enabled, onResult, retryDelayMs });
    return async function mvuStatusFetch(input, init) {
        if (!enabled()) return fetchImpl(input, init);
        const isRequest = input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.url === 'string';
        let request;
        let body;
        try {
            const url = new URL(isRequest ? input.url : String(input), origin);
            if (url.origin !== origin || url.pathname !== '/api/backends/chat-completions/status') return fetchImpl(input, init);
            request = new Request(isRequest ? input.clone() : url.href, init);
            if (request.method !== 'POST') return fetchImpl(input, init);
            body = await request.clone().json();
        } catch { return fetchImpl(input, init); }
        const source = body?.chat_completion_source;
        const route = source === 'openai' ? resolveMvuRoute(body.reverse_proxy)
            : source === 'custom' ? resolveMvuRoute(body.custom_url) : null;
        if (!route) return fetchImpl(input, init);
        const headers = body.custom_include_headers?.trim() ? parseYaml(body.custom_include_headers) : {};
        const patched = { ...body, chat_completion_source: 'custom', custom_url: route.chatBase,
            custom_include_headers: JSON.stringify(withExplicitAuth(headers, source === 'openai' ? body.proxy_password : undefined)) };
        delete patched.reverse_proxy;
        delete patched.proxy_password;
        // secret_id for an OpenAI key must not become a custom-source secret selection.
        if (source === 'openai') delete patched.secret_id;
        return statusFetch(new Request(request, { body: JSON.stringify(patched) }));
    };
}

/** Preserve the caller's model, prompts, sampling, tools, and explicit credentials. */
export function normalizeMvuGeneration(config, sessionId) {
    const api = config?.custom_api;
    const route = resolveMvuRoute(api?.apiurl);
    if (!route) return config;
    const headers = withExplicitAuth(api.custom_include_headers, api.key);
    if (!headers.Authorization) throw new Error('MVU 独立 OpenCode API 未填写密钥，请在 MVU 中填写密钥或选择“与插头相同”。');
    if (route.plan === 'go' && sessionId) {
        for (const name of Object.keys(headers)) if (name.toLowerCase() === 'x-opencode-session') delete headers[name];
        headers['x-opencode-session'] = sessionId;
    }
    return { ...config, custom_api: { ...api, source: 'custom', apiurl: route.chatBase, custom_include_headers: headers } };
}
