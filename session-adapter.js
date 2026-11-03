import { resolveOpenCodeUrl } from './endpoints.js';
import { REQUEST_SESSION_KEY, validSessionId } from './session-manager.js';

// ST 1.18's connection test uses the native event too, with this fixed payload.
// A normal user saying Hi is not a probe; other quiet/summary prompts stay in-chat.
export function isConnectionProbe(data) {
    return data?.type === 'quiet' && Array.isArray(data.messages) && data.messages.length === 1
        && data.messages[0]?.role === 'user' && data.messages[0]?.content === 'Hi';
}

/** JSON is a YAML subset accepted by ST. Preserve all unrelated header values. */
export function withSessionHeader(source, sessionId, parseYaml) {
    const headers = typeof source === 'string' && source.trim() ? parseYaml(source) : {};
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new Error('OpenCode 额外请求头需要是 YAML 键值表，请检查自定义请求头。');
    }
    return JSON.stringify({
        ...Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'x-opencode-session')),
        'x-opencode-session': sessionId,
    });
}

/** Final request boundary also covers extensions using ChatCompletionService directly. */
export function createSessionFetch(fetchImpl, {
    origin, enabled = () => true, temporary, parseYaml, onSent = () => {}, onError = () => {},
}) {
    return async function openCodeSessionFetch(input, init) {
        let url;
        try { url = new URL(input instanceof Request ? input.url : String(input), origin); }
        catch { return fetchImpl(input, init); }
        if (url.origin !== origin || url.pathname !== '/api/backends/chat-completions/generate') {
            return fetchImpl(input, init);
        }
        let request;
        let body;
        try {
            request = new Request(input instanceof Request ? input.clone() : url.href, init);
            if (request.method !== 'POST') return fetchImpl(input, init);
            body = await request.clone().json();
        } catch { return fetchImpl(input, init); }
        const route = body?.chat_completion_source === 'custom' ? resolveOpenCodeUrl(body.custom_url) : null;
        if (route?.plan !== 'go') return fetchImpl(input, init);
        const prepared = body[REQUEST_SESSION_KEY];
        delete body[REQUEST_SESSION_KEY]; // Internal event-to-fetch marker never reaches ST's backend.
        if (!enabled()) {
            if (prepared === undefined) return fetchImpl(input, init);
            return fetchImpl(new Request(request, { body: JSON.stringify(body) }));
        }
        if (request.signal.aborted) throw request.signal.reason;
        const preparedId = validSessionId(prepared?.id) ? prepared.id : null;
        const persistent = !!preparedId && prepared.persistent === true;
        const id = preparedId ?? temporary();
        try {
            body.custom_include_headers = withSessionHeader(body.custom_include_headers, id, parseYaml);
        } catch (error) {
            onError('OpenCode 会话请求头处理失败，请检查“额外请求头”的 YAML 格式。');
            throw error;
        }
        const patched = new Request(request, { body: JSON.stringify(body) });
        // One call only: retries of billable generations are deliberately left to the user.
        const result = await fetchImpl(patched);
        onSent({ id, persistent, ok: result.ok });
        return result; // Do not read, buffer or rewrite SSE/streaming response bodies.
    };
}
