import { lstat, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'

export class DestinationError extends Error {
  constructor(message) { super(message); this.name = 'DestinationError' }
}

async function namedInputTarget(path, label) {
  let current = resolve(path)
  const seen = new Set()
  for (let hop = 0; hop < 40; hop += 1) {
    let parent
    try {
      parent = await realpath(dirname(current))
    } catch (error) {
      if (error.code === 'ENOENT') return current
      throw new DestinationError(`${label} input path could not be inspected.`)
    }
    const named = resolve(parent, basename(current))
    if (seen.has(named)) throw new DestinationError(`${label} input path has a symbolic-link cycle.`)
    seen.add(named)
    try {
      current = resolve(parent, await readlink(named))
    } catch (error) {
      if (error.code === 'EINVAL' || error.code === 'ENOENT') return named
      throw new DestinationError(`${label} input path could not be inspected.`)
    }
  }
  throw new DestinationError(`${label} input path has too many symbolic links.`)
}

// The named-input comparison is needed even when the destination has no inode:
// a dangling input link can become the report as soon as a new file is written.
export async function assertWritableDestination(destination, { inputs = [], root, label = '--report' } = {}) {
  const target = resolve(destination)
  let existing = null
  try { existing = await lstat(target) }
  catch (error) {
    if (error.code !== 'ENOENT') throw new DestinationError(`${label} could not be inspected.`)
  }
  if (existing !== null && existing.isSymbolicLink()) throw new DestinationError(`${label} is a symbolic link.`)
  if (existing !== null && !existing.isFile()) throw new DestinationError(`${label} is not a regular file.`)

  let parent
  try { parent = await realpath(dirname(target)) }
  catch { throw new DestinationError(`${label} parent directory does not exist.`) }
  if (root !== null && root !== undefined) {
    let base
    try { base = await realpath(resolve(root)) }
    catch { throw new DestinationError(`${label} root directory does not exist.`) }
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(`${label} resolves outside the declared root.`)
    }
  }

  const namedDestination = resolve(parent, basename(target))
  for (const input of inputs) {
    if (await namedInputTarget(input, label) === namedDestination) {
      throw new DestinationError(`${label} names an input path.`)
    }
  }
  if (existing === null) return target

  for (const input of inputs) {
    let source
    try { source = await stat(input) }
    catch { continue }
    if (source.dev === existing.dev && source.ino === existing.ino) {
      throw new DestinationError(`${label} is the same file as an input.`)
    }
  }
  return target
}
