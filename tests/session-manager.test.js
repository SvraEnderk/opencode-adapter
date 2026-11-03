import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager, SESSION_KEY, chatScope } from '../session-manager.js';

const context = (extra = {}) => ({ characterId: 0, characters: [{ avatar: 'test.png' }], groupId: null, chatId: 'chat-a', chatMetadata: {}, ...extra });

test('same chat, regeneration, quiet requests and serialized reload reuse one ID', () => {
    const manager = createSessionManager();
    const ctx = context();
    const first = manager.prepare(ctx);
    assert.equal(first.changed, true);
    assert.equal(first.persistent, true);
    for (let i = 0; i < 5; i++) assert.deepEqual(manager.prepare(ctx), { ...first, changed: false });
    const reloaded = createSessionManager().prepare(structuredClone(ctx));
    assert.equal(reloaded.id, first.id);
    assert.equal(reloaded.changed, false);
});

test('new chats, copied branches, same filename for another character are isolated', () => {
    const manager = createSessionManager();
    const ctx = context();
    const first = manager.prepare(ctx);
    const branch = structuredClone(ctx);
    branch.chatId = 'chat-a - branch';
    assert.notEqual(manager.prepare(branch).id, first.id);
    const other = structuredClone(ctx);
    other.characters[0].avatar = 'other.png';
    assert.notEqual(manager.prepare(other).id, first.id);
    assert.notEqual(manager.prepare(context({ chatId: 'chat-b' })).id, first.id);
    assert.equal(manager.prepare(ctx).id, first.id);
});

test('group members share one ID; groups and converted chats are isolated', () => {
    const manager = createSessionManager();
    const group = context({ groupId: '42' });
    const id = manager.prepare(group).id;
    group.characterId = 7;
    assert.equal(manager.prepare(group).id, id);
    const another = structuredClone(group);
    another.groupId = '43';
    assert.notEqual(manager.prepare(another).id, id);
    assert.notEqual(manager.prepare(context()).id, id);
});

test('native temporary chat reuses ID in memory, new chat/reload resets it without writing metadata', () => {
    const manager = createSessionManager();
    const ctx = context({ chatId: undefined });
    const first = manager.prepare(ctx);
    assert.equal(first.persistent, false);
    assert.equal(manager.prepare(ctx).id, first.id);
    assert.notEqual(manager.prepare(context({ chatId: undefined })).id, first.id);
    assert.notEqual(createSessionManager().prepare(ctx).id, first.id);
    assert.notEqual(manager.prepare({}).id, manager.prepare({}).id);
    assert.deepEqual(ctx.chatMetadata, {});
    assert.equal(chatScope(context({ characters: [] })), null);
});

test('character array reorder does not change identity; broken metadata is replaced', () => {
    const manager = createSessionManager();
    const ctx = context();
    const id = manager.prepare(ctx).id;
    ctx.characters.unshift({ avatar: 'unrelated.png' });
    ctx.characterId = 1;
    assert.equal(manager.prepare(ctx).id, id);
    ctx.chatMetadata[SESSION_KEY].id = 'bad\r\nheader';
    assert.notEqual(manager.prepare(ctx).id, id);
});

test('rename keeps ID while updating branch ownership for character and group chats', () => {
    for (const groupId of [null, '42']) {
        const manager = createSessionManager();
        const ctx = context({ groupId });
        const id = manager.prepare(ctx).id;
        ctx.chatId = 'renamed';
        assert.equal(manager.renamed(ctx, { groupId, avatarId: 'test.png', oldFileName: 'chat-a.jsonl' }), true);
        assert.equal(manager.prepare(ctx).id, id);
        assert.equal(manager.renamed(ctx, { groupId: 'other', avatarId: 'wrong.png', oldFileName: 'renamed.jsonl' }), false);
    }
});
