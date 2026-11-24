# Development workflow

Use `main` as the base branch for implementation and the target branch for pull requests. Write new collaboration documents, Issue and pull request text, reviews, and commit messages in English.

## Prepare the Issue

Use the [Issue template](../.github/ISSUE_TEMPLATE/change-request.md) to describe the goal, scope, and expected deliverables. Apply the `task` label to Issues intended for ProjectWeave execution.

For each required pre-merge criterion, give a command, procedure, or artifact an agent can use to verify it and state the expected result. Require human confirmation only when the Issue explains why it is necessary before merge and what the person must confirm. List verification that is possible only after publication under post-merge verification, with steps and expected results. Write `None` if no post-merge verification is required.

## Implement and open a pull request

Start from `main` and use the source Issue to guide implementation, whether working manually or through ProjectWeave. Run the applicable pre-merge checks and capture their results. Write concise commit messages that describe the change.

Use the [pull request template](../.github/pull_request_template.md) to record the source Issue, what changed, pre-merge validation results, and any pending post-merge verification. For each check, record how it was run and the outcome, including any unrun checks and why they remain pending.

## Review and merge

Review the current pull request against the Issue using the [review guidelines](review-guidelines.md). Resolve blocking findings and rerun affected checks before merging. Record unrelated improvements as follow-up work.

- **Complete work.** Use `Closes #N` in the pull request description when the change satisfies all Issue requirements and mandatory pre-merge checks have passed. After merging to `main`, confirm that GitHub closed the Issue.
- **Intentionally partial work.** Reference the Issue with `Related to #N`, describe what remains, and leave the Issue open. Review and validate the portion included in the pull request before merging it. Use a plain reference in the description and commit messages so the Issue stays open.

## Post-merge verification

If a check is possible only after publication, merge the otherwise complete pull request and close the original Issue first. After publication, perform the check and record the result in the merged pull request or the closed Issue. If the check reveals a defect, open a new Issue and link it to the original Issue or pull request.
