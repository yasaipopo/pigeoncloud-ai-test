'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { validateScenarios } = require('../lib/validate-catalog');

const valid = {
    id: 'auth-001', title: 'ログインできる', priority: 'P1',
    destructive: false, scope: 'local',
    steps: ['ログインする'],
    observations: ['URLが /admin/dashboard である [スクショ]'],
};

test('正しいシナリオはエラー0件', () => {
    assert.deepStrictEqual(validateScenarios([valid]), []);
});

test('必須キー欠落を検出する', () => {
    const { id, ...noId } = valid;
    const errors = validateScenarios([noId]);
    assert.ok(errors.some(e => e.includes('id')));
});

test('priority は P1/P2/P3 のみ', () => {
    const errors = validateScenarios([{ ...valid, priority: 'HIGH' }]);
    assert.ok(errors.some(e => e.includes('priority')));
});

test('scope は local/global のみ', () => {
    const errors = validateScenarios([{ ...valid, scope: 'world' }]);
    assert.ok(errors.some(e => e.includes('scope')));
});

test('observations の曖昧語（正常に等）を検出する', () => {
    const errors = validateScenarios([{ ...valid, observations: ['正常にログインできる'] }]);
    assert.ok(errors.some(e => e.includes('曖昧')));
});

test('id 重複を検出する', () => {
    const errors = validateScenarios([valid, { ...valid }]);
    assert.ok(errors.some(e => e.includes('重複')));
});

test('steps 空配列を検出する', () => {
    const errors = validateScenarios([{ ...valid, steps: [] }]);
    assert.ok(errors.some(e => e.includes('steps')));
});
