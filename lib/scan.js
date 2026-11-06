/**
 * The scan: one row per installed bundle, with a verdict the agent can act on.
 *
 * Three channels feed it, cheapest first — the market indexes answer most
 * npm-sourced bundles in one fetch; the npm registry fills the gaps and every
 * gate that needs a manifest; `git ls-remote --tags` answers `github:` sources.
 * `link:` / `file:` sources have no upstream to ask and are labelled as local;
 * `@deepseek-ai/*` tracks the running version by definition.
 *
 * Everything external is injected (`market`, `registry`, `git`), so the whole
 * decision table is testable offline. Per-bundle failures become a row with
 * `verdict: 'channel_failed'`; the scan itself never throws because of one
 * unreachable index.
 *
 * @module dsh-plugin-updates/scan
 */

import { compareVersions, highestMatching, parseVersion } from './semver.js'
import { gateOf } from './registry.js'

const OFFICIAL_PREFIX = '@deepseek-ai/'

/**
 * Decide one npm-sourced bundle from registry-shaped version entries.
 *
 * @param {string} name
 * @param {{ raw: string, kind: string, version?: string }} dep
 * @param {Array<{ version: string, enginesDsh?: string, dshPeers?: Record<string, string> }>} versions
 * @param {string | undefined} distLatest registry dist-tags.latest (authoritative when present)
 * @param {string} runtimeVersion
 * @param {string} channel
 * @returns {object} one row
 */
export function decideNpm(name, dep, versions, distLatest, runtimeVersion, channel) {
	const installed = typeof dep?.version === 'string' ? dep.version : undefined
	const known = versions.filter((entry) => parseVersion(entry.version) !== undefined)
	const stable = known.filter((entry) => parseVersion(entry.version).prerelease.length === 0)
	const pool = stable.length > 0 ? stable : known
	const byVersion = (a, b) => (compareVersions(a.version, b.version) ?? 0)
	const sorted = [...pool].sort(byVersion)
	const highest = sorted.length > 0 ? sorted[sorted.length - 1] : undefined
	const latest = typeof distLatest === 'string' && parseVersion(distLatest) !== undefined ? distLatest : highest?.version
	const latestEntry = known.find((entry) => entry.version === latest) ?? highest

	const row = {
		name,
		source: 'npm',
		installed: installed ?? 'unknown',
		latest: latest ?? 'unknown',
		gate: 'na',
		spec: undefined,
		note: undefined,
		channel,
	}
	if (installed === undefined || latest === undefined || latestEntry === undefined) {
		row.verdict = 'unknown'
		if (row.note === undefined) row.note = '查不到已安裝版本或上游版本清單'
		return row
	}

	const gate = gateOf(latestEntry, runtimeVersion)
	row.gate = gate
	const order = compareVersions(latest, installed)
	const same = order === 0

	if (gate === 'ok' || gate === 'na') {
		if (channel === 'market' && latestEntry.enginesDsh === undefined) {
			// The market index omits engines; peers could still gate. Ask the registry.
			row.verdict = 'unknown'
			row.note = 'market index 條目沒有 engines，改查 registry'
			return row
		}
		if (same) {
			row.verdict = 'up_to_date'
			row.spec = `${name}@${installed}`
		} else {
			row.verdict = 'outdated'
			row.spec = `${name}@${latest}`
		}
		return row
	}

	// The newest release does not pass the gate: look for the newest one that does.
	const allowed = sorted.filter((entry) => gateOf(entry, runtimeVersion) === 'ok').map((entry) => entry.version)
	const bestAllowed = highestMatching(allowed, '*')
	row.gate = 'blocked'
	if (same) {
		row.verdict = 'installed_blocked'
		row.note = `最新版 ${latest} 的相容範圍在此 runtime 裝不上；若重裝會被擋，需 upstream 發新版或授權版本豁免`
		return row
	}
	if (bestAllowed !== undefined && (compareVersions(bestAllowed, installed) ?? 0) > 0) {
		row.verdict = 'behind_gate'
		row.spec = `${name}@${bestAllowed}`
		row.note = `最新版 ${latest} 被相容範圍擋住；先升到仍可裝的 ${bestAllowed}`
		return row
	}
	row.verdict = 'blocked_upstream'
	row.note = `最新版 ${latest} 的相容範圍不含此 runtime，且沒有更新的可用版本；等 upstream 或改用其他來源`
	return row
}

