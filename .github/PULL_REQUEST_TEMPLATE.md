## Type
<!-- Check exactly one. This drives the Discord announcement's color and label. -->
- [ ] feat
- [ ] fix
- [ ] refactor
- [ ] docs
- [ ] chore

## Affected
<!--
The real path(s) this touches — a product or a solution, not a vague
description. Examples:
  products/carbon-discord
  solutions/capabilities/cloud/billing
  products/carbon-cli, solutions/interface/cli
-->


## Explanation
<!-- Why this change, in prose. What problem it solves or what it adds. -->


## Verification Checklist
- [ ] `python .tools/validation/check_workspace.py` passes
- [ ] `bazel build //...` compiles cleanly
- [ ] `bazel test //...` passes
