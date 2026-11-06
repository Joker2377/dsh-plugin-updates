/**
 * The git channel: newest release tag of a `github:` source.
 *
 * `git ls-remote --tags` answers without cloning or credentials; the runner is
 * injectable so tests never spawn a process. `^{}` peeled lines are preferred
 * over lightweight tag refs, and only `v?X.Y.Z`-shaped tags count — a repo may
 * carry `nightly` or `legacy` tags that mean nothing for an upgrade.
 *
 * @module dsh-plugin-updates/git
 */

import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

import { compareVersions, parseVersion } from './semver.js'

const execFileAsync = promisify(nodeExecFile)
const DEFAULT_TIMEOUT_MS = 20000

/**
 * Parse `git ls-remote --tags` stdout into tag names.
 *
 * @param {string} stdout
 * @returns {string[]} deduplicated tag names, peeled form preferred
 */
export function parseLsRemoteTags(stdout) {
	const names = new Set()
	for (const line of String(stdout ?? '').split(/\r?\n/)) {
		const match = /^\w+\s+refs\/tags\/(.+)$/.exec(line.trim())
		if (!match) continue
		if (match[1].endsWith('^{}')) names.add(match[1].slice(0, -3))
		else if (!names.has(match[1])) names.add(match[1])
	}
	return [...names]
}

/**
 * Pick the highest `v?X.Y.Z[-pre]` tag.
 *
 * @param {string[]} tags
 * @returns {{ tag: string, version: string } | undefined}
 */
export function highestVersionTag(tags) {
	let best
	for (const tag of tags) {
		if (parseVersion(tag) === undefined) continue
		if (best === undefined || compareVersions(tag, best.tag) > 0) best = { tag, version: tag.replace(/^v/, '') }
	}
	return best
}

/**
 * Owner/repo of a `github:owner/repo` spec (or its URL spellings).
 *
 * @param {string} spec
 * @returns {{ owner: string, repo: string, url: string } | undefined}
 */
export function parseGithubSpec(spec) {
	const text = String(spec ?? '').trim()
	const shorthand = /^github:([^#/]+)\/([^#/@]+)(?:[#/].*)?$/.exec(text)
	if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/, ''), url: `https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/, '')}.git` }
	const url = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#.]+)(?:\.git)?\/?(?:[#?].*)?$/.exec(text)
	if (url) return { owner: url[1], repo: url[2], url: `https://github.com/${url[1]}/${url[2]}.git` }
	return undefined
}

/**
 * @param {object} [options]
 * @param {(file: string, args: string[], opts: object) => Promise<{ stdout: string }>} [options.execFile]
 * @param {number} [options.timeoutMs]
 * @returns {{
 *   latestTag: (spec: string) => Promise<{ ok: true, tag: string, version: string, owner: string, repo: string } | { ok: false, reason: string }>,
 * }}
 */
export function createGitLister({ execFile = execFileAsync, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return {
		async latestTag(spec) {
			const repo = parseGithubSpec(spec)
			if (repo === undefined) return { ok: false, reason: `不是可辨識的 github 來源：${spec}` }
			try {
				const { stdout } = await execFile('git', ['ls-remote', '--tags', repo.url], { timeout: timeoutMs })
				const highest = highestVersionTag(parseLsRemoteTags(stdout))
				if (highest === undefined) return { ok: false, reason: `${repo.owner}/${repo.repo} 的 tags 裡沒有 vX.Y.Z 形式的版本` }
				return { ok: true, ...highest, owner: repo.owner, repo: repo.repo }
			} catch (error) {
				return { ok: false, reason: `git ls-remote ${repo.url} 失敗：${error instanceof Error ? error.message : String(error)}` }
			}
		},
	}
}
