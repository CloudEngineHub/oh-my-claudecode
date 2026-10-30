# Custom Quality Gates Configuration

Custom quality gates allow you to attach specialized skill validators to specific workflow stages in OMC. Gates run as native subagents alongside standard reviewers and can operate in either **advisory** (warning only) or **blocking** (must-pass) mode.

## Overview

Quality gates are configured per-stage in `.claude/omc.jsonc` and apply to three workflow stages:

- **`interview`** — deep-interview final-spec stage
- **`plan`** — ralplan Architect→Critic review consensus stage
- **`codeReview`** — code-review stage

Each gate is a skill name or configuration object. Gates run after standard reviewers complete and their verdicts are recorded in receipts.

## Configuration

### Basic Structure

Add a `qualityGates` object to `.claude/omc.jsonc`:

```jsonc
{
  "qualityGates": {
    "interview": [
      "requirements-validator",
      { "skill": "ambiguity-checker", "mode": "blocking" }
    ],
    "plan": [
      "design-audit",
      { "skill": "security-reviewer", "mode": "advisory" }
    ],
    "codeReview": [
      { "skill": "performance-analyzer", "mode": "blocking", "model": "claude-opus" }
    ]
  }
}
```

### Gate Entry Format

Each gate entry is either:

1. **String (shorthand)** — skill name, defaults to blocking mode:
   ```json
   "design-audit"
   ```

2. **Object (explicit)** — full configuration:
   ```json
   {
     "skill": "design-audit",
     "mode": "blocking",        // optional, default: "blocking"
     "model": "claude-opus"     // optional, model override for this gate
   }
   ```

### Gate Modes

- **`blocking` (default)**
  - Gate verdict is required for workflow completion
  - If a blocking gate fails, the workflow enters revision loop (max 5 iterations)
  - Gate must approve before handoff or execution proceeds
  - Used for critical validations (security, compliance, architecture)

- **`advisory`**
  - Gate verdict is recorded but does not block workflow
  - Used for recommendations (performance tips, best practices)
  - Advisory verdicts appear in receipts as residual risks or notes
  - Workflow proceeds regardless of advisory verdict

### Model Overrides

Optionally specify a model for a gate's subagent execution:

```jsonc
{
  "skill": "deep-analysis",
  "mode": "blocking",
  "model": "claude-opus"    // this gate runs on Opus instead of default
}
```

Model overrides apply only to that gate's execution and do not affect other gates or the main workflow.

## Validation Rules

Skill names must:

- Be **kebab-case** (lowercase letters, numbers, hyphens only)
- Not be **reserved** (code-review, deep-interview, ralplan, plan, verification, ai-slop-cleaner)
- Not be **sunset/deprecated** skills

Invalid skill names are reported as configuration errors and gates are skipped.

## Behavior

### Interview Stage

After deep-interview's final-spec crystallization:
1. Standard readiness checks run
2. Configured interview gates spawn as subagents
3. Blocking gates must approve; failures trigger spec refinement
4. Advisory gates recorded as residual risks
5. Handoff proceeds after all blocking gates pass

### Plan Stage (Ralplan)

After Architect and Critic approvals:
1. Configured plan gates spawn as subagents
2. Blocking gates must approve; failures trigger revision loop
3. Advisory gates recorded in receipt without blocking
4. Execution handoff proceeds after all blocking gates pass

### Code Review Stage

After standard code-review:
1. Configured codeReview gates spawn as subagents
2. Blocking gates force REQUEST CHANGES, prevent merge-ready status
3. Advisory gates recorded without blocking approval
4. Merge requires all blocking gates to pass

## Error Handling

### Missing/Unavailable Skills

If a skill name does not exist or cannot be loaded:

- A visible warning is logged
- Gate verdict is marked `gate_unavailable` in receipt
- **Advisory gates** are skipped (no block)
- **Blocking gates** are skipped (no block) — missing gates do not fail workflows
- Workflow continues normally

This ensures graceful degradation if a custom skill is not installed or temporarily unavailable.

### Validation Errors

Configuration errors (invalid skill name format, reserved name, malformed mode):

- Reported at configuration load time
- Gate is skipped
- Workflow continues with remaining gates
- Error details appear in logs

