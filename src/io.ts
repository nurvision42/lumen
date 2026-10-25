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
