import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const port = process.env.PORT || '3000';

function runCommand(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: port,
        DISABLE_HMR: 'true',
        ...extraEnv,
      },
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: npm ${args.join(' ')} (exit ${code ?? 'unknown'})`));
    });
  });
}

await runCommand(['run', 'build']);
await runCommand(['exec', 'vite', 'preview', '--host', '0.0.0.0', '--port', port, '--strictPort']);
