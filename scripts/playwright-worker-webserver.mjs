import { spawn } from 'node:child_process';
import http from 'node:http';

const port = Number(process.env.WORKER_HEALTH_PORT ?? '4299');
let ready = false;
let workerStarted = false;
let childExited = false;
let exitCode = 1;
let workerProcess;

const server = http.createServer((_request, response) => {
  if (ready && workerStarted && !childExited) {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ready');
    return;
  }

  response.writeHead(503, { 'content-type': 'text/plain' });
  response.end(childExited ? 'worker exited' : 'starting');
});

server.listen(port, '127.0.0.1');

function pipeWithReadyDetection(stream, output) {
  stream.on('data', (chunk) => {
    const text = chunk.toString();
    output.write(text);
    if (text.includes('TIXKIT_WORKER_READY')) {
      ready = true;
    }
  });
}

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, {
    env: process.env,
    stdio: options.pipe ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

async function runBuild() {
  await new Promise((resolve, reject) => {
    const build = spawnCommand('bun', ['run', '--filter', '@tixkit/workflows', 'build']);
    build.on('error', reject);
    build.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`workflow build exited with code ${code ?? 'null'}`));
    });
  });
}

async function runWorker() {
  await runBuild();

  workerStarted = true;
  const worker = spawnCommand('bun', ['run', '--filter', '@tixkit/workflows', 'start'], {
    pipe: true,
  });
  workerProcess = worker;

  pipeWithReadyDetection(worker.stdout, process.stdout);
  pipeWithReadyDetection(worker.stderr, process.stderr);

  worker.on('error', (err) => {
    childExited = true;
    console.error(err);
    process.exit(1);
  });
  worker.on('exit', (code) => {
    childExited = true;
    exitCode = code ?? 1;
    process.exit(exitCode);
  });
}

runWorker().catch((err) => {
  childExited = true;
  console.error(err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  workerProcess?.kill('SIGTERM');
  process.exit(exitCode);
});

process.on('SIGINT', () => {
  workerProcess?.kill('SIGINT');
  process.exit(exitCode);
});
