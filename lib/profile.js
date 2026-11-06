/**
 * What the profile has installed, read read-only.
 *
 * The profile's `package.json` records the declared spec per bundle
 * (`1.3.3`, `^0.4.4`, `github:owner/repo`, `link:C:\…`, `file:…tgz`); the
 * concrete version on disk comes from `node_modules/<name>/package.json`, or
 * from the pointed-at directory for `link:` / `file:` specs. A missing profile
 * is a value (`installed: false`), never an exception, so a scan degrades to a
 * readable error line instead of a stack trace.
 *
 * @module dsh-plugin-updates/profile
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Prefix -> kind. */
const KIND_PREFIXES = [
	['link:', 'link'],
	['file:', 'file'],
	['github:', 'github'],
]

/** Kinds whose version comes from the directory they point at. */
const LOCAL_KINDS = new Set(['link', 'file'])

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a JSON file, tolerating every way it can be absent.
 *
 * @param {string} path
 * @returns {Promise<Record<string, any> | undefined>}
 */
async function readJsonObject(path) {
	try {
		const info = await stat(path)
		if (!info.isFile()) return undefined
		const parsed = JSON.parse(await readFile(path, 'utf8'))
		return isPlainObject(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * Find the profile manifest: `dir/package.json`, or the single child directory
 * that has one (callers pass either a profile dir or the dir holding profiles).
 * Two candidates are ambiguous and reported as absent, not guessed.
 *
 * @param {string} dir
 * @returns {Promise<{ manifestPath: string, manifest: Record<string, any> } | { ambiguous: string[] } | undefined>}
 */
async function locateManifest(dir) {
	const directPath = join(dir, 'package.json')
	const direct = await readJsonObject(directPath)
	if (direct !== undefined) return { manifestPath: directPath, manifest: direct }

	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return undefined
	}
	const candidates = []
	const children = []
	for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
		const manifestPath = join(dir, entry, 'package.json')
		const manifest = await readJsonObject(manifestPath)
		children.push(entry)
		if (manifest !== undefined) candidates.push({ manifestPath, manifest })
	}
	if (candidates.length === 1) return candidates[0]
	if (candidates.length > 1) return { ambiguous: candidates.map((c) => dirname(c.manifestPath)) }
	return { ambiguous: children }
}

/**
 * @param {string} raw
 * @returns {'range' | 'link' | 'file' | 'github'}
 */
function kindOf(raw) {
	const text = raw.trim().toLowerCase()
	for (const [prefix, kind] of KIND_PREFIXES) {
		if (text.startsWith(prefix)) return /** @type {any} */ (kind)
	}
	return 'range'
}

/**
 * Resolve the directory a `link:` / `file:` spec points at.
 *
 * @param {string} root profile directory
 * @param {string} raw spec with prefix
 * @returns {string}
 */
function localTarget(root, raw) {
	const text = raw.trim()
	const body = text.slice(text.indexOf(':') + 1).replace(/\\/g, '/')
	return isAbsolute(body) ? resolve(body) : resolve(root, body)
}

/**
 * Read a profile directory.
 *
 * @param {string} dir
 * @returns {Promise<{
 *   root: string,
 *   installed: boolean,
 *   reason?: string,
 *   dependencies: Record<string, { raw: string, kind: string, version?: string, resolvedPath?: string }>,
 *   bundles: string[],
 * }>}
 */
export async function readProfile(dir) {
	const target = resolve(String(dir ?? '.'))
	const located = await locateManifest(target)

	if (located === undefined) {
		return { root: target, installed: false, reason: `找不到 profile package.json：${target}`, dependencies: {}, bundles: [] }
	}
	if ('ambiguous' in located) {
		return {
			root: target,
			installed: false,
			reason: `${target} 下有多個目錄但無法判定哪一個是 profile（${located.ambiguous.join(', ')}）：請傳 profileDir。`,
			dependencies: {},
			bundles: [],
		}
	}

	const root = dirname(located.manifestPath)
	const manifest = located.manifest
	const dependencies = {}
	const declared = isPlainObject(manifest.dependencies) ? manifest.dependencies : {}
	for (const [name, raw] of Object.entries(declared)) {
		const spec = typeof raw === 'string' ? raw : String(raw)
		const kind = kindOf(spec)
		/** @type {{ raw: string, kind: string, version?: string, resolvedPath?: string }} */
		const entry = { raw: spec, kind }
		if (LOCAL_KINDS.has(kind)) {
			const resolvedPath = localTarget(root, spec)
			entry.resolvedPath = resolvedPath
			const localManifest = await readJsonObject(join(resolvedPath, 'package.json'))
			if (typeof localManifest?.version === 'string') entry.version = localManifest.version
		} else {
			const installedManifest = await readJsonObject(join(root, 'node_modules', name, 'package.json'))
			if (typeof installedManifest?.version === 'string') entry.version = installedManifest.version
		}
		dependencies[name] = entry
	}

	const profileSection = isPlainObject(manifest.dsh) && isPlainObject(manifest.dsh.profile) ? manifest.dsh.profile : {}
	const bundles = Array.isArray(profileSection.bundles)
		? profileSection.bundles.filter((value) => typeof value === 'string')
		: []

	return { root, installed: true, dependencies, bundles }
}
