import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideNpm, renderPackage, renderScan, scanProfile } from '../lib/scan.js'

const RUNTIME = '0.2.2-rc.1'

function fakeMarket(entries) {
	return {
		async lookup(name) {
			return entries[name] === undefined ? undefined : { from: 'https://index.test', entries: entries[name] }
		},
		stats: () => ({ hits: 0, misses: 0, loaded: [] }),
	}
}

function fakeRegistry(bundles) {
	return {
		async info(name) {
			const entry = bundles[name]
			if (entry === undefined) return { found: false, reason: `registry 找不到套件 ${name}` }
			return entry
		},
	}
}

function fakeGit(tags) {
	return {
		async latestTag(spec) {
			const hit = tags[spec]
			return hit === undefined ? { ok: false, reason: `git ls-remote 失敗：${spec}` } : { ok: true, ...hit }
		},
	}
}

test('decideNpm: newer version whose gate accepts is outdated with a spec', () => {
	const row = decideNpm(
		'dsh-md-studio',
		{ raw: '1.3.3', kind: 'range', version: '1.3.3' },
		[
			{ version: '1.3.3', enginesDsh: '>=0.2.0-rc.2 <0.3.0-0' },
			{ version: '1.3.4', enginesDsh: '>=0.2.0-rc.2 <0.3.0-0' },
		],
		'1.3.4',
		RUNTIME,
		'registry',
	)
	assert.equal(row.verdict, 'outdated')
	assert.equal(row.gate, 'ok')
	assert.equal(row.spec, 'dsh-md-studio@1.3.4')
})

test('decideNpm: installed equals latest passes the gate is up_to_date', () => {
	const row = decideNpm(
		'dsh-free-search',
		{ raw: '0.9.32', kind: 'range', version: '0.9.32' },
		[{ version: '0.9.32', enginesDsh: '>=0.1.0' }],
		'0.9.32',
		RUNTIME,
		'registry',
	)
	assert.equal(row.verdict, 'up_to_date')
	assert.equal(row.spec, 'dsh-free-search@0.9.32')
})

test('decideNpm: newest blocked but an older release installs is behind_gate', () => {
	const row = decideNpm(
		'dsh-example',
		{ raw: '1.0.0', kind: 'range', version: '1.0.0' },
		[
			{ version: '1.0.0', enginesDsh: '>=0.1.0 <0.3.0-0' },
			{ version: '1.1.0', enginesDsh: '>=0.1.0 <0.3.0-0' },
			{ version: '2.0.0', enginesDsh: '<0.2.2-0' },
		],
		'2.0.0',
		RUNTIME,
		'registry',
	)
	assert.equal(row.verdict, 'behind_gate')
	assert.equal(row.gate, 'blocked')
	assert.equal(row.spec, 'dsh-example@1.1.0')
	assert.match(row.note, /被相容範圍擋住/)
})

test('decideNpm: installed equals latest but the gate rejects is installed_blocked', () => {
	const row = decideNpm(
		'dsh-ops',
		{ raw: '^0.4.4', kind: 'range', version: '0.4.4' },
		[{ version: '0.4.4', enginesDsh: '<0.2.2-0' }],
		'0.4.4',
		RUNTIME,
		'registry',
	)
	assert.equal(row.verdict, 'installed_blocked')
	assert.match(row.note, /裝不上/)
})

test('decideNpm: behind with nothing newer installable is blocked_upstream', () => {
	const row = decideNpm(
		'dsh-mcp-registry',
		{ raw: '0.3.14', kind: 'range', version: '0.3.14' },
		[
			{ version: '0.3.14', enginesDsh: '>=0.1.0-rc.2 <0.2.1-rc.6' },
			{ version: '0.3.16', enginesDsh: '>=0.1.0-rc.2 <0.2.1-rc.6' },
		],
		'0.3.16',
		RUNTIME,
		'registry',
	)
	assert.equal(row.verdict, 'blocked_upstream')
})

test('decideNpm: no engines falls to peers; neither present is not a gate', () => {
	const byPeer = decideNpm(
		'peer-gated',
		{ raw: '1.0.0', kind: 'range', version: '1.0.0' },
		[{ version: '2.0.0', dshPeers: { '@deepseek-ai/dsh-tools': '<0.2.2-0' } }],
		'2.0.0',
		RUNTIME,
		'registry',
	)
	assert.equal(byPeer.gate, 'blocked')

	const noGate = decideNpm(
		'no-gate',
		{ raw: '1.0.0', kind: 'range', version: '1.0.0' },
		[{ version: '1.5.0', dshPeers: {} }],
		'1.5.0',
		RUNTIME,
		'registry',
	)
	assert.equal(noGate.verdict, 'outdated')
	assert.equal(noGate.gate, 'na')
})

