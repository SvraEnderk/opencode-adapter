import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenCodeUrl, textModels } from '../endpoints.js';

test('Go roots, legacy URLs, native Gemini and full chat paths resolve to separate endpoints', () => {
    for (const url of [
        'https://opencode.ai', ' https://opencode.ai/ ',
        'https://opencode.ai/inference/go', 'https://opencode.ai/inference/go/v1/models',
        'https://opencode.ai/inference/go/openai/v1/',
        'https://opencode.ai/inference/go/openai/v1/chat/completions',
        'https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent',
        'https://opencode.ai/zen/go/v1',
    ]) {
        const route = resolveOpenCodeUrl(url);
        assert.equal(route?.plan, 'go', url);
        assert.equal(route.chatBase, 'https://opencode.ai/inference/go/openai/v1');
        assert.equal(route.modelsUrl, 'https://opencode.ai/inference/go/v1/models');
    }
});

test('pay-as-you-go is never silently changed to subscription billing', () => {
    for (const url of ['https://opencode.ai/inference', 'https://opencode.ai/inference/openai/v1', 'https://opencode.ai/zen/v1']) {
        const route = resolveOpenCodeUrl(url);
        assert.equal(route.plan, 'payg');
        assert.equal(route.modelsBase, 'https://opencode.ai/inference/v1');
        assert.equal(route.chatBase, 'https://opencode.ai/inference/openai/v1');
    }
    assert.equal(resolveOpenCodeUrl('https://opencode.ai', 'payg').plan, 'payg');
});

test('reject look-alike domains, credentials, arbitrary sites, insecure URLs and unrelated paths', () => {
    for (const value of ['', null, 'opencode.ai', 'http://opencode.ai/zen/go/v1',
        'https://opencode.ai.evil.test/inference/go', 'https://evil.test/inference/go',
        'https://opencode.ai:444/inference/go', 'https://user:password@opencode.ai/inference/go',
        'https://opencode.ai/console', 'https://opencode.ai/inference/go?key=secret',
        'https://opencode.ai/inference/go#key']) assert.equal(resolveOpenCodeUrl(value), null, String(value));
});

test('filter image/embedding models, invalid and duplicate entries while preserving catalogue metadata', () => {
    const metadata = { id: 'gemini-4-argon', type: 'chat', name: 'Gemini 4 Argon', limit: { context: 1048576 } };
    const models = textModels({ data: [null, {}, metadata, metadata, { id: 'embedding', type: 'embedding' },
        { id: 'image', modalities: { output: ['image'] } }, { id: 'legacy-chat' }] });
    assert.deepEqual(models.map(m => m.id), ['gemini-4-argon', 'legacy-chat']);
    assert.equal(models[0].limit.context, 1048576);
    assert.throws(() => textModels({ error: true }));
});
