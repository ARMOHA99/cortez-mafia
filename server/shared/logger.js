// server/shared/logger.js
function timestamp() {
    return new Date().toISOString();
}

function log(...args) {
    console.log(`[${timestamp()}]`, ...args);
}

function warn(...args) {
    console.warn(`[${timestamp()}] ⚠️`, ...args);
}

function error(...args) {
    console.error(`[${timestamp()}] ❌`, ...args);
}

function flushSync() {
    try {
        [process.stdout, process.stderr].forEach((stream) => {
            if (stream && stream._handle && typeof stream._handle.setBlocking === 'function') {
                stream._handle.setBlocking(true);
            }
        });
    } catch (e) {}
}

module.exports = { log, warn, error, flushSync };
