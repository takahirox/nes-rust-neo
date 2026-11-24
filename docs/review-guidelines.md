# Review guidelines

Read the source Issue and review the current pull request revision against its scope and [pre-merge acceptance criteria](development-flow.md#prepare-the-issue). Check that the reported validation covers the changes under review. Agents should verify required criteria directly by default. Require human confirmation only when the Issue explains why it is necessary before merge.

## Blocking findings

For each blocking finding, identify the affected Issue requirement or pre-merge criterion and where the problem appears. Give concrete evidence, such as a failing command and its output or a file and line showing the problem. State how to verify a fix and what result to expect. Recheck affected criteria after changes. Record improvements outside the Issue's scope as follow-up work.

## Merge readiness

Resolve blocking findings before approving a merge. Verify all mandatory pre-merge checks for a complete pull request and the applicable checks for an intentionally partial pull request. Follow the [merge and Issue closure rules](development-flow.md#review-and-merge). Keep publication-only checks in [post-merge verification](development-flow.md#post-merge-verification) and record their results after publication.
