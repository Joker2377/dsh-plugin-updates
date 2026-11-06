/**
 * Ask an npm registry what a package's published versions declare, read-only.
 *
 * Two questions live here: which version is `latest`, and what does each
 * version's manifest say about compatibility (`engines.dsh`, or, when it has
 * none, the `@deepseek-ai/dsh*` peer ranges). One packument fetch per package
 * per client; failures surface as values, never stack traces that abort a scan.
 *
 * `fetch` is injectable so tests never touch the network. Every call carries an
 * `AbortSignal.timeout()` so a hung registry cannot hang the scan.
 *
 * @module dsh-plugin-updates/registry
 */

import { parseVersion, satisfies } from './semver.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 15000

/** Peer names that take part in DSH's compatibility answer. */
const DSH_PEER_RE = /^@deepseek-ai\/dsh/

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * npm keeps the `@` and encodes only the scope separator: `@scope%2Fname`.
 *
 * @param {string} name
 * @returns {string}
 */
function packagePath(name) {
	const text = String(name ?? '')
	if (text.startsWith('@')) return text.replace('/', '%2F')
	return encodeURIComponent(text)
}

/**
 * @param {object} manifest one version's manifest from the packument
 * @returns {{ enginesDsh?: string, dshPeers: Record<string, string> }}
 */
function compatibilityOf(manifest) {
	const engines = isPlainObject(manifest?.engines) ? manifest.engines : {}
	const peers = isPlainObject(manifest?.peerDependencies) ? manifest.peerDependencies : {}
	const dshPeers = {}
	for (const [peer, range] of Object.entries(peers)) {
		if (DSH_PEER_RE.test(peer) && typeof range === 'string') dshPeers[peer] = range
	}
	return {
		...(typeof engines.dsh === 'string' && engines.dsh !== '' ? { enginesDsh: engines.dsh } : {}),
		dshPeers,
	}
}

/**
 * Does the runtime version pass this version's gate?
 *
 * `engines.dsh` alone decides when present. Otherwise every `@deepseek-ai/dsh*`
 * peer range must accept the runtime. With neither, there is nothing to check.
 *
 * @param {{ enginesDsh?: string, dshPeers: Record<string, string> } & { version?: string }} entry
 * @param {string} runtimeVersion
 * @returns {'ok' | 'blocked' | 'unknown' | 'na'}
 */
export function gateOf(entry, runtimeVersion) {
	if (typeof entry?.enginesDsh === 'string') {
		if (!parseVersion(runtimeVersion)) return 'unknown'
		return satisfies(runtimeVersion, entry.enginesDsh) ? 'ok' : 'blocked'
	}
	const peers = entry?.dshPeers ?? {}
	const ranges = Object.values(peers)
	if (ranges.length === 0) return 'na'
	if (!parseVersion(runtimeVersion)) return 'unknown'
	return ranges.every((range) => satisfies(runtimeVersion, range)) ? 'ok' : 'blocked'
}

/**
 * Create a client bound to one registry and one `fetch`.
 *
 * @param {object} [options]
 * @param {string} [options.registry]
 * @param {typeof fetch} [options.fetch]
 * @param {number} [options.timeoutMs]
 * @returns {{
 *   registry: string,
 *   info: (name: string) => Promise<{
 *     found: boolean,
 *     reason?: string,
 *     latest?: string,
 *     versions: Array<{ version: string, enginesDsh?: string, dshPeers: Record<string, string> }>,
 *   }>,
 * }}
 */
export function createRegistryClient({ registry = DEFAULT_REGISTRY, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const base = String(registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
	/** @type {Map<string, Promise<object>>} */
	const packuments = new Map()

	/**
	 * @param {string} name
	 * @returns {Promise<object>}
	 */
	async function loadPackument(name) {
		const url = `${base}/${packagePath(name)}`
		const init = { headers: { accept: 'application/json' } }
		if (timeout > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			init.signal = AbortSignal.timeout(timeout)
		}
		let response
		try {
			response = await fetch(url, init)
		} catch (error) {
			throw new Error(`連不上 ${url}：${error instanceof Error ? error.message : String(error)}`)
		}
		const status = Number(response?.status ?? 0)
		if (status === 404) {
			const absent = new Error(`registry 找不到套件 ${name}`)
			/** @type {any} */ (absent).notFound = true
			throw absent
		}
		if (!(status >= 200 && status < 300)) throw new Error(`registry 回應 HTTP ${status}：${url}`)
		let body
		try {
			body = await response.json()
		} catch (error) {
			throw new Error(`${url} 的回應不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
		}
		if (!isPlainObject(body)) throw new Error(`${url} 的回應不是 packument 物件`)
		return body
	}

	return {
		registry: base,
		async info(name) {
			if (!packuments.has(String(name))) {
				const pending = loadPackument(name)
				packuments.set(String(name), pending)
				pending.catch(() => {
					if (packuments.get(String(name)) === pending) packuments.delete(String(name))
				})
			}
			let doc
			try {
				doc = await packuments.get(String(name))
			} catch (error) {
				const notFound = /** @type {any} */ (error)?.notFound === true
				return { found: false, reason: error instanceof Error ? error.message : String(error), ...(notFound ? { notFound: true } : {}) }
			}
			const versionsSection = isPlainObject(doc.versions) ? doc.versions : {}
			const distTags = isPlainObject(doc['dist-tags']) ? doc['dist-tags'] : {}
			const versions = Object.entries(versionsSection).map(([version, manifest]) => ({
				version,
				...compatibilityOf(manifest),
			}))
			const latest = typeof distTags.latest === 'string' && distTags.latest !== '' ? distTags.latest : undefined
			return { found: true, ...(latest === undefined ? {} : { latest }), versions }
		},
	}
}
