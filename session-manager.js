export const SESSION_KEY = 'opencode_adapter_session';
export const REQUEST_SESSION_KEY = '_opencode_adapter_session';
const VALID_ID = /^oc-st-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validSessionId(value) {
    return typeof value === 'string' && VALID_ID.test(value);
}

// Character array positions can change; use the avatar filename instead.
export function chatScope(context) {
    if (context?.chatId === undefined || context.chatId === null || context.chatId === '') return null;
    if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '') {
        return { kind: 'group', owner: String(context.groupId), chat: String(context.chatId) };
    }
    const avatar = context.characters?.[context.characterId]?.avatar;
    return avatar ? { kind: 'character', owner: avatar, chat: String(context.chatId) } : null;
}

function sameScope(a, b) {
    return !!a && !!b && a.kind === b.kind && a.owner === b.owner && a.chat === b.chat;
}

export function createSessionManager({ uuid = () => crypto.randomUUID() } = {}) {
    const temporary = () => `oc-st-${uuid()}`;
    const temporaryChats = new WeakMap();
    function current(context) {
        const record = context?.chatMetadata?.[SESSION_KEY];
        return record?.version === 1 && validSessionId(record.id)
            && sameScope(record.scope, chatScope(context)) ? record : null;
    }
    return {
        temporary,
        current,
        prepare(context) {
            const scope = chatScope(context);
            if (!context?.chatMetadata || typeof context.chatMetadata !== 'object') {
                return { id: temporary(), persistent: false, changed: false };
            }
            if (!scope) {
                // Native temporary chats have no filename. Their metadata object is
                // replaced by ST when a new temporary chat starts; never write it to disk.
                if (!temporaryChats.has(context.chatMetadata)) temporaryChats.set(context.chatMetadata, temporary());
                return { id: temporaryChats.get(context.chatMetadata), persistent: false, changed: false };
            }
            const existing = current(context);
            if (existing) return { id: existing.id, persistent: true, changed: false };
            // Branches copy metadata. A different chat filename must receive a new ID.
            const record = { version: 1, id: temporary(), scope };
            context.chatMetadata[SESSION_KEY] = record;
            return { id: record.id, persistent: true, changed: true };
        },
        renamed(context, event) {
            const scope = chatScope(context);
            const record = context?.chatMetadata?.[SESSION_KEY];
            if (!scope || record?.version !== 1 || !validSessionId(record.id)) return false;
            const oldName = String(event?.oldFileName ?? '').replace(/\.jsonl$/i, '');
            const owner = scope.kind === 'group' ? String(event?.groupId ?? '') : event?.avatarId;
            if (owner !== scope.owner || record.scope?.kind !== scope.kind
                || record.scope?.owner !== scope.owner || record.scope?.chat !== oldName) return false;
            record.scope = scope;
            return true;
        },
    };
}
