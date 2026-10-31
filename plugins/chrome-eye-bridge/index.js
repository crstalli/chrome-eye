// @local/chrome-eye-bridge
//
// Host-composition plugin that makes `dsh web` own the chrome-eye bridge.
// On boot it spawns `bridge.mjs` as a supervised child (a real process, so it
// lives in the dsh web process tree and is reaped on shutdown); on shutdown its
// ctx.effect disposer kills the child. A crash self-heals after a short delay.
//
// The bridge file itself is byte-unchanged — this only owns its lifecycle.
//
// Contract (mirrors dsh-host-webserver's WebServer):
//   - ESM default export, a Cordis Service subclass. The loader materializes it
//     as `new Plugin(ctx, config)` where `config` is the validated row `config:`
//     block (resolveConfig -> this.config, set before the ctor body runs).
//   - All side effects run inside ctx.effect so they are torn down with the
//     fiber (i.e. when `dsh web` exits), never leaking the child.
//   - Node builtins are available here: this is a bundle-resident package, not
//     dynamic-package sandbox code.

import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the plugin directory from import.meta.url, then find bridge.mjs
// relative to it. Falls back to config bridgePath.
const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveBridgePath(configBridgePath) {
  if (configBridgePath) return configBridgePath;
  // Resolve: plugins/chrome-eye-bridge/index.js -> plugins/ -> bridge/ -> bridge.mjs
  const relative = join(__dirname, '..', '..', 'bridge', 'bridge.mjs');
  if (existsSync(relative)) return relative;
  // Also try the flat layout (one level up)
  const flat = join(__dirname, '..', 'bridge.mjs');
  if (existsSync(flat)) return flat;
  // Return empty — the plugin will log and skip spawning
  return '';
}

function resolveNodeBinary(configNode) {
  if (configNode && existsSync(configNode)) return configNode;
  // Try common nvm paths
  const nvmPaths = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    join(process.env.HOME, '.nvm/versions/node/v24.19.0/bin/node'),
    join(process.env.HOME, '.nvm/versions/node/v22.18.0/bin/node'),
    join(process.env.HOME, '.nvm/versions/node/v20.18.0/bin/node'),
  ];
  for (const p of nvmPaths) {
    if (existsSync(p)) return p;
  }
  // Fall back to 'node' on PATH
  return 'node';
}

var ChromeEyeBridgeService = class extends Service {
  static Config = z
    .object({
      // Path to the (byte-unchanged) bridge script.
      bridgePath: z.string().default(''),
      // Node binary used to run it.
      node: z.string().default(''),
      // Bridge listen port (env CHROME_EYE_BRIDGE_PORT).
      port: z.natural().max(65535).default(Number(process.env.CHROME_EYE_BRIDGE_PORT) || 3081),
      // GUI port the bridge proxies to (env CHROME_EYE_GUI_PORT).
      guiPort: z.natural().max(65535).default(Number(process.env.CHROME_EYE_GUI_PORT) || 3080),
    })
    .default({});

  constructor(ctx, config) {
    super(ctx, "chromeEyeBridge");
    this.config = config;
    const c = this.config || {};
    this._bridgePath = resolveBridgePath(c.bridgePath);
    this._node = resolveNodeBinary(c.node);
    this._port = Number(c.port || process.env.CHROME_EYE_BRIDGE_PORT || 3081);
    this._guiPort = Number(c.guiPort || process.env.CHROME_EYE_GUI_PORT || 3080);
    this._child = null;
    this._stopped = false;
    this._restarting = false;

    // Set env var so tools plugin knows the bridge URL
    process.env.CHROME_EYE_BRIDGE_URL = `http://127.0.0.1:${this._port}`;

    this._log("host plugin loaded", {
      bridge: this._bridgePath,
      node: this._node,
      port: this._port,
      guiPort: this._guiPort,
      bridgeUrl: process.env.CHROME_EYE_BRIDGE_URL,
    });

    // The entire supervised lifecycle lives in one effect, so the disposer
    // (fiber teardown / `dsh web` shutdown) kills the child and cancels any
    // pending restart.
    this.ctx.effect(
      () => {
        if (!this._bridgePath || !existsSync(this._bridgePath)) {
          this._log("bridge path missing; not spawning", {
            bridge: this._bridgePath,
          });
          return () => {};
        }
        if (this._node !== 'node' && !existsSync(this._node)) {
          this._log("node binary missing; falling back to PATH 'node'", {
            node: this._node,
          });
        }
        this._spawn();
        return () => this._stop();
      },
      "chrome-eye-bridge",
    );
  }

  _log(msg, extra = {}) {
    try {
      const logger = this.ctx.root?.logger?.();
      if (logger) {
        logger("chrome-eye-bridge").info(msg, extra);
        return;
      }
    } catch {}
    console.log(`[chrome-eye-bridge] ${msg}`, JSON.stringify(extra));
  }

  _spawn() {
    if (this._stopped || this._child) return;
    const nodeBin = existsSync(this._node) ? this._node : "node";
    const child = spawn(nodeBin, [this._bridgePath], {
      env: {
        ...process.env,
        CHROME_EYE_BRIDGE_PORT: String(this._port),
        CHROME_EYE_GUI_PORT: String(this._guiPort),
        CHROME_EYE_BRIDGE_URL: `http://127.0.0.1:${this._port}`,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    this._child = child;
    this._log("spawned bridge child", {
      pid: child.pid,
      port: this._port,
      guiPort: this._guiPort,
    });

    child.on("error", (err) => {
      this._log("bridge spawn error", { message: err?.message });
      this._child = null;
      this._scheduleRestart();
    });

    child.on("exit", (code, signal) => {
      this._log("bridge child exited", { code, signal });
      this._child = null;
      if (!this._stopped) this._scheduleRestart();
    });

    child.on("close", () => {
      this._child = null;
    });
  }

  _scheduleRestart() {
    if (this._stopped || this._restarting) return;
    this._restarting = true;
    const t = setTimeout(() => {
      this._restarting = false;
      if (!this._stopped) this._spawn();
    }, RESTART_DELAY_MS);
    if (typeof t.unref === "function") t.unref();
  }

  _stop() {
    this._stopped = true;
    const child = this._child;
    this._child = null;
    if (!child) return;
    this._log("stopping bridge child", { pid: child.pid });
    try {
      child.kill("SIGTERM");
    } catch {}
    const killer = setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {}
    }, 2000);
    if (typeof killer.unref === "function") killer.unref();
    child.on("exit", () => clearTimeout(killer));
  }
};

// TTL for pending commands on the bridge (seconds).
const RESTART_DELAY_MS = 2000;

export { ChromeEyeBridgeService, ChromeEyeBridgeService as default };
