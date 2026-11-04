import { eventSource, event_types, saveSettingsDebounced } from '/script.js';
import { oai_settings } from '/scripts/openai.js';
import { extension_settings } from '/scripts/extensions.js';
import { resolveOpenCodeUrl } from './endpoints.js';
import { createStatusFetch } from './status-adapter.js';
import { getContext } from '/scripts/st-context.js';
import { yaml } from '/lib.js';
import { createSessionManager, REQUEST_SESSION_KEY } from './session-manager.js';
import { createSessionFetch, isConnectionProbe } from './session-adapter.js';
import { installMvuBridge } from './mvu-bridge.js';

const EXTENSION_ID = 'opencode-adapter';
let initialized = false;
let timer;
let normalizing = false;
let currentResult = null;
const sessions = createSessionManager();
const mvuSessions = createSessionManager({ key: 'opencode_adapter_mvu_session' });
const mvuSessionIds = new Map();

function sessionsEnabled() {
    return active() && extension_settings.opencode_adapter?.manageSessions !== false;
}

function showSession() {
    const target = document.getElementById('oc-adapter-session-info');
    if (!target) return;
    const route = currentRoute();
    const record = sessions.current(getContext());
    target.textContent = route?.plan !== 'go' ? '会话管理仅用于 Go 连接。'
        : !sessionsEnabled() ? '自动会话已关闭，使用预设中的请求头。'
            : record ? `本聊天会话：${record.id}` : '首次生成时建立本聊天会话；独立测试使用临时会话。';
}

async function prepareSession(data) {
    if (!sessionsEnabled() || data?.chat_completion_source !== 'custom'
        || resolveOpenCodeUrl(data.custom_url)?.plan !== 'go' || isConnectionProbe(data)) return;
    const context = getContext();
    // MVU's scoped wrapper has already selected an independent session and key.
    const headers = data.custom_include_headers?.trim() ? yaml.parse(data.custom_include_headers) : {};
    const requestedId = headers && typeof headers === 'object'
        ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-opencode-session')?.[1] : null;
    if (mvuSessionIds.has(requestedId)) {
        data[REQUEST_SESSION_KEY] = mvuSessionIds.get(requestedId);
        return;
    }
    const session = sessions.prepare(context);
    data[REQUEST_SESSION_KEY] = { id: session.id, persistent: session.persistent };
    if (session.changed) await context.saveMetadata();
    showSession();
}

function active() {
    return !(extension_settings.disabledExtensions ?? []).some(name =>
        name === EXTENSION_ID || name === `third-party/${EXTENSION_ID}`);
}

function currentRoute() {
    if (!active() || oai_settings.chat_completion_source !== 'custom') return null;
    return resolveOpenCodeUrl(oai_settings.custom_url);
}

