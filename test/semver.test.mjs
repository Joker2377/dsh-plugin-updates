import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareVersions, highestMatching, parseVersion, parseRange, satisfies } from '../lib/semver.js'

test('compareVersions orders releases and prereleases', () => {
	assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
	assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.0'), 1)
	assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
	assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
	assert.equal(compareVersions('nope', '1.0.0'), undefined)
})

test('satisfies answers the shapes engines.dsh actually uses', () => {
	// The probes' real-world cases:
	assert.equal(satisfies('0.2.2-rc.1', '>=0.2.0-rc.2 <0.3.0-0'), true) // dsh-md-studio
	assert.equal(satisfies('0.2.2-rc.1', '<0.2.2-0'), false) // dsh-ops gate
	assert.equal(satisfies('0.2.1-rc.5', '0.1.7-rc.1 || 0.2.1-rc.5'), true) // mcp-registry list form
	assert.equal(satisfies('0.2.2-rc.1', '^0.2.1-rc.1 || ^0.2.0-rc.1'), true) // rich-ui peers
	assert.equal(satisfies('0.2.2-rc.1', '>=0.1.1-rc.2 <0.3.0'), true) // this bundle's own gate
})

test('caret and tilde on partials follow npm rules', () => {
	assert.equal(satisfies('1.4.9', '^1.2'), true)
	assert.equal(satisfies('2.0.0', '^1.2'), false)
	assert.equal(satisfies('0.2.9', '^0.2'), true)
	assert.equal(satisfies('0.3.0', '^0.2'), false)
	assert.equal(satisfies('1.2.9', '~1.2'), true)
	assert.equal(satisfies('1.3.0', '~1.2'), false)
})

test('hyphen ranges and wildcards parse', () => {
	assert.equal(satisfies('1.5.0', '1.2.3 - 2.0.0'), true)
	assert.equal(satisfies('2.0.1', '1.2.3 - 2.0.0'), false)
	assert.equal(satisfies('9.9.9', '*'), true)
})

test('parseRange distinguishes a broken range from an unmet one', () => {
	assert.equal(parseRange('>=1').valid, true)
	assert.equal(parseRange('>= ouch').valid, false)
	assert.equal(parseRange('').valid, false)
})

test('highestMatching picks the newest acceptable version', () => {
	const found = highestMatching(['0.3.14', '0.3.16', '0.4.0-rc.1', 'garbage'], '>=0.3.0')
	assert.equal(found, '0.4.0-rc.1')
	assert.equal(highestMatching(['1.0.0'], '^2.0.0'), undefined)
})

test('parseVersion keeps prerelease identifiers', () => {
	assert.deepEqual(parseVersion('0.2.2-rc.1').prerelease, ['rc', '1'])
	assert.equal(parseVersion('0.2.2').prerelease.length, 0)
})
