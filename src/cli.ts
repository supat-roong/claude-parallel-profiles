import { execFile } from 'child_process';
import { log } from './log';
import { readIdentity } from './accounts';
import { SECURE_ENV_VAR, keychainMode, slotEnvValue } from './platform';

/**
 * Thin wrapper around the `claude` CLI's auth commands, scoped to a specific
 * CLAUDE_CONFIG_DIR. This is the AUTHORITATIVE source of an account's identity:
 * `claude auth status` reflects the real OAuth token, so it can never disagree
 * with what Claude Code actually bills to (unlike reading .claude.json, whose
 * oauthAccount field can drift out of sync with the token).
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

/** A failed CLI run, keeping whatever the command printed before exiting. */
class CliError extends Error {
  constructor(message: string, readonly stdout = '') {
    super(message);
  }
}

/**
 * Runs a claude CLI command through a login shell so nvm/PATH resolve.
 *
 * `secureDir` pins the credential slot (keychain mode). Left undefined, the
 * slot is whatever this host's env already says — the window's own binding —
 * or, in keychain mode, the default slot: CLAUDE_CONFIG_DIR is always set here,
 * and without a slot of its own Claude Code would derive one from that path.
 */
function runClaude(
  args: string,
  dir: string,
  timeoutMs: number,
  secureDir?: string
): Promise<string> {
  const shell = process.env.SHELL || '/bin/bash';
  const slot =
    secureDir !== undefined
      ? slotEnvValue(secureDir)
      : process.env[SECURE_ENV_VAR] ?? (keychainMode() ? '' : undefined);
  return new Promise((resolve, reject) => {
    // execFile's own `timeout` sends SIGTERM, which a login shell can trap and
    // ignore — leaving the callback pending forever. Escalate to SIGKILL and
    // back it with our own hard timer so this promise ALWAYS settles.
    const child = execFile(
      shell,
      ['-lc', `claude ${args}`],
      {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: dir,
          ...(slot !== undefined ? { [SECURE_ENV_VAR]: slot } : {}),
        },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        clearTimeout(hardTimer);
        if (err) reject(new CliError(stderr?.toString() || err.message, stdout?.toString()));
        else resolve(stdout.toString());
      }
    );
    const hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new CliError(`claude ${args} timed out after ${timeoutMs}ms`));
    }, timeoutMs + 1000);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
  });
}

/**
 * Returns the authenticated account for a config dir, or null if the CLI call
 * fails or the dir isn't logged in. Never throws.
 */
export async function getAuthStatus(
  dir: string,
  timeoutMs = 15000
): Promise<AuthStatus | null> {
  let out: string;
  try {
    out = await runClaude('auth status --json', dir, timeoutMs);
  } catch (err) {
    // `auth status` exits 1 when signed out — but still prints its verdict. That
    // is an ANSWER ("signed out"), not a failure to ask; discarding it made the
    // status bar treat every signed-out dir as "claude CLI unreachable".
    const stdout = err instanceof CliError ? err.stdout.trim() : '';
    if (!stdout.startsWith('{')) {
      log(`auth status(${dir}) FAILED: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
    out = stdout;
  }
  try {
    const parsed = JSON.parse(out) as AuthStatus;
    // Recent Claude Code versions (2.1.x) return `email: null` from
    // `auth status --json` even when logged in via claude.ai. The email still
    // lives in the account's .claude.json (oauthAccount.emailAddress), so fall
    // back to it — otherwise every identity-dependent flow (capture, switch,
    // dedupe-by-email) silently bails out with "no signed-in account".
    if (parsed.loggedIn && !parsed.email) {
      const id = readIdentity(dir);
      if (id?.email) {
        parsed.email = id.email;
        if (!parsed.orgName && id.organizationName) parsed.orgName = id.organizationName;
      }
    }
    log(`auth status(${dir}): loggedIn=${parsed.loggedIn} email=${parsed.email ?? '(none)'}`);
    return parsed;
  } catch (err) {
    log(`auth status(${dir}) FAILED: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}

/**
 * Keychain mode: signs a credential slot out through Claude Code's own logout,
 * so Claude Code deletes its own Keychain entry — this extension never touches
 * the Keychain. `configDir` is the dir whose identity the logout clears too.
 * Returns false if the CLI could not be run. Never throws.
 */
export async function logoutSlot(
  secureDir: string,
  configDir: string,
  timeoutMs = 15000
): Promise<boolean> {
  try {
    await runClaude('auth logout', configDir, timeoutMs, secureDir);
    log(`auth logout(slot ${secureDir}): done`);
    return true;
  } catch (err) {
    log(`auth logout(slot ${secureDir}) FAILED: ${(err as Error).message.split('\n')[0]}`);
    return false;
  }
}