function announce(text, state = 'info') {
    const element = document.getElementById('oc-adapter-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.state = state;
}

function showSelectedModel() {
    const target = document.getElementById('oc-adapter-model-info');
    if (!target) return;
    const route = currentRoute();
    const model = route && currentResult?.route.chatBase === route.chatBase
        ? currentResult.models.find(entry => entry.id === oai_settings.custom_model) : null;
    if (!model) { target.textContent = ''; return; }
    const details = [model.name || model.id];
    if (model.limit?.context) details.push(`上下文 ${model.limit.context.toLocaleString()} Token`);
    if (model.limit?.output) details.push(`模型输出上限 ${model.limit.output.toLocaleString()} Token`);
    target.textContent = details.join(' · ');
}

function render() {
    const box = document.getElementById('oc-adapter-panel');
    if (!box) return;
    const route = currentRoute();
    box.hidden = !route;
    if (!route) return;
    document.getElementById('oc-adapter-plan').value = route.plan;
    document.getElementById('oc-adapter-refresh').disabled = false;
    if (currentResult?.route.chatBase === route.chatBase) {
        announce(`已读取 ${currentResult.models.length} 个${route.plan === 'go' ? ' Go ' : '按量'}聊天模型，请在下方“可用模型”选择。`, 'success');
    } else {
        announce(`已识别 OpenCode ${route.plan === 'go' ? 'Go 订阅' : '按量付费'}，准备读取模型列表。`);
    }
    showSelectedModel();
    showSession();
}

function normalize() {
    const route = currentRoute();
    if (!route) return null;
    if (oai_settings.custom_url !== route.chatBase) {
        oai_settings.custom_url = route.chatBase;
        // Native input handler persists this setting; never touch API keys or RP prompts.
        normalizing = true;
        try { $('#custom_api_url_text').val(route.chatBase).trigger('input'); }
        finally { normalizing = false; }
        saveSettingsDebounced();
    }
    return route;
}

function loadModels() {
    clearTimeout(timer);
    const route = normalize();
    render();
    if (!route) return;
    announce('正在读取 OpenCode 模型目录……');
    document.getElementById('oc-adapter-refresh').disabled = true;
    // ST owns loading state, request cancellation, its key selection, and model_list.
    $('#api_button_openai').trigger('click');
}

function scheduleLoad() {
    if (normalizing) return;
    clearTimeout(timer);
    render();
    if (currentRoute()) timer = setTimeout(loadModels, 850);
}

export function init() {
    if (initialized) return;
    if (!document.getElementById('custom_api_url_text')) return;
    initialized = true;
    const box = document.createElement('section');
    box.id = 'oc-adapter-panel';
    box.hidden = true;
    box.innerHTML = `
        <div class="oc-adapter-title">OpenCode 连接助手 <small>0.3.0</small></div>
        <div class="oc-adapter-controls">
            <label for="oc-adapter-plan">使用方式</label>
            <select id="oc-adapter-plan" aria-label="OpenCode 使用方式">
                <option value="go">Go 订阅</option>
                <option value="payg">按量付费</option>
            </select>
            <button type="button" id="oc-adapter-refresh" class="menu_button">刷新模型列表</button>
        </div>
        <div id="oc-adapter-status" role="status" aria-live="polite"></div>
        <div id="oc-adapter-model-info"></div>
        <label><input type="checkbox" id="oc-adapter-manage-sessions">按聊天管理 Go 会话 ID</label>
        <div id="oc-adapter-session-info" role="status"></div>
        <label><input type="checkbox" id="oc-adapter-mvu-enabled">适配 MVU 独立 API</label>
        <div id="oc-adapter-mvu-info" role="status">等待 MVU 框架载入。</div>
        <small>同一聊天复用会话，分支和新聊天使用新会话；临时聊天在本页复用，独立扩展请求每次建立临时会话。自动会话开启时覆盖本次生成的 x-opencode-session，不改写预设。</small>
        <small>列表来自官方公开目录，不代表密钥或订阅已验证；生成仍使用酒馆保存的 API 密钥。仅填写域名时默认 Go。</small>`;
    document.getElementById('custom_api_url_text').insertAdjacentElement('afterend', box);

    const upstreamFetch = window.fetch.bind(window);
    const statusFetch = createStatusFetch(upstreamFetch, {
        origin: window.location.origin,
        enabled: active,
        onResult(result) {
            const route = currentRoute();
            if (!route || route.chatBase !== result.route.chatBase) return;
            document.getElementById('oc-adapter-refresh').disabled = false;
            if (!result.ok) { announce(result.message, 'error'); return; }
            currentResult = result;
            render();
        },
    });
    window.fetch = createSessionFetch(statusFetch, {
        origin: window.location.origin,
        enabled: sessionsEnabled,
        temporary: sessions.temporary,
        parseYaml: value => yaml.parse(value),
        onSent({ id, persistent, ok }) {
            const target = document.getElementById('oc-adapter-session-info');
            if (target && currentRoute()?.plan === 'go') {
                target.textContent = `最近请求：${mvuSessionIds.has(id) ? 'MVU 会话' : persistent ? '聊天会话' : '临时会话'} ${id}${ok ? '' : '（请求失败）'}`;
            }
        },
        onError: message => { toastr.error(message, 'OpenCode 连接助手'); },
    });
    document.getElementById('oc-adapter-manage-sessions').checked = sessionsEnabled();
    const mvuEnabled = () => active() && extension_settings.opencode_adapter?.enableMvu !== false;
    document.getElementById('oc-adapter-mvu-enabled').checked = mvuEnabled();
    $('#oc-adapter-mvu-enabled').on('change.opencodeAdapter', function () {
        extension_settings.opencode_adapter ??= {};
        extension_settings.opencode_adapter.enableMvu = this.checked;
        saveSettingsDebounced();
        document.getElementById('oc-adapter-mvu-info').textContent = this.checked ? 'MVU 适配已开启。' : 'MVU 适配已关闭。';
    });
    installMvuBridge({
        enabled: mvuEnabled,
        parseYaml: value => yaml.parse(value),
        async getSession() {
            if (!sessionsEnabled()) return null;
            const context = getContext();
            const session = mvuSessions.prepare(context);
            const marker = { id: session.id, persistent: session.persistent };
            mvuSessionIds.set(session.id, marker);
            if (session.changed) await context.saveMetadata();
            return marker;
        },
        onAttached() { document.getElementById('oc-adapter-mvu-info').textContent = 'MVU 独立 API 适配已就绪；请在 MVU 中获取模型列表。'; },
        onResult(result) {
            document.getElementById('oc-adapter-mvu-info').textContent = result.ok
                ? `MVU 已取得 ${result.models.length} 个 OpenCode 聊天模型。`
                : result.message;
        },
    });
    $('#oc-adapter-manage-sessions').on('change.opencodeAdapter', function () {
        extension_settings.opencode_adapter ??= {};
        extension_settings.opencode_adapter.manageSessions = this.checked;
        saveSettingsDebounced();
        showSession();
    });
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, prepareSession);
    eventSource.on(event_types.CHAT_CHANGED, showSession);
    eventSource.on(event_types.CHAT_RENAMED, async event => {
        if (!active()) return;
        const context = getContext();
        const renamed = sessions.renamed(context, event);
        const mvuRenamed = mvuSessions.renamed(context, event);
        if (renamed || mvuRenamed) await context.saveMetadata();
        showSession();
    });

    $('#custom_api_url_text').on('input.opencodeAdapter', scheduleLoad);
    $('#chat_completion_source').on('change.opencodeAdapter', scheduleLoad);
    $('#custom_model_id').on('input.opencodeAdapter', showSelectedModel);
    $('#model_custom_select').on('change.opencodeAdapter', showSelectedModel);
    $('#oc-adapter-refresh').on('click.opencodeAdapter', loadModels);
    $('#oc-adapter-plan').on('change.opencodeAdapter', function () {
        const route = resolveOpenCodeUrl('https://opencode.ai', this.value);
        $('#custom_api_url_text').val(route.chatBase).trigger('input');
    });
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, scheduleLoad);
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, scheduleLoad);
    eventSource.on(event_types.MAIN_API_CHANGED, scheduleLoad);
    scheduleLoad();
}

// 1.18 calls the activate hook. Older extension loaders use document-ready.
$(init);
