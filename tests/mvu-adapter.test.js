import test from 'node:test';
import assert from 'node:assert/strict';
import { createMvuStatusFetch, normalizeMvuGeneration, isOfficialMvuFrame, resolveMvuRoute } from '../mvu-adapter.js';
import { createSessionManager, SESSION_KEY } from '../session-manager.js';

const origin = 'http://127.0.0.1:8000';
const path = '/api/backends/chat-completions/status';
const payload = { chat_completion_source: 'openai', reverse_proxy: 'https://opencode.ai/v1', proxy_password: 'mvu-key', secret_id: 'unrelated-openai-key' };
const opts = (data = payload, extra = {}) => ({ method: 'POST', body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }, credentials: 'include', ...extra });
const catalogue = () => new Response(JSON.stringify({ data: [{ id: 'gemini-4-argon', type: 'chat' }, { id: 'image', type: 'image' }] }));
const id = 'oc-st-11111111-1111-4111-8111-111111111111';

test('MVU normalized /v1 is Go, explicit payg stays payg, lookalikes and URL credentials are rejected', () => {
    assert.equal(resolveMvuRoute('https://opencode.ai/v1').plan, 'go');
    assert.equal(resolveMvuRoute('https://opencode.ai/inference/openai/v1').plan, 'payg');
    for (const url of ['https://opencode.ai.evil.test/v1', 'http://opencode.ai/v1', 'https://user:pass@opencode.ai/v1', 'https://opencode.ai/v1?key=x']) {
        assert.equal(resolveMvuRoute(url), null);
    }
});

test('recognize actual official MVU bundle frame, exclude other scripts and chat render frames', () => {
    const src = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';";
    assert.equal(isOfficialMvuFrame('TH-script--MVU--uuid', src), true);
    assert.equal(isOfficialMvuFrame('TH-message--0', src), false);
    assert.equal(isOfficialMvuFrame('TH-script--other', src.replace('MagicalAstrogy', 'other-author')), false);
    assert.equal(isOfficialMvuFrame('TH-script--MVU', src.replace('jsdelivr.net', 'jsdelivr.net.evil.test')), false);
});

test('MVU openai reverse_proxy catalogue routes correctly, carries its own key and filters chat models', async () => {
    let request;
    const controller = new AbortController();
    const adapter = createMvuStatusFetch(async r => { request = r; return catalogue(); }, { origin, parseYaml: JSON.parse });
    const original = new Request(origin + path, opts(payload, { signal: controller.signal }));
    const response = await adapter(original);
    const body = await request.json();
    assert.equal(body.custom_url, 'https://opencode.ai/inference/go/v1');
    assert.equal(body.chat_completion_source, 'custom');
    assert.deepEqual(JSON.parse(body.custom_include_headers), { Authorization: 'Bearer mvu-key' });
    assert.equal(body.proxy_password, undefined);
    assert.equal(body.reverse_proxy, undefined);
    assert.equal(body.secret_id, undefined);
    assert.equal(request.headers.get('X-CSRF-Token'), 'test');
    assert.equal(request.credentials, 'include');
    assert.deepEqual(await original.json(), payload);
    assert.deepEqual((await response.json()).data.map(x => x.id), ['gemini-4-argon']);
    controller.abort();
    assert.equal(request.signal.aborted, true);
});

test('custom discovery preserves explicit auth; empty OpenAI key does not inherit another host key', async () => {
    const bodies = [];
    const adapter = createMvuStatusFetch(async r => { bodies.push(await r.json()); return catalogue(); }, { origin, parseYaml: JSON.parse });
    await adapter(path, opts({ ...payload, proxy_password: '' }));
    assert.equal(JSON.parse(bodies[0].custom_include_headers).Authorization, '');
    await adapter(path, opts({ chat_completion_source: 'custom', custom_url: 'https://opencode.ai/inference/openai/v1',
        custom_include_headers: JSON.stringify({ authorization: 'Bearer other-mvu-key', another: 'keep' }) }));
    assert.equal(bodies[1].custom_url, 'https://opencode.ai/inference/v1');
    assert.deepEqual(JSON.parse(bodies[1].custom_include_headers), { Authorization: 'Bearer other-mvu-key', another: 'keep' });
});

