import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withStagedTarball } from '../src/staged-tarball.mjs'

test('staging supports Windows short-name tilde while preserving exact bytes and cleanup', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ag-stage-test-'))
  try {
    const root = join(fixture, 'RUNNER~1')
    mkdirSync(root)
    const bytes = Buffer.from('synthetic archive bytes')
    const result = withStagedTarball(bytes, file => {
      assert.deepEqual(readFileSync(file), bytes)
      return 'installed synthetic fixture'
    }, root)
    assert.equal(result, 'installed synthetic fixture')
    assert.deepEqual(readdirSync(root), [])
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
