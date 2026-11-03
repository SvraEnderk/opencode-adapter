import { resolveOpenCodeUrl, textModels } from './endpoints.js';

/**
 * Narrow compatibility shim for ST 1.18's private getStatusOpen().
 * Reuses ST's authenticated, CSRF-protected server endpoint and its key store.
 * Does not intercept generation, direct upstream calls, other providers or origins.
 */
export function createStatusFetch(fetchImpl, { origin, enabled = () => true, onResult = () => {}, retryDelayMs = 500 }) {
    return async function openCodeStatusFetch(input, init) {
        if (!enabled()) return fetchImpl(input, init);
        let local;
        try {
            const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
            local = new URL(raw, origin);
        } catch { return fetchImpl(input, init); }
        if (local.origin !== origin || local.pathname !== '/api/backends/chat-completions/status') {
            return fetchImpl(input, init);
        }
        let request;
        let body;
        try {
            request = new Request(input instanceof Request ? input.clone() : local.href, init);
            if (request.method !== 'POST') return fetchImpl(input, init);
            body = await request.clone().json();
        } catch { return fetchImpl(input, init); }
        const route = body.chat_completion_source === 'custom' ? resolveOpenCodeUrl(body.custom_url) : null;
        if (!route) return fetchImpl(input, init);

        // ST appends /models itself. Only this probe receives modelsBase.
        const patched = new Request(request, {
            body: JSON.stringify({ ...body, custom_url: route.modelsBase }),
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (request.signal.aborted) throw request.signal.reason;
            const response = await fetchImpl(patched.clone());
            const payload = await response.clone().json();
            if (!response.ok || payload.error) {
                if (attempt === 0) {
                    await retryPause(retryDelayMs, request.signal);
                    continue;
                }
                onResult({ ok: false, route, message: '模型目录读取失败（已重试一次）。请检查网络后点击“刷新模型列表”。' });
                return response;
            }
            const models = textModels(payload);
            if (!models.length) throw new Error('目录中没有可供聊天使用的模型');
            onResult({ ok: true, route, models });
            const headers = new Headers(response.headers);
            // Re-encoding changes content length/encoding; keep only valid response headers.
            headers.delete('content-length');
            headers.delete('content-encoding');
            return new Response(JSON.stringify({ ...payload, data: models }), {
                status: response.status, statusText: response.statusText, headers,
            });
          } catch (error) {
            if (request.signal.aborted || error?.name === 'AbortError') throw error;
            if (attempt === 0) {
                await retryPause(retryDelayMs, request.signal);
                continue;
            }
            onResult({ ok: false, route, message: '无法读取模型目录（已重试一次），请稍后再试。' });
            throw error;
          }
        }
    };
}

function retryPause(ms, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}
