const fs = require('fs');

let sessionId = '';
let sessionCwd = '';
let model = '';
let currentStatus = null;


const path = require('path');
const os = require('os');

/**
 * Status data shape
 * @typedef {Object} StatusData
 * @property {'working'|'waiting'|'idle'} state
 * @property {number} pid
 * @property {string} session_id
 * @property {string} cwd
 * @property {string} model
 * @property {number} updated_at
 */

/**
 * Get the file path for the status JSON.
 * @returns {string}
 */
function getStatusFilePath() {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    return path.join(runtimeDir, 'pi-hypr-agent-monitor', 'status.json');
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'pi-hypr-agent-monitor', 'status.json');
}

/**
 * Write the status file atomically.
 * @param {StatusData} status
 * @returns {Promise<void>}
 */
async function writeStatusFile(status) {
  // Only write if the feature gate is enabled
  if (process.env.PI_HYPR_MONITOR !== '1') {
    return;
  }

  const filePath = getStatusFilePath();
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    // Write atomically: temp file then rename
    const tempFilePath = filePath + '.tmp';
    await fs.writeFile(tempFilePath, JSON.stringify(status, null, 2));
    await fs.rename(tempFilePath, filePath);
  } catch (err) {
    // Silently fail - don't want to crash Pi if we can't write the status file
    console.error('Failed to write Pi status file:', err);
  }
}

/**
 * Remove the status file.
 * @returns {Promise<void>}
 */
async function removeStatusFile() {
  // Only remove if the feature gate is enabled
  if (process.env.PI_HYPR_MONITOR !== '1') {
    return;
  }

  const filePath = getStatusFilePath();
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // Ignore if file doesn't exist
    if (err.code !== 'ENOENT') {
      console.error('Failed to remove Pi status file:', err);
    }
  }
}

/**
 * Update the status based on state transition.
 * @param {'working'|'waiting'|'idle'} newState
 */
async function updateStatus(newState) {
  if (process.env.PI_HYPR_MONITOR !== '1') {
    return;
  }

  const now = Math.floor(Date.now() / 1000); // Unix seconds

  const status = {
    state: newState,
    pid: process.pid,
    session_id: sessionId,
    cwd: sessionCwd,
    model: model ?? 'unknown',
    updated_at: now,
  };

  await writeStatusFile(status);
}

/**
 * Generate a simple session ID (timestamp + random)
 */
function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Lifecycle event handlers
 */
let currentStatus = null;
let sessionId = '';
let sessionCwd = '';
let model = '';

// Called when a new session starts
pi.on('session_start', async () => {
  sessionId = generateSessionId();
  sessionCwd = process.cwd();
  await updateStatus('idle');
});

// Called when the agent starts working on a task
pi.on('agent_start', async () => {
  await updateStatus('working');
});

// Called when the agent has settled (no more queued tasks)
pi.on('agent_settled', async () => {
  await updateStatus('waiting');
});

// Called when a model is selected (e.g., switching from GPT-3.5 to Claude)
pi.on('model_select', async () => {
  // Only update the model field if we have a status file to update
  if (currentStatus) {
    // Force string conversion for model
    const newModel = typeof model === 'string' ? model : 'unknown';
    // Update the status with the new model
    const updatedStatus = {
      ...currentStatus,
      model: newModel,
    };
    await updateStatus(updatedStatus.state);
  }
});

// Called when the session is shutting down
pi.on('session_shutdown', async () => {
  await removeStatusFile();
});