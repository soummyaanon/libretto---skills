# god-of-debugger automation runner

This runner enforces the pipeline in `.cursor/rules/god-of-debugger.mdc`:

1. deterministic repro (must fail)
2. hypothesis table (Gate 1)
3. sequential experiments
4. survival table (Gate 2)
5. ship-the-fix guard (`S == survived + inconclusive`)

## Quick start

```bash
cp scripts/debug-go.hypotheses.example.json /tmp/my-hypotheses.json
# edit commands/claims to match your bug

pnpm debug:go \
  --repro "pnpm -s test --filter=libretto -- test/failing.spec.ts" \
  --hypotheses /tmp/my-hypotheses.json
```

Use `--auto` to skip the Gate 1 prompt:

```bash
pnpm debug:go \
  --repro "pnpm -s test --filter=libretto -- test/failing.spec.ts" \
  --hypotheses /tmp/my-hypotheses.json \
  --auto
```

## Hypothesis schema

`--hypotheses` must point to a JSON array:

```json
[
  {
    "id": "H1",
    "origin": "primary",
    "axis": "data",
    "claim": "Short falsifiable claim",
    "exp": "probe",
    "cost": "low",
    "command": "pnpm -s test --filter=libretto -- test/some.spec.ts",
    "killIf": "exit0"
  }
]
```

- `axis` must be one of: `data`, `control-flow`, `concurrency`, `config`, `deps`, `env`, `contract`
- coverage guard: at least 4 unique axes required
- `killIf`:
  - `exit0`: experiment kills hypothesis when command exits 0
  - `exitNonZero`: experiment kills hypothesis when command exits non-zero

## Artifacts

Default output directory: `.debug-go/<timestamp>/`

- `repro.log`
- `gate1.md`
- `gate2.md`
- `summary.json`
- `<hypothesis-id>.log` for each experiment

## Exit codes

- `0`: completed and exactly one survivor (`S == 1`)
- `2`: repro did not fail or Gate 1 chose edit
- `3`: ship guard blocked fix (`S != 1`)
- `1`: invalid args or runtime error
