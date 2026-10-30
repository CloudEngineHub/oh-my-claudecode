/**
 * Custom Quality Gates Configuration
 *
 * Supports configurable custom quality gates for workflow stages via .claude/omc.jsonc qualityGates property.
 * 
 * Schema:
 * {
 *   "qualityGates": {
 *     "interview": ["skill-name" | {skill, mode?, model?}, ...],
 *     "plan": ["skill-name" | {skill, mode?, model?}, ...],
 *     "codeReview": ["skill-name" | {skill, mode?, model?}, ...]
 *   }
 * }
 *
 * Gates are native subagents that run alongside standard reviewers.
 * Missing skills produce visible warnings and are skipped.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../utils/paths.js';
import { loadJsoncFile } from './loader.js';

/**
 * Workflow stage where quality gates apply
 * - 'deep-interview': deep-interview final-spec stage
 * - 'ralplan': ralplan Architect→Critic review (consensus mode)
 * - 'code-review': code-review stage
 */
export type QualityGateStage = 'deep-interview' | 'ralplan' | 'code-review';

/**
 * Gate entry: either a skill name string or a gate configuration object
 */
export type QualityGateEntry = string | QualityGateObject;

/**
 * Gate configuration object
 */
export interface QualityGateObject {
  /** Skill name (kebab-case) */
  skill: string;
  /** Gate mode: 'blocking' (default) or 'advisory' */
  mode?: 'blocking' | 'advisory';
  /** Optional subagent model override */
  model?: string;
}

/**
 * Normalized gate entry (internal representation)
 */
export interface NormalizedGate {
  skill: string;
  mode: 'blocking' | 'advisory';
  model?: string;
}

/**
 * Quality gates configuration from .claude/omc.jsonc
 * Maps stage names to arrays of gate entries (strings or objects)
 */
export interface QualityGatesConfig {
  /** Quality gates for the deep-interview final-spec stage */
  'deep-interview'?: QualityGateEntry[];
  /** Quality gates for the ralplan Architect→Critic review stage */
  'ralplan'?: QualityGateEntry[];
  /** Quality gates for the code-review stage */
  'code-review'?: QualityGateEntry[];
}

/**
 * Reserved skill names that cannot be used as gates.
 * These are built-in/core skills managed by OMC.
 */
const RESERVED_SKILL_NAMES = new Set([
  'ai-slop-cleaner',
  'verification',
  'code-review',
  'deep-interview',
  'ralplan',
  'plan',
]);

/**
 * Validate skill name: must be kebab-case, not reserved
 */
export function validateSkillName(skill: string): { valid: boolean; error?: string } {
  if (!skill || typeof skill !== 'string') {
    return { valid: false, error: 'Skill name must be a non-empty string' };
  }

  // Check kebab-case format (including optional leading $ for skill references)
  const normalized = skill.startsWith('$') ? skill.slice(1) : skill;
  if (!normalized || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    return {
      valid: false,
      error: `Skill name must be kebab-case (e.g. 'design-audit'); got '${skill}'`,
    };
  }

  // Check if reserved
  if (RESERVED_SKILL_NAMES.has(normalized)) {
    return {
      valid: false,
      error: `Skill name '${normalized}' is reserved and cannot be used as a quality gate`,
    };
  }

  return { valid: true };
}

/**
 * Normalize a gate entry to a NormalizedGate.
 * - String entries default to blocking mode
 * - Objects preserve mode and model
 */
export function normalizeGate(entry: QualityGateEntry): NormalizedGate | null {
  if (typeof entry === 'string') {
    return { skill: entry, mode: 'blocking' };
  }

  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = entry as QualityGateObject;
    return {
      skill: obj.skill,
      mode: obj.mode || 'blocking',
      model: obj.model,
    };
  }

  return null;
}

/**
 * Read quality gates configuration from .claude/omc.jsonc
 */
export function readQualityGatesConfig(configDirOverride?: string): QualityGatesConfig | null {
  try {
    const configDir = configDirOverride || getConfigDir();
    const configPath = join(configDir, 'omc.jsonc');

    if (!existsSync(configPath)) {
      return null;
    }

    const config = loadJsoncFile(configPath);
    if (!config || typeof config !== 'object') {
      return null;
    }

    const qg = (config as any).qualityGates;
    return qg && typeof qg === 'object' ? qg : null;
  } catch {
    return null;
  }
}

/**
 * Validate and normalize gates for a given stage.
 * Returns both gates and validation errors (gate_unavailable is not an error here).
 */
export function readValidatedQualityGates(
  stage: QualityGateStage,
  configDirOverride?: string,
): {
  gates: NormalizedGate[];
  errors: Array<{ skillIndex: number; entry: string; error: string }>;
} {
  const config = readQualityGatesConfig(configDirOverride);
  const stageEntries = config?.[stage] || [];

  if (!Array.isArray(stageEntries)) {
    return { gates: [], errors: [] };
  }

  const gates: NormalizedGate[] = [];
  const errors: Array<{ skillIndex: number; entry: string; error: string }> = [];

  for (let i = 0; i < stageEntries.length; i++) {
    const entry = stageEntries[i];
    const entryStr = JSON.stringify(entry);

    // Validate structure
    let error: string | undefined;
    if (typeof entry === 'string') {
      error = validateSkillName(entry).error;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const obj = entry as QualityGateObject;
      if (!obj.skill) {
        error = 'Gate object must have a "skill" property';
      } else if (typeof obj.skill !== 'string') {
        error = 'Gate skill must be a string';
      } else if (obj.mode && !['blocking', 'advisory'].includes(obj.mode)) {
        error = `Invalid mode: ${obj.mode}; must be 'blocking' or 'advisory'`;
      } else {
        error = validateSkillName(obj.skill).error;
      }
    } else {
      error = 'Gate entry must be a string or object with {skill, mode?, model?}';
    }

    if (error) {
      errors.push({ skillIndex: i, entry: entryStr, error });
    } else {
      const normalized = normalizeGate(entry);
      if (normalized) {
        gates.push(normalized);
      }
    }
  }

  return { gates, errors };
}

/**
 * Get all gates for a stage
 */
export function getGatesForStage(stage: QualityGateStage, configDirOverride?: string): NormalizedGate[] {
  return readValidatedQualityGates(stage, configDirOverride).gates;
}

/**
 * Get advisory-only gates for a stage
 */
export function getAdvisoryGatesForStage(
  stage: QualityGateStage,
  configDirOverride?: string,
): NormalizedGate[] {
  return getGatesForStage(stage, configDirOverride).filter((g) => g.mode === 'advisory');
}

/**
 * Get blocking-only gates for a stage
 */
export function getBlockingGatesForStage(
  stage: QualityGateStage,
  configDirOverride?: string,
): NormalizedGate[] {
  return getGatesForStage(stage, configDirOverride).filter((g) => g.mode === 'blocking');
}
