import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMarketCache, parseIndex } from '../lib/market.js'

const INDEX_DOC = {
	format: 1,
	plugins: [
		{
			name: 'dsh-md-studio',
			versions: [
				{ version: '1.3.3', publishTimestamp: 1, engines: { dsh: '>=0.2.0-rc.2 <0.3.0-0' }, source: { type: 'npm' } },
				{ version: '1.3.4', publishTimestamp: 2, engines: { dsh: '>=0.2.0-rc.2 <0.3.0-0' }, source: { type: 'npm' } },
			],
		},
		{ name: 'broken-shape' },
		{ name: 'plain-versions', versions: ['0.1.0'] },
	],
}

test('parseIndex extracts version entries and tolerates junk', () => {
	const map = parseIndex(INDEX_DOC)
	assert.equal(map.get('dsh-md-studio').length, 2)
	assert.equal(map.get('dsh-md-studio')[1].enginesDsh, '>=0.2.0-rc.2 <0.3.0-0')
	assert.equal(map.get('plain-versions')[0].version, '0.1.0')
	assert.equal(map.has('broken-shape'), false)
	assert.equal(parseIndex({}).size, 0)
	assert.equal(parseIndex(null).size, 0)
})

test('lookup merges indexes, hits before misses', async () => {
	let calls = 0
	const cache = createMarketCache({
		urls: ['https://a/index.json', 'https://b/index.json'],
		fetch: async (url) => {
			calls += 1
			if (String(url).includes('/a/')) return { ok: true, status: 200, json: async () => ({ plugins: [{ name: 'only-a', versions: [{ version: '1.0.0' }] }] }) }
			return { ok: true, status: 200, json: async () => INDEX_DOC }
		},
	})
	const hit = await cache.lookup('dsh-md-studio')
	assert.equal(hit.entries.length, 2)
	assert.ok(hit.from.includes('/b/'))
	assert.equal((await cache.lookup('only-a')).entries.length, 1)
	assert.equal(await cache.lookup('absent'), undefined)
	assert.equal(calls, 2, 'one fetch per index, cached after')
	const stats = cache.stats()
	assert.equal(stats.hits, 2)
	assert.equal(stats.misses, 1)
})

test('a dead index does not poison the other', async () => {
	const cache = createMarketCache({
		urls: ['https://dead/index.json', 'https://live/index.json'],
		fetch: async (url) => {
			if (String(url).includes('/dead/')) throw new Error('ECONNREFUSED')
			return { ok: true, status: 200, json: async () => INDEX_DOC }
		},
	})
	const hit = await cache.lookup('dsh-md-studio')
	assert.ok(hit, 'still found through the live index')
	const stats = cache.stats()
	assert.equal(stats.loaded.find((entry) => entry.url.includes('/dead/')).ok, false)
})

test('ttl expiry refetches; reset empties the cache', async () => {
	let nowMs = 0
	let calls = 0
	const cache = createMarketCache({
		urls: ['https://a/index.json'],
		ttlMs: 100,
		now: () => nowMs,
		fetch: async () => {
			calls += 1
			return { ok: true, status: 200, json: async () => INDEX_DOC }
		},
	})
	await cache.lookup('dsh-md-studio')
	await cache.lookup('dsh-md-studio')
	assert.equal(calls, 1)
	nowMs = 500
	await cache.lookup('dsh-md-studio')
	assert.equal(calls, 2, 'expired cache refetches')
	cache.reset()
	await cache.lookup('dsh-md-studio')
	assert.equal(calls, 3)
})

test('non-200 index responses are recorded as failures', async () => {
	const cache = createMarketCache({
		urls: ['https://a/index.json'],
		fetch: async () => ({ ok: false, status: 503 }),
	})
	assert.equal(await cache.lookup('anything'), undefined)
	assert.equal(cache.stats().loaded[0].ok, false)
})
