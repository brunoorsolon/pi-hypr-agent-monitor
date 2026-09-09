import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import monitor from './index.ts';

const firstModel = { provider: 'test-provider', id: 'first-model' };

function register() {
  const handlers = new Map();
  monitor({ on: (event, handler) => handlers.set(event, handler) });
  return handlers;
}

function context(sessionId = 'session-1', cwd = '/work', model = firstModel) {
  return { cwd, model, sessionManager: { getSessionId: () => sessionId } };
}

test('publishes the gated Pi lifecycle contract atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-hypr-monitor-test-'));
  const saved = Object.fromEntries(['PI_HYPR_MONITOR', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME'].map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  process.env.XDG_RUNTIME_DIR = directory;
  const statusPath = join(directory, 'pi-hypr-agent-monitor', 'status.json');
  const readStatus = async (path = statusPath) => JSON.parse(await readFile(path, 'utf8'));
  const handlers = register();
  const emit = async (type, event = {}, ctx = context()) => handlers.get(type)?.({ type, ...event }, ctx);

  for (const gate of [undefined, '0']) {
    if (gate === undefined) delete process.env.PI_HYPR_MONITOR;
    else process.env.PI_HYPR_MONITOR = gate;
    for (const event of ['session_start', 'agent_start', 'agent_settled', 'model_select', 'session_shutdown']) {
      await emit(event, event === 'model_select' ? { model: firstModel } : { reason: 'startup' });
    }
    await assert.rejects(readFile(statusPath), { code: 'ENOENT' });
    await mkdir(join(directory, 'pi-hypr-agent-monitor'), { recursive: true });
    const existing = JSON.stringify({ pid: process.pid, state: 'waiting' });
    await writeFile(statusPath, existing);
    for (const event of ['session_start', 'agent_start', 'agent_settled', 'model_select', 'session_shutdown']) {
      await emit(event, event === 'model_select' ? { model: firstModel } : { reason: 'startup' });
      assert.equal(await readFile(statusPath, 'utf8'), existing);
    }
    await rm(statusPath);
  }

  process.env.PI_HYPR_MONITOR = '1';
  const startedAt = Math.floor(Date.now() / 1000);
  for (const reason of ['new', 'resume', 'fork']) {
    await emit('session_start', { reason }, context(`session-${reason}`, `/work/${reason}`));
    const status = await readStatus();
    assert.equal(status.state, 'idle');
    assert.equal(status.session_id, `session-${reason}`);
    assert.equal(status.cwd, `/work/${reason}`);
  }

  await emit('session_start', { reason: 'startup' });
  for (const [event, state] of [['agent_start', 'working'], ['agent_settled', 'waiting']]) {
    await emit(event);
    const status = await readStatus();
    assert.deepEqual(Object.keys(status).sort(), ['cwd', 'model', 'pid', 'session_id', 'state', 'updated_at']);
    assert.equal(status.state, state);
    assert.equal(status.pid, process.pid);
    assert.equal(status.session_id, 'session-1');
    assert.equal(status.cwd, '/work');
    assert.equal(status.model, 'test-provider/first-model');
    assert.ok(Number.isInteger(status.updated_at));
    assert.ok(status.updated_at >= startedAt && status.updated_at <= Math.floor(Date.now() / 1000));
  }

  const secondModel = { provider: 'other-provider', id: 'second-model' };
  await emit('model_select', { model: secondModel }, context('session-1', '/work', firstModel));
  assert.equal((await readStatus()).state, 'waiting');
  assert.equal((await readStatus()).model, 'other-provider/second-model');
  await emit('agent_start');
  assert.equal((await readStatus()).model, 'other-provider/second-model');

  assert.equal(handlers.has('tool_execution_update'), false);
  const beforeTool = await readFile(statusPath, 'utf8');
  await emit('tool_execution_update');
  assert.equal(await readFile(statusPath, 'utf8'), beforeTool);
  for (let index = 0; index < 100; index++) {
    const event = index % 2 ? 'agent_start' : 'agent_settled';
    const [, document] = await Promise.all([emit(event), readFile(statusPath, 'utf8')]);
    assert.ok(['working', 'waiting'].includes(JSON.parse(document).state));
  }

  const otherOwner = JSON.stringify({ ...(await readStatus()), pid: process.pid + 1 });
  await writeFile(statusPath, otherOwner);
  await emit('session_shutdown');
  assert.equal(await readFile(statusPath, 'utf8'), otherOwner);
  await emit('session_start', { reason: 'startup' });
  await emit('session_shutdown');
  await assert.rejects(readFile(statusPath), { code: 'ENOENT' });

  delete process.env.XDG_RUNTIME_DIR;
  process.env.XDG_STATE_HOME = join(directory, 'state-home');
  const fallbackPath = join(process.env.XDG_STATE_HOME, 'pi-hypr-agent-monitor', 'status.json');
  await emit('session_start', { reason: 'startup' });
  assert.equal((await readStatus(fallbackPath)).session_id, 'session-1');
  await emit('session_shutdown');
  await assert.rejects(readFile(fallbackPath), { code: 'ENOENT' });

  process.env.XDG_RUNTIME_DIR = directory;
  const extensionUrl = new URL('./index.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import monitor from ${JSON.stringify(extensionUrl)};
    const handlers = new Map();
    monitor({ on: (event, handler) => handlers.set(event, handler) });
    await handlers.get('session_start')({}, {
      cwd: '/killed',
      model: { provider: 'test-provider', id: 'killed-model' },
      sessionManager: { getSessionId: () => 'killed-session' },
    });
    setInterval(() => {}, 1000);
  `], { env: process.env, stdio: 'ignore' });
  const childExit = once(child, 'exit');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let killedStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      killedStatus = await readStatus();
      if (killedStatus.pid === child.pid) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(killedStatus?.pid, child.pid);
  assert.equal(child.kill('SIGKILL'), true);
  await childExit;
  assert.equal((await readStatus()).pid, child.pid);
  await assert.rejects(access(`/proc/${child.pid}`), { code: 'ENOENT' });
});
