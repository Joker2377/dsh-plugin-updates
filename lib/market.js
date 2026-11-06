/**
 * The community plugin market indexes — the cheap first channel.
 *
 * Each configured index (an `index.json` following the plugin-market `format: 1`
 * shape) carries, per plugin, an array of version entries with `version`,
 * `publishTimestamp`, `source.type` and the `engines.dsh` range. One fetch per
 * index answers "what is the latest, and what does it require" for most
 * packages, so a scan reaches the registry only for the gaps.
 *
 * Indexes are third-party directories: their data is advisory. The verdict
 * still re-checks the gate from the entry's own `engines` string, and a missing
 * entry simply falls through to the registry channel.
 *
 * Results are cached in memory with a TTL — nothing is written to disk.
 *
 * @module dsh-plugin-updates/market
 */

export const DEFAULT_INDEX_URLS = [
	'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json',
	'https://dpharness.com/market/index.json',
]

const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Turn one index document into `name -> version entries`.
 * Malformed documents yield an empty map, not a throw.
 *
 * @param {unknown} doc
 * @returns {Map<string, Array<{ version: string, enginesDsh?: string, publishTimestamp?: number, sourceType?: string }>>}
 */
export function parseIndex(doc) {
	const map = new Map()
	if (!isPlainObject(doc) || !Array.isArray(doc.plugins)) return map
	for (const plugin of doc.plugins) {
		if (!isPlainObject(plugin) || typeof plugin.name !== 'string') continue
		if (!Array.isArray(plugin.versions)) continue
		const entries = []
		for (const version of plugin.versions) {
			if (typeof version === 'string') {
				entries.push({ version })
				continue
			}
			if (!isPlainObject(version) || typeof version.version !== 'string') continue
			entries.push({
				version: version.version,
				...(isPlainObject(version.engines) && typeof version.engines.dsh === 'string'
					? { enginesDsh: version.engines.dsh }
					: {}),
				...(Number.isFinite(version.publishTimestamp) ? { publishTimestamp: version.publishTimestamp } : {}),
				...(isPlainObject(version.source) && typeof version.source.type === 'string'
					? { sourceType: version.source.type }
					: {}),
			})
		}
		if (entries.length > 0) map.set(plugin.name, entries)
	}
	return map
}

/**
 * @param {object} [options]
 * @param {string[]} [options.urls]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 * @returns {{
 *   lookup: (name: string) => Promise<{ from: string, entries: Array<object> } | undefined>,
 *   stats: () => { hits: number, misses: number, loaded: Array<{ url: string, ok: boolean, reason?: string, plugins: number }> },
 *   reset: () => void,
 * }}
 */
export function createMarketCache({
	urls = DEFAULT_INDEX_URLS,
	fetch = globalThis.fetch,
	ttlMs = DEFAULT_TTL_MS,
	now = () => Date.now(),
} = {}) {
	/** @type {Map<string, Map<string, Array<object>>>} */
	const tables = new Map()
	/** @type {Map<string, Promise<void>>} */
	const loads = new Map()
	/** @type {Map<string, { ok: boolean, reason?: string, plugins: number }>} */
	const health = new Map()
	let loadedAt = 0
	let hasLoaded = false
	const stats = { hits: 0, misses: 0 }

	async function load(url) {
		if (!loads.has(url)) {
			const pending = (async () => {
				const init = typeof AbortSignal?.timeout === 'function' ? { signal: AbortSignal.timeout(20000) } : {}
				const response = await fetch(url, init)
				const status = Number(response?.status ?? 0)
				if (!(status >= 200 && status < 300)) throw new Error(`HTTP ${status}`)
				const doc = await response.json()
				tables.set(url, parseIndex(doc))
				health.set(url, { ok: true, plugins: tables.get(url).size })
			})()
			loads.set(url, pending)
			pending.catch((error) => {
				health.set(url, { ok: false, reason: error instanceof Error ? error.message : String(error), plugins: 0 })
			})
		}
		try {
			await loads.get(url)
		} catch {
			/* recorded in health */
		}
	}

	async function ensureLoaded() {
		if (!hasLoaded || now() - loadedAt > ttlMs) {
			loads.clear()
			tables.clear()
			health.clear()
			loadedAt = now()
			hasLoaded = true
		}
		await Promise.all(urls.map(load))
	}

	return {
		async lookup(name) {
			await ensureLoaded()
			for (const url of urls) {
				const table = tables.get(url)
				const entries = table?.get(String(name))
				if (entries !== undefined) {
					stats.hits += 1
					return { from: url, entries }
				}
			}
			stats.misses += 1
			return undefined
		},
		stats() {
			return {
				hits: stats.hits,
				misses: stats.misses,
				loaded: urls.map((url) => ({ url, ok: health.get(url)?.ok ?? false, reason: health.get(url)?.reason, plugins: health.get(url)?.plugins ?? 0 })),
			}
		},
		reset() {
			loads.clear()
			tables.clear()
			health.clear()
			loadedAt = 0
			hasLoaded = false
		},
	}
}
