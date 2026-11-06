#!/usr/bin/env node
// Shape check for this DSH bundle repo: manifest targets, patch insert, README
// sections, and files coverage. Runs before `npm test` in CI — it is the only
// defence against "installs broken but every unit test was green".
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = process.cwd()
const errors = []
const warnings = []
const read = (p) => readFileSync(resolve(root, p), 'utf8')
const fail = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

const pkg = JSON.parse(read('package.json'))

// --- manifest ---------------------------------------------------------------
if (!/^dsh-[a-z0-9-]+$/.test(pkg.name)) fail(`package.json name "${pkg.name}" should be dsh-<purpose>`)
if (pkg.type !== 'module') fail('package.json type must be "module"')
if (!pkg.version) fail('package.json version is missing')
if (!pkg.files?.length) fail('package.json files is empty; the tarball would be nearly empty')
if (!pkg.dsh?.bundle?.patch) fail('package.json dsh.bundle.patch is missing; DSH will not load this bundle')
if (!(pkg.keywords ?? []).includes('dsh-plugin')) warn('keywords should include "dsh-plugin"')
if (!existsSync(resolve(root, 'LICENSE'))) warn('LICENSE is missing')
if (!pkg.engines?.dsh) warn('engines.dsh is missing; compatibility would fall to the peer rule')

// Every export target and the entry file must exist, or the bundle cannot load.
const targets = new Set()
if (pkg.main) targets.add(pkg.main)
const exportsField = pkg.exports
if (typeof exportsField === 'string') targets.add(exportsField)
else if (exportsField && typeof exportsField === 'object') {
	for (const value of Object.values(exportsField)) {
		if (typeof value === 'string') targets.add(value)
		else if (value && typeof value === 'object') for (const v of Object.values(value)) if (typeof v === 'string') targets.add(v)
	}
}
for (const target of targets) if (!existsSync(resolve(root, target))) fail(`exports target does not exist: ${target}`)

// files must cover every runtime file the manifest points at.
const norm = (path) => path.replace(/^\.\//, '').replace(/\/$/, '')
const listed = (pkg.files ?? []).map(norm)
for (const raw of targets) {
	const target = norm(raw)
	if (target === 'package.json') continue
	const ok = listed.some((f) => target === f || target.startsWith(`${f}/`) || (f.includes('*') && target.startsWith(f.split('*')[0])))
	if (!ok) fail(`files does not cover runtime file: ${raw}`)
}

// --- patch ------------------------------------------------------------------
const patchPath = pkg.dsh?.bundle?.patch
if (patchPath && existsSync(resolve(root, patchPath))) {
	const patch = read(patchPath)
	if (!/^\s*-\s*insert:/m.test(patch)) fail(`${patchPath} has no insert row; the bundle would install as a no-op`)
	const ids = [...patch.matchAll(/\bid:\s*([^\s]+)/g)].map((m) => m[1])
	if (new Set(ids).size !== ids.length) fail(`${patchPath} repeats an insert id`)
	if (/config:/.test(patch) && !/export const Config/.test(read('lib/index.js'))) {
		fail('patch passes config but lib/index.js does not export Config; the config would be dropped')
	}
}

// --- README -----------------------------------------------------------------
const REQUIRED_SECTIONS = ['功能', '安裝', '使用', '疑難排解', '運作原理', '開發', '已知限制']
const readme = existsSync(resolve(root, 'README.md')) ? read('README.md') : ''
if (!readme) fail('README.md is missing')
else {
	for (const section of REQUIRED_SECTIONS) if (!readme.includes(`## ${section}`)) fail(`README.md is missing section: ## ${section}`)
	if (!/https:\/\/github\.com\/[^/\s]+\/[^/\s#?]+(?:[#?][^\s)]*)?\s*$/m.test(readme)) warn('README install section should contain a repository home URL')
}

// --- no live endpoints in tests ----------------------------------------------
const testDir = resolve(root, 'test')
if (existsSync(testDir)) {
	for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.mjs'))) {
		const body = read(join('test', file))
		if (/https:\/\/registry\.npmjs\.org|https:\/\/cdn\.jsdelivr\.net|https:\/\/dpharness\.com/.test(body) && !/\/\/ ok: url appears in fixtures only/.test(body)) {
			if (/fetch\(\s*['"`]https/.test(body)) fail(`test/${file} fetches a live endpoint; inject a fake instead`)
		}
	}
}

// --- artifacts --------------------------------------------------------------
for (const entry of readdirSync(root)) if (entry.endsWith('.tgz')) warn(`*.tgz in the repo root: ${entry} belongs in a GitHub release, not in git`)

// --- report -----------------------------------------------------------------
for (const w of warnings) console.warn(`warn  ${w}`)
for (const e of errors) console.error(`error ${e}`)
if (errors.length) process.exit(1)
console.log(`ok    ${pkg.name}@${pkg.version} — ${warnings.length} warning(s)`)
