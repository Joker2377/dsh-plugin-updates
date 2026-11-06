/**
 * Fake-ctx tests: what `apply` registers, and that disabling unregisters.
 * No DSH install needed — `defineTool` falls back to identity outside the app.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name } from '../lib/index.js'

function fakeCtx() {
	const registered = new Map()
	let disposerCount = 0
	return {
		registered,
		disposerCount: () => disposerCount,
		effect(fn) {
			const cleanup = fn()
			if (typeof cleanup === 'function') disposerCount += 1
			return cleanup
		},
		tools: {
			register(tool) {
				if (registered.has(tool.name)) throw new Error(`double registration of ${tool.name}`)
				registered.set(tool.name, tool)
				return () => registered.delete(tool.name)
			},
		},
	}
}

test('entry exports the identity DSH loads by', () => {
	assert.equal(name, 'dsh-plugin-updates')
	assert.deepEqual(inject, ['tools'])
})

test('apply registers exactly one tool named plugin_updates', () => {
	const ctx = fakeCtx()
	apply(ctx)
	assert.deepEqual([...ctx.registered.keys()], ['plugin_updates'])
})

test('disabling the plugin unregisters the tool — reload cannot double-register', () => {
	const ctx = fakeCtx()
	const cleanup = apply(ctx)
	assert.equal(typeof cleanup, 'function', 'apply must return the effect cleanup')
	cleanup()
	assert.equal(ctx.registered.size, 0)
	apply(ctx)
	assert.equal(ctx.registered.size, 1)
})

test('the tool definition is serialisable and declares its parameters', () => {
	const ctx = fakeCtx()
	apply(ctx)
	const tool = ctx.registered.get('plugin_updates')
	assert.equal(typeof tool.name, 'string')
	assert.ok(tool.description.includes('plugin_manager'), 'description routes installing to plugin_manager')
	assert.ok(tool.parameters.action.required)
	assert.deepEqual(tool.parameters.action.enum, ['scan', 'package'])
	JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	})
})