test('scanProfile classifies every source kind in one pass', async () => {
	const profile = {
		installed: true,
		dependencies: {
			'npm-outdated': { raw: '1.0.0', kind: 'range', version: '1.0.0' },
			'npm-blocked': { raw: '0.4.4', kind: 'range', version: '0.4.4' },
			'github-src': { raw: 'github:someone/dsh-browser', kind: 'github', version: '0.5.7' },
			'linked-one': { raw: 'link:C:/repo/linked-one', kind: 'link', version: '0.1.0' },
			'@deepseek-ai/dsh-base': { raw: '0.2.2-rc.1', kind: 'range', version: undefined },
		},
		bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
	}
	const result = await scanProfile({
		profile,
		runtimeVersion: RUNTIME,
		market: fakeMarket({
			'npm-outdated': [
				{ version: '1.0.0', enginesDsh: '>=0.1.0' },
				{ version: '1.1.0', enginesDsh: '>=0.1.0' },
			],
		}),
		registry: fakeRegistry({
			'npm-blocked': { found: true, latest: '0.4.4', versions: [{ version: '0.4.4', enginesDsh: '<0.2.2-0' }] },
		}),
		git: fakeGit({ 'github:someone/dsh-browser': { tag: 'v0.6.0', version: '0.6.0', owner: 'someone', repo: 'dsh-browser' } }),
	})

	assert.equal(result.ok, true)
	const byName = new Map(result.rows.map((row) => [row.name, row]))
	assert.equal(byName.get('npm-outdated').verdict, 'outdated')
	assert.equal(byName.get('npm-outdated').channel, 'market')
	assert.equal(byName.get('npm-blocked').verdict, 'installed_blocked')
	assert.equal(byName.get('github-src').verdict, 'outdated')
	assert.equal(byName.get('github-src').spec, 'github:someone/dsh-browser#v0.6.0')
	assert.equal(byName.get('linked-one').verdict, 'local_source')
	assert.equal(byName.get('@deepseek-ai/dsh-base').verdict, 'official')
	assert.equal(byName.get('@deepseek-ai/dsh-base').spec, `@deepseek-ai/dsh-base@${RUNTIME}`)
	// mounted bundle with no dependency row still gets a row, and no name is duplicated
	assert.equal(byName.get('@deepseek-ai/dsh-web-app').source, 'official')
	assert.equal(result.rows.length, new Set(result.rows.map((row) => row.name)).size)
})

test('scanProfile: an unreachable channel yields channel_failed, not a throw', async () => {
	const profile = {
		installed: true,
		dependencies: {
			'gone-npm': { raw: '1.0.0', kind: 'range', version: '1.0.0' },
			'gone-git': { raw: 'github:x/y', kind: 'github', version: '0.1.0' },
		},
		bundles: [],
	}
	const result = await scanProfile({
		profile,
		runtimeVersion: RUNTIME,
		market: fakeMarket({}),
		registry: fakeRegistry({}),
		git: fakeGit({}),
	})
	const byName = new Map(result.rows.map((row) => [row.name, row]))
	assert.equal(byName.get('gone-npm').verdict, 'channel_failed')
	assert.equal(byName.get('gone-git').verdict, 'channel_failed')
})

test('scanProfile: market index without engines falls through to the registry', async () => {
	const profile = { installed: true, dependencies: { 'index-plain': { raw: '1.0.0', kind: 'range', version: '1.0.0' } }, bundles: [] }
	const result = await scanProfile({
		profile,
		runtimeVersion: RUNTIME,
		market: fakeMarket({ 'index-plain': [{ version: '2.0.0' }] }),
		registry: fakeRegistry({ 'index-plain': { found: true, latest: '2.0.0', versions: [{ version: '2.0.0', enginesDsh: '<0.2.2-0' }] } }),
		git: fakeGit({}),
	})
	const row = result.rows[0]
	assert.equal(row.verdict, 'blocked_upstream')
	assert.equal(row.channel, 'market+registry')
})

test('scanProfile: unreadable profile is a value, not an exception', async () => {
	const result = await scanProfile({
		profile: { installed: false, reason: '找不到', dependencies: {}, bundles: [] },
		runtimeVersion: RUNTIME,
		market: fakeMarket({}),
		registry: fakeRegistry({}),
		git: fakeGit({}),
	})
	assert.equal(result.ok, false)
	assert.match(result.reason, /找不到/)
})

test('renderScan keeps the quiet bundles on one line', () => {
	const text = renderScan({
		runtimeVersion: RUNTIME,
		stats: { hits: 3, misses: 1, loaded: [] },
		rows: [
			{ name: 'a', verdict: 'outdated', installed: '1.0.0', latest: '1.1.0', spec: 'a@1.1.0' },
			{ name: 'b', verdict: 'up_to_date', installed: '2.0.0', latest: '2.0.0' },
			{ name: 'c', verdict: 'official', installed: RUNTIME, latest: RUNTIME },
		],
	})
	assert.match(text, /OUTDATED\s+a 1\.0\.0 → 1\.1\.0 spec: a@1\.1\.0/)
	assert.match(text, /up to date \(2\): b, c=/)
	assert.ok(text.split('\n').length <= 4)
})

test('renderPackage lists gate verdicts per version and truncates', () => {
	const versions = Array.from({ length: 25 }, (_unused, index) => ({
		version: `1.${index}.0`,
		enginesDsh: index < 20 ? '>=0.1.0' : '<0.2.2-0',
	}))
	const text = renderPackage('pkg', { found: true, latest: '1.24.0', versions }, RUNTIME)
	assert.match(text, /package pkg · runtime 0\.2\.2-rc\.1 · dist-tags\.latest 1\.24\.0/)
	assert.match(text, /BLOCKED/)
	assert.match(text, /還有 5 個較舊版本/)
	assert.equal(renderPackage('gone', { found: false, reason: '404' }, RUNTIME), 'package gone: 查無資料 — 404')
})
