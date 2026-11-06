/**
 * Semver range evaluation for plugin manifests.
 *
 * DSH answers one question before it installs a bundle: does this plugin's
 * `engines.dsh` — or, when it has none, every `@deepseek-ai/dsh*` peer — accept
 * the running DSH version? It does that with
 * `semver.satisfies(version, range, { includePrerelease: true })`, so
 * prereleases take part in ranges. This module reproduces that answer without
 * pulling in a dependency.
 *
 * Supported: `=` `>` `>=` `<` `<=`, the `^` and `~` shorthands, partial versions
 * (`1`, `1.2`, `1.x`), space-separated comparator sets, `||` alternatives,
 * hyphen ranges (`1.2.3 - 2.0.0`) and `*` / `x` wildcards.
 * Not supported: build metadata (ignored).
 *
 * @module dsh-plugin-updates/semver
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/
const COMPARATOR_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/
const HYPHEN_RE = /^(\S+)\s+-\s+(\S+)$/

/**
 * Parse one version, keeping the exact prerelease identifiers.
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | undefined}
 */
export function parseVersion(text) {
	const match = VERSION_RE.exec(String(text ?? '').trim())
	if (!match) return undefined
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? [] : match[4].split('.'),
	}
}

/**
 * Compare two prerelease identifier lists, semver 11.4 order.
 *
 * @param {string[]} left
 * @param {string[]} right
 * @returns {-1 | 0 | 1}
 */
function comparePrerelease(left, right) {
	if (left.length === 0 && right.length === 0) return 0
	if (left.length === 0) return 1
	if (right.length === 0) return -1
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const a = left[index]
		const b = right[index]
		if (a === undefined) return -1
		if (b === undefined) return 1
		const aNumeric = /^\d+$/.test(a)
		const bNumeric = /^\d+$/.test(b)
		if (aNumeric && bNumeric) {
			const delta = Number(a) - Number(b)
			if (delta !== 0) return delta < 0 ? -1 : 1
			continue
		}
		if (aNumeric) return -1
		if (bNumeric) return 1
		if (a !== b) return a < b ? -1 : 1
	}
	return 0
}

/**
 * Compare two versions. Accepts raw strings or parsed versions.
 *
 * @param {string | object} left
 * @param {string | object} right
 * @returns {-1 | 0 | 1 | undefined} undefined when either side is not a version
 */
export function compareVersions(left, right) {
	const a = typeof left === 'string' ? parseVersion(left) : left
	const b = typeof right === 'string' ? parseVersion(right) : right
	if (!a || !b) return undefined
	for (const key of ['major', 'minor', 'patch']) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
	}
	return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Expand one range token into the comparators it means.
 *
 * @param {string} token
 * @returns {Array<{ op: string, version: object }> | undefined}
 */
function expandToken(token) {
	const match = COMPARATOR_RE.exec(token)
	if (!match) return undefined
	const op = match[1] ?? '='
	const body = match[2].trim()
	if (body === '*' || body === 'x' || body === 'X') return []
	const partial = parsePartial(body)
	if (!partial) return undefined
	const lower = floor(partial)
	if (partial.precision === 3) {
		if (op === '^') return [{ op: '>=', version: lower }, { op: '<', version: caretUpper(partial) }]
		if (op === '~') return [{ op: '>=', version: lower }, { op: '<', version: bump(partial, 1) }]
		return [{ op, version: lower }]
	}
	switch (op) {
		case '^':
			return [{ op: '>=', version: lower }, { op: '<', version: caretUpper(partial) }]
		case '~':
		case '=':
			return [{ op: '>=', version: lower }, { op: '<', version: bump(partial, partial.precision - 1) }]
		case '>=':
			return [{ op: '>=', version: lower }]
		case '>':
			return [{ op: '>=', version: bump(partial, partial.precision - 1) }]
		case '<':
			return [{ op: '<', version: lower }]
		case '<=':
			return [{ op: '<', version: bump(partial, partial.precision - 1) }]
		default:
			return undefined
	}
}

/**
 * Parse a possibly partial version: `1`, `1.2`, `1.x`, `1.2.3-rc.1`.
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], precision: number } | undefined}
 */
export function parsePartial(text) {
	const match = PARTIAL_RE.exec(String(text ?? '').trim())
	if (!match) return undefined
	const groups = [match[1], match[2], match[3]]
	const parts = []
	let precision = 3
	for (let index = 0; index < 3; index += 1) {
		const group = groups[index]
		if (group === undefined || group === 'x' || group === 'X' || group === '*') {
			precision = Math.min(precision, index)
			parts.push(0)
		} else {
			parts.push(Number(group))
		}
	}
	if (match[4] !== undefined) precision = 3
	return {
		major: parts[0],
		minor: parts[1],
		patch: parts[2],
		prerelease: match[4] === undefined ? [] : match[4].split('.'),
		precision,
	}
}