/**
 * github verdict: newer tag than what is installed?
 *
 * @param {string | undefined} installed
 * @param {{ version: string }} info
 * @returns {'outdated' | 'up_to_date' | 'unknown'}
 */
function githubVerdict(installed, info) {
	if (typeof installed !== 'string' || parseVersion(installed) === undefined) return 'unknown'
	return (compareVersions(info.version, installed) ?? 0) > 0 ? 'outdated' : 'up_to_date'
}

/**
 * Scan a profile.
 *
 * @param {object} input
 * @param {{ installed: boolean, reason?: string, dependencies: Record<string, any>, bundles: string[] }} input.profile
 * @param {string} input.runtimeVersion DSH version string, or 'unknown'
 * @param {{ lookup: (name: string) => Promise<{ from: string, entries: any[] } | undefined>, stats: () => object, reset?: () => void }} input.market
 * @param {{ info: (name: string) => Promise<any> }} input.registry
 * @param {{ latestTag: (spec: string) => Promise<any> }} input.git
 * @returns {Promise<{ ok: boolean, reason?: string, runtimeVersion: string, rows: object[], stats: object }>}
 */
export async function scanProfile({ profile, runtimeVersion, market, registry, git }) {
	if (profile.installed === false) {
		return { ok: false, reason: profile.reason ?? 'profile 不可讀', runtimeVersion, rows: [], stats: {} }
	}

	const rows = []
	const depNames = new Set(Object.keys(profile.dependencies))
	const declared = Object.entries(profile.dependencies)

	for (const [name, dep] of declared) {
		if (name.startsWith(OFFICIAL_PREFIX)) {
			rows.push({
				name,
				source: 'official',
				// Official bundles resolve with the app, so installed == runtime.
				installed: dep.version ?? runtimeVersion,
				latest: runtimeVersion,
				verdict: 'official',
				gate: 'na',
				spec: `${name}@${runtimeVersion}`,
				note: '官方 bundle 與執行中的 DSH 同版，免查上游',
				channel: 'runtime',
			})
			continue
		}
		if (dep.kind === 'link' || dep.kind === 'file') {
			rows.push({
				name,
				source: 'local',
				installed: dep.version ?? 'unknown',
				latest: undefined,
				verdict: 'local_source',
				gate: 'na',
				note: `來源 ${dep.raw} 指向本機，無 upstream 可查；更新取決於源目錄`,
				channel: 'none',
			})
			continue
		}
		if (dep.kind === 'github') {
			const info = await git.latestTag(dep.raw)
			if (info.ok !== true) {
				rows.push({
					name,
					source: 'git',
					installed: dep.version ?? 'unknown',
					latest: undefined,
					verdict: 'channel_failed',
					gate: 'na',
					note: info.reason,
					channel: 'git',
				})
				continue
			}
			rows.push({
				name,
				source: 'git',
				installed: dep.version ?? 'unknown',
				latest: info.version,
				verdict: githubVerdict(dep.version, info),
				gate: 'na',
				spec: `github:${info.owner}/${info.repo}#${info.tag}`,
				note: 'git tag 通道查得最新版；相容性於安裝時由 plugin_manager 判定',
				channel: 'git',
			})
			continue
		}
		// registry-sourced (npm) bundle
		const hit = await market.lookup(name)
		if (hit !== undefined) {
			const row = decideNpm(name, dep, hit.entries, undefined, runtimeVersion, 'market')
			if (row.verdict !== 'unknown') {
				rows.push(row)
				continue
			}
			// index entry lacked usable data — fall through to registry
		}
		const info = await registry.info(name)
		if (info.found !== true) {
			rows.push({
				name,
				source: 'npm',
				installed: dep.version ?? 'unknown',
				latest: undefined,
				verdict: 'channel_failed',
				gate: 'na',
				note: info.reason ?? 'registry 查不到這個套件',
				channel: 'registry',
			})
			continue
		}
		rows.push(decideNpm(name, dep, info.versions, info.latest, runtimeVersion, hit !== undefined ? 'market+registry' : 'registry'))
	}

	// Bundles the profile mounts without a dependency row are the official ones.
	for (const bundle of profile.bundles) {
		if (depNames.has(bundle)) continue
		rows.push({
			name: bundle,
			source: 'official',
			installed: runtimeVersion,
			latest: runtimeVersion,
			verdict: 'official',
			gate: 'na',
			note: '官方 bundle 與執行中的 DSH 同版',
			channel: 'runtime',
		})
	}

	const order = {
		outdated: 0,
		behind_gate: 1,
		installed_blocked: 2,
		blocked_upstream: 3,
		channel_failed: 4,
		unknown: 5,
		local_source: 6,
		up_to_date: 7,
		official: 8,
	}
	rows.sort((a, b) => (order[a.verdict] - order[b.verdict]) || a.name.localeCompare(b.name))
	return { ok: true, runtimeVersion, rows, stats: market.stats() }
}