### Blocking Gate Failures

If a blocking gate verdict is "REQUEST CHANGES" or "BLOCK":

1. Workflow enters revision loop
2. Draft/spec is revised based on gate feedback
3. Reviewer (Architect/Critic) re-evaluates
4. Gate runs again
5. Max iteration limit: 5 cycles
6. If gate still blocks after max iterations, workflow reports failure

## Examples

### Simple Blocking Gates

```jsonc
{
  "qualityGates": {
    "plan": [
      "security-audit",
      "architecture-review"
    ]
  }
}
```

Both gates are blocking (default) and must pass for plan approval.

### Mixed Modes

```jsonc
{
  "qualityGates": {
    "codeReview": [
      { "skill": "security-scan", "mode": "blocking" },
      { "skill": "performance-tips", "mode": "advisory" },
      { "skill": "accessibility-check", "mode": "advisory" }
    ]
  }
}
```

Security is mandatory; performance and accessibility are informational.

### Model-Specific Gates

```jsonc
{
  "qualityGates": {
    "plan": [
      {
        "skill": "complex-design-review",
        "mode": "blocking",
        "model": "claude-opus"    // use high-reasoning model for complex review
      },
      {
        "skill": "quick-lint-check",
        "mode": "advisory"
        // uses default model
      }
    ]
  }
}
```

Different gates can target different model capabilities.

### Full Multi-Stage Example

```jsonc
{
  "qualityGates": {
    "interview": [
      { "skill": "requirements-validator", "mode": "blocking" },
      { "skill": "scope-analyzer", "mode": "advisory" }
    ],
    "plan": [
      { "skill": "security-architect", "mode": "blocking", "model": "claude-opus" },
      { "skill": "design-auditor", "mode": "advisory" },
      "performance-estimator"
    ],
    "codeReview": [
      { "skill": "security-reviewer", "mode": "blocking" },
      { "skill": "code-style-checker", "mode": "advisory" }
    ]
  }
}
```

Different stages enforce different quality standards.

## Creating Custom Gate Skills

Quality gate skills are ordinary OMC skills that:

1. Read the proposed spec/plan/code
2. Perform analysis or validation
3. Return a verdict: APPROVED, REQUEST CHANGES, or BLOCK
4. Provide clear feedback for revisions

Gate skills are invoked by the standard workflow as subagents and follow normal OMC skill conventions (no special framework needed).

## Troubleshooting

### Gate Not Running

- Verify skill name is kebab-case (e.g., `my-gate` not `myGate`)
- Confirm skill name is not reserved
- Check `.claude/omc.jsonc` syntax (valid JSON/JSONC)
- Verify skill is installed and accessible in OMC skill roots

### Gate Always Failing

- For blocking gates: check gate logic for overly strict criteria
- Add advisory-mode variants to gather feedback before enforcing
- Verify gate model selection if using model overrides

### Revision Loop Not Terminating

- Max iterations is 5; if gate keeps failing, workflow reports max-iteration outcome
- Review gate feedback for actionable guidance
- Consider relaxing gate criteria or switching to advisory mode

## Performance

- Gates are spawned sequentially after standard reviewers complete
- Each gate is a native subagent (isolated execution context)
- Total plan/interview/review time includes gate execution
- Model overrides do not affect other gates or main workflow

For high-impact gates, consider:
- Using advisory mode for exploratory feedback
- Limiting total gates per stage (1-3 recommended)
- Targeting blocking gates for genuinely critical checks

## Porting from oh-my-codex

OMC quality gates are a direct port of [oh-my-codex#3956](https://github.com/Yeachan-Heo/oh-my-codex/pull/3956).

Key differences from OMX:

- **Config file**: `.claude/omc.jsonc` (OMX uses `.omx-config.json`)
- **Stage names**: `interview`, `plan`, `codeReview` (OMX uses camelCase with hyphenated names)
- **Schema integration**: Part of PluginConfig in OMC (separate module in OMX)
- **CLI**: Not exposed in OMC CLI (OMX has `omx quality-gates list --stage`)

Functional behavior is identical: advisory/blocking modes, model overrides, missing skill handling, and revision loops work the same.
