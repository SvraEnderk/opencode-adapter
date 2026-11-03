import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFetch, withSessionHeader, isConnectionProbe } from '../session-adapter.js';
import { createSessionManager, REQUEST_SESSION_KEY } from '../session-manager.js';

const origin = 'http://127.0.0.1:8000';
const path = '/api/backends/chat-completions/generate';
const manager = createSessionManager();
const body = { chat_completion_source: 'custom', custom_url: 'https://opencode.ai/inference/go/openai/v1',
    model: 'gemini-4-argon', secret_id: 'opaque', messages: [{ role: 'user', content: 'Hi' }], stream: true,
    custom_include_headers: JSON.stringify({ 'User-Agent': 'SillyTavern/1.18.0', 'X-OpenCode-Session': 'fixed', another: 'preserved' }) };
const options = (payload = body, extra = {}) => ({ method: 'POST', body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }, credentials: 'include', ...extra });
const setup = (fetch, extra = {}) => createSessionFetch(fetch, { origin, temporary: manager.temporary, parseYaml: JSON.parse, ...extra });

test('native quiet Hi connection probe is isolated without mistaking real chat or summaries', () => {
    assert.equal(isConnectionProbe({ ...body, type: 'quiet' }), true);
    assert.equal(isConnectionProbe({ ...body, type: 'normal' }), false);
    assert.equal(isConnectionProbe({ ...body, type: 'quiet', messages: [{ role: 'user', content: 'Summarize this chat' }] }), false);
    assert.equal(isConnectionProbe({ ...body, type: 'quiet', messages: [...body.messages, ...body.messages] }), false);
});

test('prepared chat ID replaces case variants, preserves payload/auth/signal and strips private marker', async () => {
    let sent;
    const id = manager.temporary();
    const controller = new AbortController();
    const response = new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    const adapter = setup(async request => { sent = request; return response; });
    const returned = await adapter(path, options({ ...body, [REQUEST_SESSION_KEY]: { id, persistent: true } }, { signal: controller.signal }));
    assert.equal(returned, response);
    assert.equal(returned.bodyUsed, false);
    const payload = await sent.json();
    assert.equal(payload[REQUEST_SESSION_KEY], undefined);
    assert.equal(sent.headers.get('X-CSRF-Token'), 'test');
    assert.equal(sent.credentials, 'include');
    assert.deepEqual(payload.messages, body.messages);
    assert.equal(payload.model, body.model);
    assert.equal(payload.secret_id, body.secret_id);
    assert.deepEqual(JSON.parse(payload.custom_include_headers), { 'User-Agent': 'SillyTavern/1.18.0', another: 'preserved', 'x-opencode-session': id });
    controller.abort();
    assert.equal(sent.signal.aborted, true);
});

test('independent auxiliary/test requests use different temporary IDs even with static preset header', async () => {
    const ids = [];
    const reports = [];
    const adapter = setup(async request => {
        ids.push(JSON.parse((await request.json()).custom_include_headers)['x-opencode-session']);
        return new Response('{}');
    }, { onSent: event => reports.push(event) });
    await adapter(path, options());
    await adapter(path, options());
    assert.notEqual(ids[0], ids[1]);
    assert.equal(reports.every(r => r.persistent === false), true);
    assert.equal(JSON.parse(body.custom_include_headers)['X-OpenCode-Session'], 'fixed');
});

test('Request input remains readable; failed HTTP/network generations are never retried', async () => {
    let calls = 0;
    const response = new Response('{}', { status: 429 });
    const adapter = setup(async () => { calls++; return response; });
    const original = new Request(origin + path, options());
    assert.equal(await adapter(original), response);
    assert.deepEqual(await original.json(), body);
    assert.equal(calls, 1);
    const failure = setup(async () => { calls++; throw new Error('ECONNRESET'); });
    await assert.rejects(failure(path, options()), /ECONNRESET/);
    assert.equal(calls, 2);
});

test('payg, other origins/providers, status probes, non-POST, malformed body and disabled mode pass through', async () => {
    const calls = [];
    const adapter = setup(async (...args) => { calls.push(args); return new Response('{}'); });
    const cases = [
        [path, options({ ...body, custom_url: 'https://opencode.ai/inference/openai/v1' })],
        [path, options({ ...body, custom_url: 'https://another.test/v1' })],
        [path, options({ ...body, chat_completion_source: 'openai' })],
        ['https://another.test' + path, options()],
        ['/api/backends/chat-completions/status', options()],
        [path, { method: 'GET' }], [path, { method: 'POST', body: 'null' }],
        [path, { method: 'POST', body: '{bad' }],
    ];
    for (const args of cases) {
        await adapter(...args);
        assert.equal(calls.at(-1)[0], args[0]);
        assert.equal(calls.at(-1)[1], args[1]);
    }
    const disabled = setup(async (...args) => { calls.push(args); }, { enabled: () => false });
    const opts = options();
    await disabled(path, opts);
    assert.equal(calls.at(-1)[1], opts);
});

test('disabled mode still removes private marker without modifying saved headers', async () => {
    let sent;
    const disabled = setup(async request => { sent = await request.json(); }, { enabled: () => false });
    await disabled(path, options({ ...body, [REQUEST_SESSION_KEY]: { id: manager.temporary(), persistent: true } }));
    assert.deepEqual(sent, body);
});

test('invalid YAML/header structures fail before network, keep original input and report useful error', async () => {
    let calls = 0;
    let errors = 0;
    const adapter = setup(async () => { calls++; }, { onError: () => errors++ });
    for (const source of ['{bad', '[]', '"scalar"', 'null']) {
        await assert.rejects(adapter(path, options({ ...body, custom_include_headers: source })));
    }
    assert.equal(calls, 0);
    assert.equal(errors, 4);
    const result = withSessionHeader('', manager.temporary(), JSON.parse);
    assert.equal(Object.keys(JSON.parse(result)).length, 1);
});

test('pre-aborted requests never reach network', async () => {
    let calls = 0;
    const adapter = setup(async () => { calls++; });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(adapter(path, options(body, { signal: controller.signal })));
    assert.equal(calls, 0);
});
