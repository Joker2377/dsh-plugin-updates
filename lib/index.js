/**
 * dsh-plugin-updates — read-only update intelligence for the agent.
 *
 * One tool, `plugin_updates`: per-bundle latest version, engines.dsh gate
 * verdict, and an install-ready spec, resolved from the community market
 * indexes, the npm registry, and git tags. It never installs and never writes
 * the profile; installing stays with plugin_manager.
 *
 * This file is the DSH entry: the patch insert names the package, the package
 * names `main`. The module exports identity and wiring only.
 */
import { createUpdatesTool } from './tools.js'

export const name = 'dsh-plugin-updates'

/** Needs the tool registry for `ctx.tools.register()`. */
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
	// Registered inside ctx.effect so disabling the plugin unregisters the tool
	// instead of leaving a stale entry after reload.
	return ctx.effect(() => {
		const unregister = ctx.tools.register(
			createUpdatesTool({
				// The host version comes from the installation anchor that
				// profileContext owns; the shell tools' DSH_INSTALL_DIR is a
				// per-execution overlay the host process never has.
				resolveInstallAnchor: () => ctx.get('profileContext')?.installAnchor,
			}),
		)
		return () => {
			if (typeof unregister === 'function') unregister()
		}
	})
}
