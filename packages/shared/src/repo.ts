/**
 * Git hosts whose owner and repo names ignore case: github.com/Owner/Repo and github.com/owner/repo
 * are the same repo there. Only hosts known for certain to do this are listed. On every other host
 * (GitLab, a self-hosted server, a local path) the path's case is kept, so two repos that differ
 * only in case never count as one.
 */
export const CASE_INSENSITIVE_REPO_HOSTS: readonly string[] = ["github.com"];

const absolutePath = (value: string) => value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);

function identity(host: string, path: string): string | undefined {
  const h = host.toLowerCase();
  const clean = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!h || !clean || /[?#\s]/.test(clean)) return undefined;
  return `${h}/${CASE_INSENSITIVE_REPO_HOSTS.includes(h) ? clean.toLowerCase() : clean}`;
}

/**
 * One repo identity for everything that compares repos: the project's stored repo, the checkouts a
 * machine reports, a job's checks before it fetches or pushes, and the repos a Claude routine covers.
 * "git@github.com:Owner/Repo.git", "https://github.com/Owner/Repo" and "github.com/Owner/Repo" all
 * give "github.com/owner/repo" (GitHub ignores case). "https://git.example.com/Team/Repo" gives
 * "git.example.com/Team/Repo": its case is kept. A host name's case never matters. A local repo is
 * its absolute path, case kept ("/srv/git/Repo"). Undefined when it isn't a repo address.
 *
 * serverForm: also take the bare "host/path" form the server stores. Off for an address Git uses,
 * where "github.com/a/b" would be a relative path on this machine, not GitHub.
 */
export function repoIdentity(remote: string, options: { serverForm?: boolean } = {}): string | undefined {
  const value = remote.trim();
  if (!value) return undefined;
  if (absolutePath(value)) {
    const path = value.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
    return path || undefined;
  }
  const bare = options.serverForm ? /^([\w.-]+(?::\d+)?)\/([^\s?#]+)$/.exec(value) : null;
  // The server's form with a port (host:8443/path) would otherwise read as Git's host:path form.
  if (bare && /^[\w.-]+:\d+\//.test(value)) return identity(bare[1]!, bare[2]!);
  const scp = /^(?:[^@/:]+@)?([\w.-]+):([^/].*)$/.exec(value);
  if (scp) return identity(scp[1]!, scp[2]!);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!["ssh:", "git:", "http:", "https:"].includes(url.protocol) || url.search || url.hash) return undefined;
      return identity(url.host, decodeURIComponent(url.pathname));
    } catch {
      return undefined;
    }
  }
  return bare ? identity(bare[1]!, bare[2]!) : undefined;
}

/** Whether two repo addresses name the same repo (see repoIdentity). */
export function sameRepo(a: string, b: string, options: { serverForm?: boolean } = {}): boolean {
  const x = repoIdentity(a, options);
  return x !== undefined && x === repoIdentity(b, options);
}
