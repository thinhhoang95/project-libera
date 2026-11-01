// Standalone review regression from 2026-11-01. The normal server suite also
// covers removal, demotion, and transaction-level authorization changes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { startSyncEnv } from '../../../server/test/support/sync-fixtures.ts';
import { json } from '../../../server/test/helpers.ts';
import { MessageType } from '../../../server/src/protocol.ts';
test('a queued open cannot retain membership removed before it completes', { timeout: 30000 }, async () => {
    const env = await startSyncEnv();
    let release;
    const gate = new Promise(resolve => release = resolve);
    let blocked;
    const holding = new Promise(resolve => blocked = resolve);
    try {
        const editor = await env.member('editor');
        const owner = await env.connect();
        await owner.open(env.docId);
        const member = await env.connect(editor);
        const sync = env.server.server.sync;
        const room = sync.loaded.get(env.docId);
        const job = env.server.server.context.rooms.withDocs(env.docId, async () => { blocked(); await gate; });
        await holding;
        const originalRun = room.queue.run;
        let enqueued;
        const queued = new Promise(resolve => enqueued = resolve);
        room.queue.run = function (task) { enqueued(); return originalRun.call(this, task); };
        member.send({ type: MessageType.Open, docId: env.docId, subdocs: [] });
        const opened = member.waitFor(message => message.docId === env.docId &&
            (message.type === MessageType.Opened || message.type === MessageType.Closed));
        await queued;
        room.queue.run = originalRun;
        const removed = await json(env.server.url, `/v1/projects/${env.project.id}/members/${editor.id}`, { method: 'DELETE', token: env.owner.token });
        assert.equal(removed.status, 204);
        release();
        await job;
        const response = await opened;
        if (response.type === MessageType.Closed) {
            assert.ok(['not-found', 'access-revoked', 'forbidden'].includes(response.reason));
            return;
        }
        const edit = member.edit(env.docId, 'content', doc => doc.getText('source').insert(0, 'written after removal'));
        const outcome = await member.waitFor(m => (m.type === MessageType.Ack || m.type === MessageType.Reject) && m.docId === env.docId && m.clientSeq === edit.clientSeq);
        const serverText = await env.server.server.context.rooms.withDocs(env.docId, docs => docs.content.getText('source').toString());
        console.log('AUDIT removal during open', JSON.stringify({ removed: removed.status, openedRole: response.role, writeOutcome: outcome.type === MessageType.Ack ? 'ack' : 'reject', serverText }));
        assert.fail(`A removed member received an open document; subsequent write was ${outcome.type === MessageType.Ack ? 'acknowledged' : 'rejected'}.`);
    }
    finally {
        release();
        await env.close();
    }
});
