import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeFlags = ['--experimental-strip-types', '--test', '--test-concurrency=1']
const locationLine = /^\s*location: '(.+?):\d+:\d+'\s*$/gm

function runTests(files) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [...nodeFlags, ...files], {
      cwd: root,
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      output += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code, output }))
  })
}

function failedFiles(output) {
  const files = new Set()
  for (const [, location] of output.matchAll(locationLine)) {
    files.add(relative(root, resolve(root, location)))
  }
  return [...files]
}

const allFiles = readdirSync(resolve(root, 'tests'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `tests/${name}`)

const first = await runTests(allFiles)
if (first.code === 0) process.exit(0)

const failed = failedFiles(first.output)
if (failed.length === 0) process.exit(1)

console.log(`\nRetrying ${failed.length} test file(s) after a first failure: ${failed.join(' ')}\n`)
const retry = await runTests(failed)
if (retry.code !== 0) {
  console.log('\nRetry failed. Both runs failed for the files above.')
  process.exit(1)
}
console.log('\nRetries passed. The first failure was flaky; see the log above.')
