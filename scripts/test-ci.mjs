import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeFlags = ['--experimental-strip-types', '--test', '--test-concurrency=1', '--test-reporter=tap']
const locationPatterns = [
  /^\s*location: '(.+?):\d+:\d+'\s*$/gm,
  /^\s*test at (.+?):\d+:\d+\s*$/gm,
]

/** Run explicit test files serially, preserving TAP output and the child exit status. */
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

/** Extract unique in-repository test filenames from TAP diagnostics for diagnostic retries. */
export function failedTestFiles(output, from = root) {
  const files = new Set()
  for (const pattern of locationPatterns) {
    for (const [, location] of output.matchAll(pattern)) {
      try {
        const path = location.startsWith('file:') ? fileURLToPath(location) : resolve(from, location)
        const file = relative(from, path).replaceAll('\\', '/')
        if (/^tests\/[^/]+\.test\.mjs$/.test(file)) files.add(file)
      } catch {
        // Malformed diagnostic locations are not executable test paths.
      }
    }
  }
  return [...files]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allFiles = readdirSync(resolve(root, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => `tests/${name}`)

  if (allFiles.length === 0) {
    console.error('No test files found. CI cannot validate an empty suite.')
    process.exit(1)
  }

  const first = await runTests(allFiles)
  if (first.code === 0) process.exit(0)

  const failed = failedTestFiles(first.output)
  if (failed.length === 0) process.exit(1)

  console.log(`\nRetrying ${failed.length} test file(s) after a first failure: ${failed.join(' ')}\n`)
  const retry = await runTests(failed)
  if (retry.code !== 0) {
    console.log('\nRetry failed. Both runs failed for the files above.')
    process.exit(1)
  }
  console.log('\nRetries passed, but CI remains failed. Fix the first-run failure; retries are diagnostic only.')
  process.exitCode = 1
}
