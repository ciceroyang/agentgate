/** Locate an already installed npm CLI without invoking a platform shell/launcher.
 * This checks layout and package identity, not the authenticity of an operator's npm.
 * No npm installation, PATH script execution, or npm_execpath override is performed.
 */
import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, delimiter, basename, isAbsolute } from "node:path"

function absent(error) { return error?.code === "ENOENT" || error?.code === "ENOTDIR" }

export function findNpmCli({ execPath = process.execPath, path = process.env.PATH || "" } = {}) {
  const nodeDirectory = dirname(execPath)
  if (!isAbsolute(execPath)) throw new Error("Node executable path must be absolute")
  const directories = [nodeDirectory, ...path.split(delimiter).filter(item => isAbsolute(item))]
  const candidates = []
  for (const directory of directories) {
    // Windows official Node distribution, Unix prefixes, and a Unix npm symlink.
    candidates.push(join(directory, "node_modules/npm/bin/npm-cli.js"),
      join(directory, "../lib/node_modules/npm/bin/npm-cli.js"), join(directory, "npm"))
  }
  for (const candidate of [...new Set(candidates)]) {
    let cli
    try { cli = realpathSync(candidate) } catch (error) { if (absent(error)) continue; throw error }
    // Do not execute arbitrary wrappers such as npm.cmd or a shell function/script.
    if (basename(cli) !== "npm-cli.js" || basename(dirname(cli)) !== "bin") continue
    if (!statSync(cli).isFile()) continue
    let pkg, manifest
    try {
      manifest = realpathSync(join(dirname(cli), "../package.json"))
      if (!statSync(manifest).isFile()) continue
      pkg = JSON.parse(readFileSync(manifest, "utf8"))
    }
    catch (error) { if (absent(error) || error instanceof SyntaxError) continue; throw error }
    if (pkg?.name !== "npm" || typeof pkg.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version) ||
        pkg.bin?.npm !== "bin/npm-cli.js") continue
    try { if (realpathSync(join(dirname(manifest), pkg.bin.npm)) !== cli) continue }
    catch (error) { if (absent(error)) continue; throw error }
    return { cli, version: pkg.version }
  }
  throw new Error("Cannot locate an existing npm-cli.js beside Node or on PATH; install/select a standard Node + npm toolchain before package acceptance")
}

export function npmInvocation(npm, args, execPath = process.execPath) {
  return { command: execPath, args: [npm.cli, ...args] }
}
