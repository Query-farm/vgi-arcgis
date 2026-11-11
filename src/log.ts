/**
 * Logging to stderr. stdout carries the Arrow protocol, so nothing here (or
 * anywhere in the worker) may write to it.
 *
 * The level comes from `--debug` / `--log-level LEVEL` (see cli.ts) or the
 * `LOG_LEVEL` environment variable; the default is `info`.
 */

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

let threshold: number = LEVELS.indexOf(parseLevel(process.env.LOG_LEVEL) ?? "info");

/** Parse a level name, or return undefined if it isn't one. */
export function parseLevel(value: string | undefined): LogLevel | undefined {
  const lower = value?.toLowerCase();
  return LEVELS.find((level) => level === lower);
}

/** Set the minimum level that is written. */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS.indexOf(level);
}

/** Query parameters and JSON keys whose values are credentials. */
const SECRET_PARAM = /([?&;\s]|^)(token|access_token|refresh_token|password|client_secret)=[^&\s"'#<>]*/gi;
const SECRET_JSON = /("(?:token|access_token|refresh_token|password|client_secret)"\s*:\s*)"[^"]*"/gi;

/**
 * `text` with every credential-looking query parameter (`token=...`,
 * `password=...`, `client_secret=...`) and JSON value replaced by
 * `<redacted>`. Applied to every log line and every ArcgisError message.
 */
export function redact(text: string): string {
  return text.replace(SECRET_PARAM, "$1$2=<redacted>").replace(SECRET_JSON, '$1"<redacted>"');
}

function write(level: LogLevel, message: string): void {
  if (LEVELS.indexOf(level) < threshold) return;
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}\n`);
}

export const log = {
  debug: (message: string): void => write("debug", message),
  info: (message: string): void => write("info", message),
  warn: (message: string): void => write("warn", message),
  error: (message: string): void => write("error", message),
};
