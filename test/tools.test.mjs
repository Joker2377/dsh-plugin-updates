/**
 * Tool-level end-to-end: a fake profile on disk (in a temp dir, never the user's
 * profile), fake channels injected, and the real `execute` behind it.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createUpdatesTool } from '../lib/tools.js'

async function makeProfileDir() {
	const root = await mkdtemp(join(tmpdir(), 'dsh-updates-'))
	const profile = join(root, 'desktop')
	await mkdir(join(profile, 'node_modules', 'md-studio'), { recursive: true })
	await mkdir(join(profile, 'node_modules', 'gh-thing'), { recursive: true })
	await writeFile(
		join(profile, 'package.json'),
		JSON.stringify({
			name: 'dsh-profile-test',
			dependencies: {
				'md-studio': '1.3.3',
				'gh-thing': 'github:someone/dsh-thing',
				'local-one': `link:${join(root, 'local-one').replace(/\\/g, '/')}`,
				'@deepseek-ai/dsh-base': '0.2.2-rc.1',
			},
			dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
		}),
	)
	await writeFile(join(profile, 'node_modules', 'md-studio', 'package.json'), JSON.stringify({ name: 'md-studio', version: '1.3.3' }))
	await writeFile(join(profile, 'node_modules', 'gh-thing', 'package.json'), JSON.stringify({ name: 'gh-thing', version: '0.5.7' }))
	await mkdir(join(root, 'local-one'), { recursive: true })
	await writeFile(join(root, 'local-one', 'package.json'), JSON.stringify({ name: 'local-one', version: '0.1.0' }))
	return { root, profile }
}

const fakeMarket = {
	async lookup(name) {
		if (name === 'md-studio') return { from: 'index', entries: [{ version: '1.3.4', enginesDsh: '>=0.2.0-rc.2 <0.3.0-0' }] }
		return undefined
	},
	stats: () => ({ hits: 1, misses: 0, loaded: [] }),
	reset() {},
}
const fakeRegistry = {
	async info() {
		return { found: false, reason: 'registry unreachable in test' }
	},
}
const fakeGit = {
	async latestTag() {
		return { ok: true, tag: 'v0.6.1', version: '0.6.1', owner: 'someone', repo: 'dsh-thing' }
	},
}

test('scan against a fake profile: every source kind answered, nothing thrown', async (t) => {
	const { root, profile } = await makeProfileDir()
	t.after(async () => {
		await rm(root, { recursive: true, force: true })
	})
	const tool = createUpdatesTool({
		env: { DSH_VERSION: '0.2.2-rc.1' },
		market: fakeMarket,
		registry: fakeRegistry,
		git: fakeGit,
	})
	const text = await tool.execute({ action: 'scan', profileDir: profile })
	assert.match(text, /OUTDATED\s+md-studio 1\.3\.3 → 1\.3\.4 spec: md-studio@1\.3\.4/)
	assert.match(text, /OUTDATED\s+gh-thing 0\.5\.7 → 0\.6\.1 spec: github:someone\/dsh-thing#v0\.6\.1/)
	assert.match(text, /LOCAL_SOURCE\s+local-one/)
	assert.match(text, /up to date .*@deepseek-ai\/dsh-base=0\.2\.2-rc\.1/)
})

test('missing profile is a readable line, not a crash', async () => {
	const tool = createUpdatesTool({
		env: {},
		market: fakeMarket,
		registry: fakeRegistry,
		git: fakeGit,
		homedir: () => 'Z:\\nowhere-at-all',
	})
	const text = await tool.execute({ action: 'scan' })
	assert.match(text, /讀不到 profile/)
	assert.match(text, /profileDir/)
})

test('bad parameters answer with usage hints instead of throwing', async () => {
	const tool = createUpdatesTool({ env: {}, market: fakeMarket, registry: fakeRegistry, git: fakeGit })
	assert.match(await tool.execute({ action: 'apply' }), /只能是 scan 或 package/)
	assert.match(await tool.execute({ action: 'package' }), /需要 name/)
})

test('package action falls from registry to the market index', async () => {
	const tool = createUpdatesTool({
		env: { DSH_VERSION: '0.2.2-rc.1' },
		market: fakeMarket,
		registry: fakeRegistry,
		git: fakeGit,
	})
	const text = await tool.execute({ action: 'package', name: 'md-studio' })
	assert.match(text, /1\.3\.4\s+installable\s+engines\.dsh >=0\.2\.0-rc\.2 <0\.3\.0-0/)
	const gone = await tool.execute({ action: 'package', name: 'absent-pkg' })
	assert.match(gone, /查無資料/)
})
