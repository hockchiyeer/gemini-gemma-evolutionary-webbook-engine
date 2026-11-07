const http = require("http");
const https = require("https");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const baseUrl = "http://localhost:3000";

function getCommand(name, args) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", name, ...args],
    };
  }

  return {
    command: name,
    args,
  };
}

function probeUrl(targetUrl) {
  return new Promise((resolve) => {
    const url = new URL(targetUrl);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        timeout: 3000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 500);
      }
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });

    request.on("error", () => {
      resolve(false);
    });

    request.end();
  });
}

async function waitForUrl(targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Reuse an already-running server when present to avoid port conflicts.
    if (await probeUrl(targetUrl)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const resolved = getCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
      env: process.env,
    });

    child.on("error", () => {
      resolve({ code: 1 });
    });

    child.on("exit", (code) => {
      resolve({ code: code ?? 1 });
    });
  });
}

function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }

  serverProcess.kill("SIGTERM");
}

async function main() {
  let serverProcess = null;
  let startedHere = false;

  try {
    const serverAlreadyRunning = await waitForUrl(baseUrl, 1500);

    if (!serverAlreadyRunning) {
      startedHere = true;
      const startCommand = getCommand("npm", ["run", "dev:test"]);
      serverProcess = spawn(startCommand.command, startCommand.args, {
        cwd: projectRoot,
        stdio: "inherit",
        shell: false,
        env: process.env,
      });

      const isReady = await waitForUrl(baseUrl, 120000);

      if (!isReady) {
        throw new Error(`Timed out waiting for ${baseUrl}`);
      }
    }

    const result = await runCommand("npm", ["run", "cy:run:local"]);
    process.exitCode = result.code;
  } finally {
    if (startedHere) {
      stopServer(serverProcess);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
