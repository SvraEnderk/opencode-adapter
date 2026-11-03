import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusFetch } from '../status-adapter.js';

const origin = 'http://127.0.0.1:8000';
const statusPath = '/api/backends/chat-completions/status';
const body = { chat_completion_source: 'custom', custom_url: 'https://opencode.ai/inference/go/openai/v1', secret_id: 'opaque-id', custom_include_headers: 'x-opencode-session: st-test' };
const options = (extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test' }, body: JSON.stringify(body), ...extra });
const catalogue = () => new Response(JSON.stringify({ data: [{ id: 'gemini-4-argon', type: 'chat' }, { id: 'image-model', type: 'image' }] }), { headers: { 'Content-Type': 'application/json' } });

test('correct only the status probe, retain key ID, CSRF, credentials and cancellation', async () => {
    const controller = new AbortController();
    let captured;
    let result;
    const adapter = createStatusFetch(async request => { captured = request; return catalogue(); }, { origin, onResult: r => result = r });
    const response = await adapter(statusPath, options({ signal: controller.signal, credentials: 'include' }));
    const sent = await captured.json();
    assert.equal(captured.url, origin + statusPath);
    assert.equal(sent.custom_url, 'https://opencode.ai/inference/go/v1');
    assert.equal(sent.secret_id, 'opaque-id');
    assert.equal(sent.custom_include_headers, body.custom_include_headers);
    assert.equal(captured.headers.get('X-CSRF-Token'), 'csrf-test');
    assert.equal(captured.credentials, 'include');
    assert.equal((await response.json()).data.length, 1);
    assert.equal(result.models[0].id, 'gemini-4-argon');
    controller.abort();
    assert.equal(captured.signal.aborted, true);
});

test('supports Request inputs without consuming the original body', async () => {
    const original = new Request(origin + statusPath, options());
    let captured;
    const adapter = createStatusFetch(async request => { captured = request; return catalogue(); }, { origin });
    await adapter(original);
    assert.equal((await original.json()).custom_url, body.custom_url);
    assert.equal((await captured.json()).custom_url, 'https://opencode.ai/inference/go/v1');
});

test('unrelated providers, generation, cross-origin requests and disabled extension pass through unchanged', async () => {
    const calls = [];
    let enabled = true;
    const adapter = createStatusFetch(async (...args) => { calls.push(args); return catalogue(); }, { origin, enabled: () => enabled });
    const cases = [
        ['/api/backends/chat-completions/generate', options()],
        ['https://elsewhere.test' + statusPath, options()],
        [statusPath, options({ body: JSON.stringify({ ...body, custom_url: 'https://api.other.test/v1' }) })],
        [statusPath, options({ body: JSON.stringify({ ...body, chat_completion_source: 'openai' }) })],
        [statusPath, { method: 'GET' }],
        [statusPath, options({ body: 'not json' })],
    ];
    for (const args of cases) { await adapter(...args); assert.equal(calls.at(-1)[0], args[0]); assert.equal(calls.at(-1)[1], args[1]); }
    enabled = false;
    const opts = options();
    await adapter(statusPath, opts);
    assert.equal(calls.at(-1)[1], opts);
});

test('pay-as-you-go and old Go addresses use the appropriate catalogue', async () => {
    for (const [url, expected] of [['https://opencode.ai/zen/v1', 'https://opencode.ai/inference/v1'], ['https://opencode.ai/zen/go/v1', 'https://opencode.ai/inference/go/v1']]) {
        const adapter = createStatusFetch(async request => { assert.equal((await request.json()).custom_url, expected); return catalogue(); }, { origin });
        await adapter(statusPath, options({ body: JSON.stringify({ ...body, custom_url: url }) }));
    }
});

test('server errors remain failures; never fabricate a successful model list', async () => {
    let state;
    const upstream = new Response(JSON.stringify({ error: true, data: { data: [] } }));
    const adapter = createStatusFetch(async () => upstream, { origin, onResult: r => state = r, retryDelayMs: 0 });
    assert.equal(await adapter(statusPath, options()), upstream);
    assert.equal(state.ok, false);
});

test('network failures are reported and propagated; abort is not shown as a new error', async () => {
    const failure = new Error('network failure');
    const results = [];
    const adapter = createStatusFetch(async () => { throw failure; }, { origin, onResult: r => results.push(r), retryDelayMs: 0 });
    await assert.rejects(adapter(statusPath, options()), /network failure/);
    assert.equal(results.length, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapter(statusPath, options({ signal: controller.signal })));
    assert.equal(results.length, 1);
});

test('retry one transient catalogue failure without changing plans or probing generation', async () => {
    let calls = 0;
    const adapter = createStatusFetch(async request => {
        calls++;
        assert.equal(request.url, origin + statusPath);
        assert.equal((await request.json()).custom_url, 'https://opencode.ai/inference/go/v1');
        if (calls === 1) throw new Error('ECONNRESET');
        return catalogue();
    }, { origin, retryDelayMs: 0 });
    const result = await adapter(statusPath, options());
    assert.equal(calls, 2);
    assert.equal((await result.json()).data[0].id, 'gemini-4-argon');
});
