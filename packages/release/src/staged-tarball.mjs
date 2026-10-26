import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Synchronous, byte-identical staging for npm versions that reparse file paths as URLs.
 * Only the tarball moves: npm still installs and runs acceptance in the requested directory.
 * Never repack, decode a caller's path, change npm, or reuse/delete a pre-existing directory.
 */
export function withStagedTarball(bytes, install, temporaryRoot = tmpdir()) {
  const root = realpathSync(temporaryRoot)
  // Fail explicitly if even the staging root is unsuitable. Do not fall back to a
  // different drive/root or guess a decoded pathname. This is a release-tool boundary.
  if (!/^[A-Za-z0-9._:/\\-]+$/.test(root)) {
    throw new Error("npm tarball staging requires an ASCII temporary directory without spaces or URL metacharacters")
  }
  const directory = mkdtempSync(join(root, "agentgate-npm-stage-"))
  try {
    const tarball = join(directory, "package.tgz")
    writeFileSync(tarball, bytes, { flag: "wx", mode: 0o600 })
    if (!readFileSync(tarball).equals(bytes)) throw new Error("Staged tarball differs from the accepted bytes")
    return install(tarball)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
