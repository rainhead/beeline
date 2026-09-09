# Contributing

For people with write access to this repository. Agents have their own instructions in [AGENTS.md](AGENTS.md).

## Work lands as a pull request

`main` is protected: push a branch and open a PR. No approval is needed to open one or to merge a green one — the branch exists so something reads the change on the way in, not so somebody signs it off.

That something is [CodeRabbit](https://coderabbit.ai/), which reviews every PR automatically. It earns the branch: on one change it caught a real defect that four rounds of careful human review had missed. Triage what it says — fix what is real, and reply on the PR with your reasoning when you disagree. It is often wrong, and saying so is a normal outcome.

```bash
git checkout -b my-change
# edit, commit
git push -u origin my-change
gh pr create        # or use the link git prints
```

## Where a piece of writing goes

Most of what staff contribute is knowledge rather than code, and it has three homes that are easy to mix up. Putting a paragraph in the wrong one is the common mistake, not writing too much or too little.

- **[CONTEXT.md](CONTEXT.md)** is a glossary — the shared vocabulary, so that a word means one thing in code, in commits, and in conversation. Entries are definitions: a bolded term, then what it means, in the third person. If what you are writing is not the definition of a term, it belongs somewhere else.
- **[docs/questions.md](docs/questions.md)** holds questions we cannot answer from the code or the data, each addressed to whoever can answer it. When one is answered, the answer moves into CONTEXT.md or the relevant doc and the question is deleted. Answers do not stay here.
- **[docs/reference-implementation.md](docs/reference-implementation.md)** is what the *current* system — OBP-Server, confusingly also called Beeline — actually does, recorded so the replacement is designed against facts rather than folklore. Operating practice belongs here too: how a job is really run, what the operator really checks. Say when a passage comes from a person rather than from the code.
- **[docs/adr/](docs/adr/)** is for a decision with a consequence someone will later want the reasoning for. Sparingly.

Writing an answer in your own voice is welcome and useful — it is the raw material. Someone will move it to its home and rewrite it in the document's voice; that is editing, not disagreement.

## Documentation is part of the change

Keep docs current in the same commit as the change they describe. Keep them concise and about principles — link to a source file rather than copying volatile configuration or data into prose.

## Nothing private in this repository

It is public. No volunteer names attached to personal details, no email addresses, no mailing addresses — in commits, PR descriptions, or issues. `data/` is gitignored for this reason.
