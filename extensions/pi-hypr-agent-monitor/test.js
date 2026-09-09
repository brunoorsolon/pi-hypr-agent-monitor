import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import monitor from './index.ts';

test('gated lifecycle publishes status and removes only its own file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-hypr-monitor-test-'));
  const saved = { PI_HYPR_MONITOR: process.env.PI_HYPR_MONITOR, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.env.XDG_RUNTIME_DIR = directory;
  const statusPath = join(directory, 'pi-hypr-agent-monitor', 'status.json');
  const ctx = { model: { provider: 'test-provider', id: 'first-model' } };
  const readStatus = async () => JSON.parse(await readFile(statusPath, 'utf8'));
  function register() {
    const handlers = new Map();
    monitor({ on: (event, handler) => handlers.set(event, handler) });
    return async (type) => handlers.get(type)?.({ type, reason: 'startup', model: ctx.model }, ctx);
  }

  for (const gate of [undefined, '0']) {
    if (gate === undefined) delete process.env.PI_HYPR_MONITOR;
    else process.env.PI_HYPR_MONITOR = gate;
    const emit = register();
    for (const event of ['session_start', 'agent_start', 'agent_settled', 'model_select', 'session_shutdown']) {
      await emit(event);
    }
    await assert.rejects(readFile(statusPath), { code: 'ENOENT' });
    await mkdir(join(directory, 'pi-hypr-agent-monitor'), { recursive: true });
    const existing = JSON.stringify({ pid: process.pid, state: 'waiting' });
    await writeFile(statusPath, existing);
    for (const event of ['session_start', 'agent_start', 'agent_settled', 'model_select', 'session_shutdown']) {
      await emit(event);
      assert.equal(await readFile(statusPath, 'utf8'), existing);
    }
    await rm(statusPath);
  }

  process.env.PI_HYPR_MONITOR = '1';
  const emit = register();
  const startedAt = Math.floor(Date.now() / 1000);
  for (const [event, state] of [['session_start', 'idle'], ['agent_start', 'working'], ['agent_settled', 'waiting']]) {
    await emit(event);
    const status = await readStatus();
    assert.equal(status.state, state);
    assert.equal(status.pid, process.pid);
    assert.equal(status.model, 'test-provider/first-model');
    assert.ok(Number.isInteger(status.updated_at));
    assert.ok(status.updated_at >= startedAt && status.updated_at <= Math.floor(Date.now() / 1000));
  }
  ctx.model = { provider: 'other-provider', id: 'second-model' };
  await emit('model_select');
  assert.equal((await readStatus()).state, 'waiting');
  assert.equal((await readStatus()).model, 'other-provider/second-model');
  await emit('agent_start');
  assert.equal((await readStatus()).model, 'other-provider/second-model');

  const otherOwner = JSON.stringify({ ...(await readStatus()), pid: process.pid + 1 });
  await writeFile(statusPath, otherOwner);
  await emit('session_shutdown');
  assert.equal(await readFile(statusPath, 'utf8'), otherOwner);
  await emit('session_start');
  await emit('session_shutdown');
  await assert.rejects(readFile(statusPath), { code: 'ENOENT' });
});
