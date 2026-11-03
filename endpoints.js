/** Resolve official OpenCode URLs without accepting look-alike hosts or relays. */
export function resolveOpenCodeUrl(value, rootPlan = 'go') {
    if (typeof value !== 'string' || !value.trim()) return null;
    let url;
    try { url = new URL(value.trim()); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'opencode.ai'
        || url.port || url.username || url.password || url.search || url.hash) return null;

    const path = url.pathname.replace(/\/+$/, '');
    let plan;
    if (!path) {
        plan = rootPlan === 'payg' ? 'payg' : 'go';
    } else if (/^\/(inference|zen)\/go(?:\/|$)/.test(path)) {
        plan = 'go';
    } else if (/^\/(inference|zen)(?:\/|$)/.test(path)) {
        plan = 'payg';
    } else {
        return null;
    }
    const prefix = `https://opencode.ai/inference${plan === 'go' ? '/go' : ''}`;
    return {
        plan,
        chatBase: `${prefix}/openai/v1`,
        modelsBase: `${prefix}/v1`,
        modelsUrl: `${prefix}/v1/models`,
    };
}

/** Keep the live catalogue's text chat models; never invent or rename model IDs. */
export function textModels(payload) {
    if (!Array.isArray(payload?.data)) throw new Error('模型目录没有返回 data 数组');
    const seen = new Set();
    return payload.data.filter(model => {
        if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) return false;
        if (model.type && model.type !== 'chat') return false;
        if (Array.isArray(model.modalities?.output) && !model.modalities.output.includes('text')) return false;
        seen.add(model.id);
        return true;
    });
}
