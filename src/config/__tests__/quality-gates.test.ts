import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateSkillName,
  normalizeGate,
  readQualityGatesConfig,
  readValidatedQualityGates,
  getGatesForStage,
  getAdvisoryGatesForStage,
  getBlockingGatesForStage,
  type QualityGateStage,
} from '../quality-gates.js';

describe('Quality Gates Configuration', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'omc-quality-gates-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  describe('validateSkillName', () => {
    it('accepts valid kebab-case skill names', () => {
      const valid = ['design-audit', 'security-review', 'my-custom-gate'];
      for (const name of valid) {
        const result = validateSkillName(name);
        assert.strictEqual(result.valid, true, `Expected '${name}' to be valid`);
      }
    });

    it('rejects invalid skill name formats', () => {
      const invalid = ['Design-Audit', 'design_audit', 'design audit', '123', '', 'design-.audit'];
      for (const name of invalid) {
        const result = validateSkillName(name);
        assert.strictEqual(result.valid, false, `Expected '${name}' to be invalid`);
        assert.ok(result.error);
      }
    });

    it('rejects reserved skill names', () => {
      const reserved = ['code-review', 'deep-interview', 'ralplan', 'plan', 'verification'];
      for (const name of reserved) {
        const result = validateSkillName(name);
        assert.strictEqual(result.valid, false, `Expected '${name}' to be reserved`);
        assert.match(result.error || '', /reserved/i);
      }
    });

    it('accepts skill names with leading $', () => {
      const result = validateSkillName('$design-audit');
      assert.strictEqual(result.valid, true);
    });
  });

  describe('normalizeGate', () => {
    it('normalizes string entries to blocking mode', () => {
      const gate = normalizeGate('design-audit');
      assert.deepEqual(gate, { skill: 'design-audit', mode: 'blocking' });
    });

    it('preserves mode in object entries', () => {
      const gate = normalizeGate({ skill: 'design-audit', mode: 'advisory' });
      assert.deepEqual(gate, { skill: 'design-audit', mode: 'advisory' });
    });

    it('defaults to blocking mode when not specified', () => {
      const gate = normalizeGate({ skill: 'design-audit' });
      assert.deepEqual(gate, { skill: 'design-audit', mode: 'blocking' });
    });

    it('preserves model override', () => {
      const gate = normalizeGate({ skill: 'design-audit', mode: 'advisory', model: 'claude-opus' });
      assert.deepEqual(gate, {
        skill: 'design-audit',
        mode: 'advisory',
        model: 'claude-opus',
      });
    });

    it('returns null for invalid entries', () => {
      assert.strictEqual(normalizeGate(['invalid'] as any), null);
      assert.strictEqual(normalizeGate(123 as any), null);
    });
  });

  describe('readQualityGatesConfig', () => {
    it('returns null when config file does not exist', () => {
      const result = readQualityGatesConfig(configDir);
      assert.strictEqual(result, null);
    });

    it('reads quality gates from omc.jsonc', () => {
      writeFileSync(
        join(configDir, 'omc.jsonc'),
        JSON.stringify({
          qualityGates: {
            plan: ['design-audit'],
            interview: ['requirements-validator'],
          },
        }),
      );

      const result = readQualityGatesConfig(configDir);
      assert.ok(result);
      assert.deepEqual(result.plan, ['design-audit']);
      assert.deepEqual(result.interview, ['requirements-validator']);
    });

    it('returns null when qualityGates is not an object', () => {
      writeFileSync(
        join(configDir, 'omc.jsonc'),
        JSON.stringify({
          qualityGates: 'not an object',
        }),
      );

      const result = readQualityGatesConfig(configDir);
      assert.strictEqual(result, null);
    });
  });

  describe('readValidatedQualityGates', () => {
    beforeEach(() => {
      writeFileSync(
        join(configDir, 'omc.jsonc'),
        JSON.stringify({
          qualityGates: {
            plan: ['design-audit', { skill: 'security-audit', mode: 'advisory' }],
            interview: ['requirements-validator', { skill: 'invalid!', mode: 'blocking' }],
            codeReview: [],
          },
        }),
      );
    });

    it('validates and normalizes gates for a stage', () => {
      const { gates, errors } = readValidatedQualityGates('plan', configDir);

      assert.strictEqual(gates.length, 2);
      assert.deepEqual(gates[0], { skill: 'design-audit', mode: 'blocking' });
      assert.deepEqual(gates[1], { skill: 'security-audit', mode: 'advisory' });
      assert.strictEqual(errors.length, 0);
    });

    it('reports validation errors but continues processing', () => {
      const { gates, errors } = readValidatedQualityGates('interview', configDir);

      assert.strictEqual(gates.length, 1);
      assert.deepEqual(gates[0], { skill: 'requirements-validator', mode: 'blocking' });
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].skillIndex, 1);
      assert.ok(errors[0].error);
    });

    it('handles empty stage list', () => {
      const { gates, errors } = readValidatedQualityGates('codeReview', configDir);
      assert.strictEqual(gates.length, 0);
      assert.strictEqual(errors.length, 0);
    });

    it('handles missing stage', () => {
      const { gates, errors } = readValidatedQualityGates('codeReview', configDir);
      assert.strictEqual(gates.length, 0);
      assert.strictEqual(errors.length, 0);
    });
  });

  describe('getGatesForStage', () => {
    beforeEach(() => {
      writeFileSync(
        join(configDir, 'omc.jsonc'),
        JSON.stringify({
          qualityGates: {
            plan: ['design-audit', { skill: 'security-audit', mode: 'advisory' }],
          },
        }),
      );
    });

    it('returns all gates for a stage', () => {
      const gates = getGatesForStage('plan', configDir);
      assert.strictEqual(gates.length, 2);
    });
  });

  describe('getAdvisoryGatesForStage', () => {
    beforeEach(() => {
      writeFileSync(
        join(configDir, 'omc.jsonc'),
        JSON.stringify({
          qualityGates: {
            plan: [
              'design-audit',
              { skill: 'security-audit', mode: 'advisory' },
              { skill: 'perf-review', mode: 'advisory' },
            ],
          },
        }),
      );
    });

    it('returns only advisory gates for a stage', () => {
      const gates = getAdvisoryGatesForStage('plan', configDir);
      assert.strictEqual(gates.length, 2);
      assert.ok(gates.every((g) => g.mode === 'advisory'));
    });
  });

  describe('getBlockingGatesForStage', () => {
    beforeEach(() => {
      writeFileSync(
        join(configDir, 'omc.jsonc'),
        JSON.stringify({
          qualityGates: {
            plan: [
              'design-audit',
              { skill: 'security-audit', mode: 'advisory' },
              { skill: 'arch-review', mode: 'blocking' },
            ],
          },
        }),
      );
    });

    it('returns only blocking gates for a stage', () => {
      const gates = getBlockingGatesForStage('plan', configDir);
      assert.strictEqual(gates.length, 2);
      assert.ok(gates.every((g) => g.mode === 'blocking'));
    });
  });

  describe('model overrides', () => {
    beforeEach(() => {
      writeFileSync(
        join(configDir, 'omc.jsonc'),
        JSON.stringify({
          qualityGates: {
            plan: [
              { skill: 'design-audit', mode: 'advisory', model: 'claude-opus' },
              { skill: 'security-audit', model: 'claude-sonnet' },
            ],
          },
        }),
      );
    });

    it('preserves model overrides in gates', () => {
      const gates = getGatesForStage('plan', configDir);
      assert.strictEqual(gates[0].model, 'claude-opus');
      assert.strictEqual(gates[1].model, 'claude-sonnet');
    });
  });
});
