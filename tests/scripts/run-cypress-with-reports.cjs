const path = require("path");
const { spawn } = require("child_process");

const projectRoot = path.resolve(__dirname, "..", "..");

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

function parseArgs(argv) {
  const parsed = {
    headed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--headed") {
      parsed.headed = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      parsed[key] = value;
      index += 1;
    }
  }

  return parsed;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const resolved = getCommand(command, args);
    const env = { ...process.env };
    if (command === "npx") {
      delete env.ELECTRON_RUN_AS_NODE;
    }

    const child = spawn(resolved.command, resolved.args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
      env,
    });

    child.on("error", () => {
      resolve({ code: 1 });
    });

    child.on("exit", (code) => {
      resolve({ code: code ?? 1 });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const envArgs = [
    `ENVIRONMENT=${options.environment ?? "DEV"}`,
    options.baseUrl ? `baseUrl=${options.baseUrl}` : null,
  ]
    .filter(Boolean)
    .join(",");

  const cypressArgs = [
    "cypress",
    "run",
    "--config-file",
    "tests/cypress.config.cjs",
    "--expose",
    envArgs,
    "--env",
    envArgs,
  ];

  if (options.spec) {
    cypressArgs.push("--spec", options.spec);
  }

  if (options.headed) {
    cypressArgs.push("--headed");
  }

  const cypressResult = await runCommand("npx", cypressArgs);

  if (cypressResult.code !== 0) {
    process.exitCode = cypressResult.code;
    return;
  }

  const reportResult = await runCommand("npm", ["run", "report:generate"]);
  process.exitCode = reportResult.code;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