/**
 * Render rows as compact text for the model.
 *
 * Actionable rows print in full; the quiet ones (`up_to_date`, `official`)
 * collapse to their names so a 35-bundle profile costs a few hundred tokens.
 *
 * @param {{ runtimeVersion: string, rows: object[], stats: object }} scan
 * @returns {string}
 */
export function renderScan(scan) {
	const lines = []
	const quiet = []
	lines.push(`runtime ${scan.runtimeVersion} · ${scan.rows.length} bundles`)
	const stats = scan.stats
	if (stats && typeof stats.hits === 'number') {
		const failed = (stats.loaded ?? []).filter((entry) => entry.ok !== true)
		lines.push(`market cache: hit ${stats.hits} / miss ${stats.misses}${failed.length > 0 ? ` · index 失敗 ${failed.length}（走 registry）` : ''}`)
	}
	for (const row of scan.rows) {
		if (row.verdict === 'up_to_date' || row.verdict === 'official') {
			quiet.push(row.verdict === 'official' ? `${row.name}=${row.installed}` : row.name)
			continue
		}
		const arrow = row.latest === undefined ? '' : ` ${row.installed} → ${row.latest}`
		const spec = row.spec === undefined ? '' : ` spec: ${row.spec}`
		const note = row.note === undefined ? '' : ` (${row.note})`
		lines.push(`${row.verdict.toUpperCase().padEnd(16)} ${row.name}${arrow}${spec}${note}`)
	}
	if (quiet.length > 0) lines.push(`up to date (${quiet.length}): ${quiet.join(', ')}`)
	return lines.join('\n')
}

/**
 * Render the per-package drill-down.
 *
 * @param {string} name
 * @param {{ found: boolean, reason?: string, latest?: string, versions?: object[], indexFrom?: string }} info
 * @param {string} runtimeVersion
 * @param {number} [limit]
 * @returns {string}
 */
export function renderPackage(name, info, runtimeVersion, limit = 20) {
	if (info.found !== true) return `package ${name}: 查無資料 — ${info.reason ?? 'unknown'}`
	const sorted = [...(info.versions ?? [])].sort((a, b) => (compareVersions(b.version, a.version) ?? 0))
	const lines = [`package ${name} · runtime ${runtimeVersion}${info.latest ? ` · dist-tags.latest ${info.latest}` : ''}`]
	for (const entry of sorted.slice(0, limit)) {
		const gate = gateOf(entry, runtimeVersion)
		const engines = entry.enginesDsh === undefined ? 'engines 未宣告' : `engines.dsh ${entry.enginesDsh}`
		lines.push(`  ${entry.version.padEnd(14)} ${gate === 'ok' ? 'installable' : gate === 'blocked' ? 'BLOCKED  ' : gate === 'unknown' ? 'unknown  ' : 'no-gate  '} ${engines}`)
	}
	if (sorted.length > limit) lines.push(`  … 還有 ${sorted.length - limit} 個較舊版本（list 已截斷）`)
	return lines.join('\n')
}