/**
 * @param {{ major: number, minor: number, patch: number, prerelease: string[] }} partial
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] }}
 */
function floor(partial) {
	return { major: partial.major, minor: partial.minor, patch: partial.patch, prerelease: partial.prerelease }
}

/**
 * The version just past the component at `index`.
 *
 * @param {{ major: number, minor: number, patch: number }} partial
 * @param {number} index 0 major, 1 minor, 2 patch
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] }}
 */
function bump(partial, index) {
	const next = { major: partial.major, minor: partial.minor, patch: partial.patch, prerelease: [] }
	if (index <= 0) {
		next.major += 1
		next.minor = 0
		next.patch = 0
	} else if (index === 1) {
		next.minor += 1
		next.patch = 0
	} else {
		next.patch += 1
	}
	return next
}

/**
 * The exclusive upper bound of a caret range, npm's rule on partials.
 *
 * @param {{ major: number, minor: number, patch: number, precision: number }} partial
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] }}
 */
function caretUpper(partial) {
	if (partial.major > 0) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }
	if (partial.precision === 1) return { major: 1, minor: 0, patch: 0, prerelease: [] }
	if (partial.minor > 0) return { major: 0, minor: partial.minor + 1, patch: 0, prerelease: [] }
	if (partial.precision === 2) return { major: 0, minor: 1, patch: 0, prerelease: [] }
	return { major: 0, minor: 0, patch: partial.patch + 1, prerelease: [] }
}

/**
 * Expand a hyphen range (`1.2.3 - 2.0.0`) into comparators.
 *
 * @param {string} part one `||` branch
 * @returns {Array<{ op: string, version: object }> | undefined} undefined when not a hyphen range
 */
function expandHyphen(part) {
	const match = HYPHEN_RE.exec(part.trim())
	if (!match) return undefined
	const from = parsePartial(match[1])
	const to = parsePartial(match[2])
	if (!from || !to) return undefined
	const upper = to.precision === 3
		? [{ op: '<=', version: floor(to) }]
		: [{ op: '<', version: bump(to, to.precision - 1) }]
	return [{ op: '>=', version: floor(from) }, ...upper]
}

/**
 * Parse a range into alternatives of comparator sets.
 *
 * @param {unknown} range
 * @returns {{ valid: boolean, reason?: string, alternatives: Array<Array<{ op: string, version: object }>> }}
 */
export function parseRange(range) {
	const text = String(range ?? '').trim()
	if (text === '') return { valid: false, reason: 'empty range', alternatives: [] }
	const alternatives = []
	for (const part of text.split('||')) {
		const hyphen = expandHyphen(part)
		if (hyphen !== undefined) {
			alternatives.push(hyphen)
			continue
		}
		const tokens = part.trim().split(/\s+/).filter(Boolean)
		if (tokens.length === 0) return { valid: false, reason: 'blank || branch', alternatives: [] }
		const comparators = []
		for (const token of tokens) {
			const expanded = expandToken(token)
			if (expanded === undefined) {
				return { valid: false, reason: `unparsable comparator ${JSON.stringify(token)}`, alternatives: [] }
			}
			comparators.push(...expanded)
		}
		alternatives.push(comparators)
	}
	return { valid: true, alternatives }
}

/**
 * Does `version` fall inside `range`? Prereleases participate, as they do in DSH.
 *
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
	const target = parseVersion(version)
	const parsed = parseRange(range)
	if (!target || !parsed.valid) return false
	for (const comparators of parsed.alternatives) {
		let matched = true
		for (const { op, version: bound } of comparators) {
			const order = compareVersions(target, bound)
			const failed =
				op === '>=' ? order < 0
					: op === '<=' ? order > 0
						: op === '>' ? order <= 0
							: op === '<' ? order >= 0
								: order !== 0
			if (failed) {
				matched = false
				break
			}
		}
		if (matched) return true
	}
	return false
}

/**
 * Highest version in `candidates` that `range` accepts.
 *
 * @param {string[]} candidates
 * @param {string} range
 * @returns {string | undefined}
 */
export function highestMatching(candidates, range) {
	let best
	let bestVersion
	for (const candidate of candidates) {
		const parsed = parseVersion(candidate)
		if (parsed === undefined) continue
		if (!satisfies(candidate, range)) continue
		if (best === undefined || compareVersions(parsed, bestVersion) > 0) {
			best = candidate
			bestVersion = parsed
		}
	}
	return best
}
