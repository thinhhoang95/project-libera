// Review regressions from 2026-11-01. Also imported by the normal collab suite.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { api, closePeer, invite, makePeer, readText, register, sleep, tempRoot, until, writeTree } from '../support/notebooks-harness.ts';
import { removeDataDir, startServerProcess } from '../support/server-process.ts';
import { ControlRoutes } from '../../../src/lib/collab/local-api.ts';
import { ContentKeys, ManifestKeys } from '../../../src/lib/collab/protocol/schema.ts';
import { MessageType } from '../../../src/lib/collab/protocol/messages.ts';
import { CollabHost } from '../../../electron/collab/core/host.ts';
import { FakeSyncServer } from '../support/host-fake-server.ts';
import { ManualClock, TestTokens, quietLogger, settle } from '../support/host-helpers.ts';
const MARKER = '.libera-shared.json';
function textOf(peer, liberaPath) {
    const r = peer.service.resolvePath(liberaPath);
    if (!r)
        return null;
    const hub = peer.host.acquire(r.docId);
    try {
        return hub.getText();
    }
    finally {
        peer.host.release(r.docId);
    }
}
async function share(peer, name, files) {
    writeTree(path.join(peer.library, name), files);
    const result = await peer.router.call('POST', ControlRoutes.share, { notebook: name });
    assert.equal(result.status, 200, JSON.stringify(result));
    await peer.service.project(result.body.projectId).whenIdle();
    return result.body.projectId;
}
async function join(peer, owner, server, projectId) {
    const result = await peer.router.call('POST', ControlRoutes.join, { invitation: await invite(server, owner.auth, projectId, peer.auth.account.email) });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.body.notebook;
}
test('additional sync edge cases', { timeout: 180000 }, async (t) => {
    const temp = tempRoot('libera-audit-');
    const server = await startServerProcess();
    let peers = [];
    async function clean() {
        for (const peer of peers) await closePeer(peer).catch(() => {});
        peers = [];
    }
    try {
        const ownerAuth = await register(server, 'AuditOwner');
        const memberAuth = await register(server, 'AuditMember');
        await t.test('rejoining after removal clears the persisted access revocation', async () => {
            const owner = await makePeer(temp.dir, 'rejoin-owner', server, ownerAuth);
            const member = await makePeer(temp.dir, 'rejoin-member', server, memberAuth);
            peers.push(owner, member);
            try {
                const id = await share(owner, 'Rejoin', { 'note.md': 'original\n' });
                const name = await join(member, owner, server, id);
                const docId = member.service.resolvePath(`${name}/note.md`).docId;
                const removed = await api(server, `/v1/projects/${id}/members/${memberAuth.account.id}`, undefined, ownerAuth.accessToken, 'DELETE');
                assert.equal(removed.status, 204);
                await until(() => member.service.localProjects()[0]?.revoked === true, 'member revoked');
                const result = await member.router.call('POST', ControlRoutes.join, { invitation: await invite(server, ownerAuth, id, memberAuth.account.email) });
                console.log('AUDIT rejoin', JSON.stringify(result), member.host.store.getDocMeta(docId));
                assert.equal(result.status, 200);
                const hub = member.host.acquire(docId);
                try {
                    assert.equal(hub.canSync(), true, 'reinvited editor must sync again');
                }
                finally {
                    member.host.release(docId);
                }
            }
            finally {
                await clean();
            }
        });
        await t.test('revoked follower can delete its local notebook without its former writer', async () => {
            const owner = await makePeer(temp.dir, 'revoke-owner', server, ownerAuth);
            const member = await makePeer(temp.dir, 'revoke-member', server, memberAuth);
            peers.push(owner, member);
            try {
                const id = await share(owner, 'FollowerRevoke', { 'note.md': 'keep\n' });
                const name = await join(member, owner, server, id);
                const copyLib = path.join(temp.dir, 'revoked-twin-library');
                mkdirSync(copyLib);
                const copyRoot = path.join(copyLib, name);
                cpSync(path.join(member.library, name), copyRoot, { recursive: true });
                const twin = await makePeer(temp.dir, 'revoke-twin', server, memberAuth, { library: copyLib });
                peers.push(twin);
                await until(() => twin.service.project(id)?.follower === true, 'follower running');
                await closePeer(member);
                peers = peers.filter(p => p !== member);
                assert.equal((await api(server, `/v1/projects/${id}/members/${memberAuth.account.id}`, undefined, ownerAuth.accessToken, 'DELETE')).status, 204);
                await until(() => twin.service.localProjects()[0]?.revoked === true, 'follower revoked');
                const marker = JSON.parse(readFileSync(path.join(copyRoot, MARKER), 'utf8'));
                console.log('AUDIT follower revoke', JSON.stringify({ local: twin.service.localProjects(), marker }));
                assert.equal(marker.revoked, true, 'deleteNotebook rejects this folder while marker.revoked is absent');
            }
            finally {
                await clean();
            }
        });
        await t.test('a returning device cleans up an empty notebook taken down while it was stopped', async () => {
            let owner = await makePeer(temp.dir, 'empty-owner', server, ownerAuth);
            peers.push(owner);
            try {
                const root = path.join(owner.library, 'EmptyGone');
                mkdirSync(root);
                const shared = await owner.router.call('POST', ControlRoutes.share, { notebook: 'EmptyGone' });
                assert.equal(shared.status, 200);
                const id = shared.body.projectId;
                await closePeer(owner);
                peers = [];
                assert.equal((await api(server, `/v1/projects/${id}`, undefined, ownerAuth.accessToken, 'DELETE')).status, 204);
                owner = await makePeer(temp.dir, 'empty-owner', server, ownerAuth, { leaseTtlMs: 1500 });
                peers.push(owner);
                await sleep(1200);
                console.log('AUDIT empty remote takedown', JSON.stringify({ projects: owner.service.localProjects(), markerExists: existsSync(path.join(root, MARKER)), meta: owner.host.store.getDocMeta(owner.service.project(id)?.info.manifestDocId ?? '') }));
                assert.equal(existsSync(path.join(root, MARKER)), false, 'a known empty project must not remain locked after a confirmed server deletion');
            }
            finally {
                await clean();
            }
        });
        await t.test('writer takeover does not interpret a not-yet-synced file as a deletion', async () => {
            const owner = await makePeer(temp.dir, 'takeover-owner', server, ownerAuth);
            peers.push(owner);
            try {
                const id = await share(owner, 'Takeover', { 'note.md': 'keep me\n', 'other.md': 'other\n' });
                const copyLib = path.join(temp.dir, 'takeover-twin-library');
                mkdirSync(copyLib);
                const copyRoot = path.join(copyLib, 'Takeover');
                cpSync(path.join(owner.library, 'Takeover'), copyRoot, { recursive: true });
                // A cloud client has delivered the marker/state but not this text file.
                rmSync(path.join(copyRoot, 'note.md'));
                const twin = await makePeer(temp.dir, 'takeover-twin', server, ownerAuth, { library: copyLib, leaseTtlMs: 1500 });
                peers.push(twin);
                await until(() => textOf(twin, 'Takeover/note.md') === 'keep me\n', 'follower has complete CRDT');
                await closePeer(owner);
                peers = peers.filter(p => p !== owner);
                await until(() => twin.service.project(id)?.follower === false, 'take over');
                await sleep(1800);
                console.log('AUDIT takeover', JSON.stringify({ resolved: twin.service.resolvePath('Takeover/note.md'), disk: readText(copyRoot, 'note.md'), archive: readText(copyRoot, '_archive/note.md') }));
                assert.ok(twin.service.resolvePath('Takeover/note.md'), 'a file absent only from the cloud copy must remain shared');
            }
            finally {
                await clean();
            }
        });
        await t.test('remote takedown preserves text newer than the debounced disk copy', async () => {
            const owner = await makePeer(temp.dir, 'takedown-owner', server, ownerAuth, { timings: { writeDebounceMs: 10000, writeMaxWaitMs: 30000 } });
            peers.push(owner);
            try {
                const id = await share(owner, 'RemoteTakedown', { 'note.md': 'original\n' });
                const docId = owner.service.resolvePath('RemoteTakedown/note.md').docId;
                const hub = owner.host.acquire(docId);
                try {
                    hub.applyLocalChange('content', doc => doc.getText(ContentKeys.source).insert(0, 'latest\n'), { source: 'typing' });
                    await until(() => hub.pendingCount === 0, 'last edit acknowledged');
                    assert.equal(readText(path.join(owner.library, 'RemoteTakedown'), 'note.md'), 'original\n');
                    assert.equal((await api(server, `/v1/projects/${id}`, undefined, ownerAuth.accessToken, 'DELETE')).status, 204);
                    await until(() => owner.service.localProjects().length === 0, 'remote takedown cleanup');
                    console.log('AUDIT takedown', JSON.stringify({ disk: readText(path.join(owner.library, 'RemoteTakedown'), 'note.md'), hub: hub.getText(), projects: owner.service.localProjects() }));
                    assert.equal(readText(path.join(owner.library, 'RemoteTakedown'), 'note.md'), 'latest\noriginal\n', 'returned local notebook must contain the last saved text');
                }
                finally {
                    owner.host.release(docId);
                }
            }
            finally {
                await clean();
            }
        });
        await t.test('a delayed blob replacement respects a completed remote rename', async () => {
            let block = false;
            let release;
            let uploadStarted;
            const started = new Promise(resolve => uploadStarted = resolve);
            const gate = new Promise(resolve => release = resolve);
            const delayedFetch = async (url, init) => {
                if (block && init.method === 'PUT' && url.includes('/blobs/')) {
                    uploadStarted();
                    await gate;
                }
                return fetch(url, init);
            };
            const owner = await makePeer(temp.dir, 'blob-owner', server, ownerAuth, { fetch: delayedFetch });
            const member = await makePeer(temp.dir, 'blob-member', server, memberAuth);
            peers.push(owner, member);
            try {
                const id = await share(owner, 'BlobRename', { 'image.png': Buffer.from([1, 2, 3, 4]) });
                await join(member, owner, server, id);
                block = true;
                const write = owner.router.call('POST', ControlRoutes.files(id), { op: 'write-blob', path: 'image.png', contentBase64: Buffer.from([5, 6, 7, 8]).toString('base64') });
                await Promise.race([started, sleep(3000).then(() => { throw new Error('upload gate not reached'); })]);
                assert.equal((await member.router.call('POST', ControlRoutes.files(id), { op: 'rename', path: 'image.png', to: 'renamed.png' })).status, 200);
                const manifest = owner.host.acquire(owner.service.project(id).info.manifestDocId);
                try {
                    await until(() => [...manifest.getDoc('manifest').getMap(ManifestKeys.files).values()].some((v) => v.path === 'renamed.png'), 'remote rename reaches in-flight writer');
                }
                finally {
                    owner.host.release(manifest.docId);
                }
                release();
                assert.equal((await write).status, 200);
                await sleep(500);
                const h = owner.host.acquire(owner.service.project(id).info.manifestDocId);
                try {
                    const values = [...h.getDoc('manifest').getMap(ManifestKeys.files).values()];
                    console.log('AUDIT blob rename', JSON.stringify(values));
                    assert.deepEqual(values.map(v => v.path), ['renamed.png'], 'completed rename must not be reverted by a later upload response');
                }
                finally {
                    owner.host.release(h.docId);
                }
            }
            finally {
                release();
                await clean();
            }
        });
        await t.test('an in-flight blob download never recreates a deleted notebook root', async () => {
            let block = false;
            let release;
            let downloadStarted;
            const started = new Promise(resolve => downloadStarted = resolve);
            const gate = new Promise(resolve => release = resolve);
            const delayedFetch = async (url, init) => {
                if (block && init.method === 'GET' && url.includes('/blobs/')) {
                    downloadStarted();
                    await gate;
                }
                return fetch(url, init);
            };
            const owner = await makePeer(temp.dir, 'download-owner', server, ownerAuth);
            const member = await makePeer(temp.dir, 'download-member', server, memberAuth, { fetch: delayedFetch });
            peers.push(owner, member);
            try {
                const id = await share(owner, 'DownloadRoot', { 'image.png': Buffer.from([1, 2, 3, 4]) });
                const name = await join(member, owner, server, id);
                const root = path.join(member.library, name);
                block = true;
                const write = await owner.router.call('POST', ControlRoutes.files(id), { op: 'write-blob', path: 'image.png', contentBase64: Buffer.from([9, 8, 7, 6]).toString('base64') });
                assert.equal(write.status, 200);
                await Promise.race([started, sleep(3000).then(() => { throw new Error('download gate not reached'); })]);
                rmSync(root, { recursive: true, force: true });
                release();
                await sleep(300);
                console.log('AUDIT download deleted root', JSON.stringify({ rootExists: existsSync(root), fileExists: existsSync(path.join(root, 'image.png')), markerExists: existsSync(path.join(root, MARKER)) }));
                assert.equal(existsSync(root), false, 'pending download must not recreate the root after it has been deleted');
            }
            finally {
                release();
                await clean();
            }
        });
        await t.test('live role changes reach document metadata used by the editors', async () => {
            const owner = await makePeer(temp.dir, 'role-owner', server, ownerAuth);
            const member = await makePeer(temp.dir, 'role-member', server, memberAuth);
            peers.push(owner, member);
            try {
                const id = await share(owner, 'RoleChange', { 'note.md': 'text\n' });
                const name = await join(member, owner, server, id);
                const hub = member.host.acquire(member.service.resolvePath(`${name}/note.md`).docId);
                try {
                    assert.equal(hub.getMeta().role, 'editor');
                    assert.equal((await api(server, `/v1/projects/${id}/members/${memberAuth.account.id}`, { role: 'viewer' }, ownerAuth.accessToken, 'PATCH')).status, 200);
                    await until(() => member.service.localProjects()[0]?.role === 'viewer', 'notebook role event');
                    await sleep(200);
                    console.log('AUDIT role change', JSON.stringify({ resolved: member.service.resolvePath(`${name}/note.md`), meta: hub.getMeta() }));
                    assert.equal(hub.getMeta().role, 'viewer', 'the editor must receive the new role without a reconnect');
                assert.equal((await api(server, `/v1/projects/${id}/members/${memberAuth.account.id}`, { role: 'editor' }, ownerAuth.accessToken, 'PATCH')).status, 200);
                await until(() => hub.getMeta().role === 'editor', 'live promotion reaches editor metadata');
                assert.equal(hub.getMeta().readOnly, false);
                }
                finally {
                    member.host.release(hub.docId);
                }
            }
            finally {
                await clean();
            }
        });
        await t.test('an internal save error retries on an otherwise healthy connection', async () => {
            const fake = new FakeSyncServer();
            const clock = new ManualClock();
            const host = new CollabHost({ dbPath: ':memory:', appVersion: 'test', installationId: 'inst_audit_error', webSocketFactory: fake.factory, clock, logger: quietLogger, compaction: false, telemetry: false, divergence: false, limits: { batchWindowMs: 1, pingIntervalMs: 1000 } });
            host.start();
            host.setAccount({ accountId: 'account-error', serverUrl: 'http://fake', tokenProvider: new TestTokens() });
            const hub = host.acquire('doc-internal-error');
            try {
                await until(() => hub.getStatus().state === 'saved-remote', 'fake document connected');
                fake.dropNext = 1;
                hub.applyLocalChange('content', doc => doc.getText(ContentKeys.source).insert(0, 'must retry'), { source: 'typing' });
                clock.advance(10);
                await settle();
                assert.equal(fake.updates().length, 1);
                fake.liveSockets[0].push({ type: MessageType.Error, code: 'internal', docId: hub.docId, message: 'The update could not be saved.' });
                await settle();
                for (let i = 0; i < 120; i++) {
                    clock.advance(1000);
                    await settle(3);
                }
                host.nudge();
                await settle();
                console.log('AUDIT internal save error', JSON.stringify({ connection: host.connectionState, pending: hub.pendingCount, sends: fake.updates().length, server: fake.text(hub.docId) }));
                assert.equal(hub.pendingCount, 0, 'transient database failure must not leave pending changes stuck until disconnect');
            }
            finally {
                host.release(hub.docId);
                await host.stop();
            }
        });
    }
    finally {
        await clean();
        await server.stop();
        removeDataDir(server.dataDir);
        temp.cleanup();
    }
});
