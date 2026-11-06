/**
 * The one tool this bundle puts in front of the model: `plugin_updates`.
 *
 * Read-only by construction — it never installs, never writes the profile. The
 * install itself stays with `plugin_manager`, whose approval trail already
 * exists; this tool's job is the question plugin_manager cannot answer: which
 * bundles have a newer upstream, whether that newer version would pass the
 * runtime's compatibility gate, and the exact spec string to hand over.
 *
 * The three channels (market indexes, npm registry, git tags) are created at
 * module level so one host process reuses one in-memory index cache. Tests
 * inject fakes through `createUpdatesTool`.
 *
 * @module dsh-plugin-updates/tools
 */

import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'

import { createMarketCache } from './market.js'
import { createRegistryClient } from './registry.js'
import { createGitLister } from './git.js'
import { readProfile } from './profile.js'
import { renderPackage, renderScan, scanProfile } from './scan.js'

const { defineTool } = await import('@deepseek-ai/dsh-tools')
	.catch(() => ({ defineTool: (definition) => definition }))

const sharedMarket = createMarketCache()
const sharedRegistry = createRegistryClient()
const sharedGit = createGitLister()

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
	if (typeof value !== 'string') return undefined
	const text = value.trim()
	return text === '' ? undefined : text
}

/**
 * @param {object} [deps]
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {() => string} [deps.homedir]
 * @param {object} [deps.market]
 * @param {object} [deps.registry]
 * @param {object} [deps.git]
 * @returns {object} the `plugin_updates` tool definition
 */
export function createUpdatesTool({
	env = process.env,
	homedir = osHomedir,
	market = sharedMarket,
	registry = sharedRegistry,
	git = sharedGit,
} = {}) {
	return defineTool({
		name: 'plugin_updates',
		description: [
			'Report upstream updates for the bundles installed in the current DSH profile — use it before any plugin upgrade work ',
			'(and only as intelligence: it never installs). `action=scan` returns one verdict per bundle: outdated / behind_gate ',
			'(newer exists but the newest release would be rejected by engines.dsh for this runtime — the row carries the highest ',
			'installable spec) / blocked_upstream / installed_blocked / local_source / channel_failed, with quiet bundles collapsed. ',
			'`action=package` lists the versions of one npm package with each one`s engines.dsh gate, to pick a target. ',
			'Install with the returned spec via plugin_manager afterwards.',
		].join(''),
		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: ['scan', 'package'],
				description: 'scan = every installed bundle, one verdict row each; package = all versions of one npm package.',
			},
			name: {
				type: 'string',
				description: 'npm package name. Required for action=package.',
			},
			profileDir: {
				type: 'string',
				description: 'Profile directory. Defaults to ~/.dsh/profiles when it holds exactly one profile.',
			},
			hostVersion: {
				type: 'string',
				description: 'Running DSH version for the gate check. Defaults to the host DSH_VERSION; verdicts say "unknown" without it.',
			},
			refresh: {
				type: 'boolean',
				description: 'true re-fetches the market indexes, dropping the in-process cache (1 h TTL). Default false.',
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		timeoutMs: 60000,
		// Read-only: safe to run alongside other calls.
		isConcurrencySafe: () => true,
		async execute(args) {
			const action = optionalString(args?.action) ?? 'scan'
			if (action !== 'scan' && action !== 'package') {
				return `plugin_updates: action 只能是 scan 或 package，收到 ${JSON.stringify(action)}。`
			}
			const runtimeVersion = optionalString(args?.hostVersion) ?? env.DSH_VERSION ?? 'unknown'

			if (action === 'package') {
				const name = optionalString(args?.name)
				if (name === undefined) return 'plugin_updates: action=package 需要 name（npm 套件名）。'
				if (args?.refresh === true) market.reset()
				const info = await registry.info(name)
				if (info.found === true) return renderPackage(name, info, runtimeVersion)
				const hit = await market.lookup(name)
				if (hit === undefined) return renderPackage(name, info, runtimeVersion)
				return renderPackage(name, { found: true, versions: hit.entries }, runtimeVersion)
			}

			const profileDir = optionalString(args?.profileDir) ?? join(homedir(), '.dsh', 'profiles')
			if (args?.refresh === true) market.reset()
			const profile = await readProfile(profileDir)
			if (profile.installed === false) {
				const why = profile.reason ?? profileDir
				const suffix = String(why).includes('profileDir') ? '' : '；請傳 profileDir 指向含 package.json 的 profile 目錄'
				return `plugin_updates: 讀不到 profile — ${why}${suffix}`
			}
			const scan = await scanProfile({ profile, runtimeVersion, market, registry, git })
			if (scan.ok !== true) return `plugin_updates: 掃描失敗 — ${scan.reason ?? '未知原因'}`
			return `profile ${profile.root}\n${renderScan(scan)}`
		},
	})
}
