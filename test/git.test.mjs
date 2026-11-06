import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGitLister, highestVersionTag, parseGithubSpec, parseLsRemoteTags } from '../lib/git.js'

test('parseLsRemoteTags dedupes peeled refs', () => {
	const stdout = [
		'aaa\trefs/tags/v0.5.6^{}',
		'bbb\trefs/tags/v0.5.6',
		'ccc\trefs/tags/v0.5.7^{}',
		'ddd\trefs/tags/nightly',
		'not a ref line',
	].join('\n')
	const tags = parseLsRemoteTags(stdout)
	assert.ok(tags.includes('v0.5.6'))
	assert.ok(tags.includes('v0.5.7'))
	assert.equal(tags.filter((tag) => tag === 'v0.5.6').length, 1)
})

test('highestVersionTag keeps semver-shaped tags only', () => {
	const best = highestVersionTag(['v0.5.7', 'v1.0.0-rc.2', 'nightly', 'legacy-2020'])
	assert.equal(best.tag, 'v1.0.0-rc.2')
	assert.equal(best.version, '1.0.0-rc.2')
	assert.equal(highestVersionTag(['nope']), undefined)
})

test('parseGithubSpec recognises the spellings profiles actually use', () => {
	assert.deepEqual(parseGithubSpec('github:wqty123/dsh-browser'), {
		owner: 'wqty123',
		repo: 'dsh-browser',
		url: 'https://github.com/wqty123/dsh-browser.git',
	})
	assert.equal(parseGithubSpec('github:Cjrrrrrrrr/dsh-plugins#path:/packages/dsh-scholar').owner, 'Cjrrrrrrrr')
	assert.deepEqual(parseGithubSpec('https://github.com/o/r'), parseGithubSpec('github:o/r'))
	assert.equal(parseGithubSpec('link:C:/somewhere'), undefined)
})

test('createGitLister turns runner failures into values', async () => {
	const ok = createGitLister({
		execFile: async () => ({ stdout: 'abc\trefs/tags/v0.5.7\n' }),
	})
	assert.deepEqual(await ok.latestTag('github:o/r'), {
		ok: true,
		tag: 'v0.5.7',
		version: '0.5.7',
		owner: 'o',
		repo: 'r',
	})

	const dead = createGitLister({
		execFile: async () => {
			throw new Error('git: command not found')
		},
	})
	const failed = await dead.latestTag('github:o/r')
	assert.equal(failed.ok, false)
	assert.match(failed.reason, /command not found/)

	const noTags = createGitLister({ execFile: async () => ({ stdout: '' }) })
	assert.equal((await noTags.latestTag('github:o/r')).ok, false)
})
