/** Remote id from a provider submit, flushed to the run record before the long poll. */
export interface RemoteTaskNote {
  provider: string;
  taskId: string;
  lastStatus: string;
  pollUrl?: string;
  calls: unknown;
  response: unknown;
}

/** Image submit returned something worth keeping before the file is on disk. */
export interface ImageResultNote {
  provider: string;
  outFile: string;
  url?: string;
  taskId?: string;
  received?: boolean;
  response?: unknown;
}

/** Args are lumen arguments, without the node binary or the cli script. */
export interface DetachSpawnSpec {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}

export interface IO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** One line from the user. Tests inject this. Defaults to stdin. */
  readLine?: () => Promise<string>;
  /**
   * Installed by the run recorder for the duration of a command.
   * Video submit calls this once a remote task id exists, before polling.
   */
  noteRemoteTask?: (note: RemoteTaskNote) => Promise<void>;
  /**
   * Installed by the run recorder. Image execute calls this once a provider
   * response (URL or task id) exists, before the file is written.
   */
  noteImageResult?: (note: ImageResultNote) => Promise<void>;
  /** Tests inject this. The default spawns a detached process. */
  spawnDetached?: (spec: DetachSpawnSpec) => { pid: number };
}

export function defaultIO(): IO {
  return {
    stdout: (chunk) => {
      process.stdout.write(chunk);
    },
    stderr: (chunk) => {
      process.stderr.write(chunk);
    },
    cwd: process.cwd(),
    env: process.env,
  };
}

export function line(io: IO, message = ""): void {
  io.stdout(`${message}\n`);
}

export function fail(io: IO, message: string): void {
  io.stderr(`${message}\n`);
}
