import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeFlags = ['--experimental-strip-types', '--test', '--test-reporter=tap']
const locationPatterns = [
  /^\s*location: '(.+?):\d+:\d+'\s*$/gm,
  /^\s*test at (.+?):\d+:\d+\s*$/gm,
]

function runTests(files, concurrency = 2, shard) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [...nodeFlags, `--test-concurrency=${concurrency}`, ...(shard ? [`--test-shard=${shard}`] : []), ...files], {
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
  const { values } = parseArgs({ options: { 'test-shard': { type: 'string' } } })
  const allFiles = readdirSync(resolve(root, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => `tests/${name}`)

  if (allFiles.length === 0) {
    console.error('No test files found. CI cannot validate an empty suite.')
    process.exit(1)
  }

  const shard = values['test-shard']
  if (shard !== undefined) {
    const [index, total] = shard.split('/').map(Number)
    if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard) || index > total || total > allFiles.length) {
      console.error(`Invalid test shard "${shard}": expected INDEX/TOTAL with 1 <= INDEX <= TOTAL <= ${allFiles.length}.`)
      process.exit(1)
    }
  }

  const first = await runTests(allFiles, 2, shard)
  if (first.code === 0) process.exit(0)

  const failed = failedTestFiles(first.output)
  if (failed.length === 0) process.exit(1)

  console.log(`\nRetrying ${failed.length} test file(s) after a first failure: ${failed.join(' ')}\n`)
  const retry = await runTests(failed, 1)
  if (retry.code !== 0) {
    console.log('\nRetry failed. Both runs failed for the files above.')
    process.exit(1)
  }
  console.log('\nRetries passed, but CI remains failed. Fix the first-run failure; retries are diagnostic only.')
  process.exitCode = 1
}