test('other providers, origins, routes, methods and disabled MVU adaptation pass through unchanged', async () => {
    const calls = [];
    const fetch = async (...args) => { calls.push(args); return catalogue(); };
    const adapter = createMvuStatusFetch(fetch, { origin, parseYaml: JSON.parse });
    for (const args of [[path, opts({ ...payload, reverse_proxy: 'https://other.test/v1' })],
        [origin + '/other', opts()], ['https://another.test' + path, opts()], [path, { method: 'GET' }],
        [path, { method: 'POST', body: 'not JSON' }]]) {
        await adapter(...args);
        assert.equal(calls.at(-1)[0], args[0]); assert.equal(calls.at(-1)[1], args[1]);
    }
    const disabled = createMvuStatusFetch(fetch, { origin, enabled: () => false, parseYaml: JSON.parse });
    const options = opts(); await disabled(path, options); assert.equal(calls.at(-1)[1], options);
});

test('generation preserves model/prompts/tools/body/parameters, isolates key and does not mutate config', () => {
    const config = { generation_id: 'mvu-task', ordered_prompts: [{ role: 'system', content: 'Update variables' }],
        tools: [{ type: 'function', function: { name: 'update_variables' } }],
        custom_api: { apiurl: 'https://opencode.ai/v1', key: 'explicit-mvu-key', model: 'gemini-4-argon',
            temperature: 0.7, max_tokens: 2048, custom_include_body: { response_format: { type: 'json_object' } },
            custom_include_headers: { another: 'keep', AUTHORIZATION: 'Bearer old-key', 'X-OpenCode-Session': 'old-session' } } };
    const snapshot = structuredClone(config);
    const normalized = normalizeMvuGeneration(config, id);
    assert.deepEqual(config, snapshot);
    assert.equal(normalized.custom_api.source, 'custom');
    assert.equal(normalized.custom_api.apiurl, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(normalized.custom_api.model, 'gemini-4-argon');
    assert.equal(normalized.custom_api.max_tokens, 2048);
    assert.equal(normalized.ordered_prompts, config.ordered_prompts);
    assert.equal(normalized.tools, config.tools);
    assert.equal(normalized.custom_api.custom_include_body, config.custom_api.custom_include_body);
    assert.deepEqual(normalized.custom_api.custom_include_headers, { another: 'keep', Authorization: 'Bearer explicit-mvu-key', 'x-opencode-session': id });
});

test('missing independent key fails before generation; same-as-main and other providers remain unchanged', () => {
    assert.throws(() => normalizeMvuGeneration({ custom_api: { apiurl: 'https://opencode.ai' } }, id), /未填写密钥/);
    for (const config of [{ ordered_prompts: [] }, { custom_api: { apiurl: 'https://other.test/v1', key: 'other' } }]) {
        assert.equal(normalizeMvuGeneration(config, id), config);
    }
    const payg = normalizeMvuGeneration({ custom_api: { apiurl: 'https://opencode.ai/inference/openai/v1', key: 'mvu-key' } }, id);
    assert.equal(payg.custom_api.apiurl, 'https://opencode.ai/inference/openai/v1');
    assert.equal(payg.custom_api.custom_include_headers['x-opencode-session'], undefined);
});

test('MVU session is stable and persisted separately from main, branches get another ID', () => {
    const main = createSessionManager();
    const mvu = createSessionManager({ key: 'opencode_adapter_mvu_session' });
    const context = { chatId: 'test-chat', characterId: 0, characters: [{ avatar: 'test.png' }], chatMetadata: {} };
    const mainId = main.prepare(context).id;
    const mvuId = mvu.prepare(context).id;
    assert.notEqual(mainId, mvuId);
    assert.equal(mvu.prepare(context).id, mvuId);
    assert.equal(context.chatMetadata[SESSION_KEY].id, mainId);
    const reloaded = structuredClone(context);
    assert.equal(createSessionManager({ key: 'opencode_adapter_mvu_session' }).prepare(reloaded).id, mvuId);
    reloaded.chatId = 'branch';
    assert.notEqual(mvu.prepare(reloaded).id, mvuId);
});
