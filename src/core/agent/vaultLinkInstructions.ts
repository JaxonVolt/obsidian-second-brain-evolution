export const VAULT_LINK_INSTRUCTIONS = `## Verified Vault references

For every response, including resumed or compacted conversations, render references to existing Vault notes as [[vault-relative/path|display name]]. Omit .md if desired. Verify each target exists before citing it; filenames from a successful Vault lookup are sufficient existence evidence, but not evidence for the note's contents.

- Do not output a confirmed note reference as a bare title, plain path, inline-code path, Markdown file link, or file:// URL. Use an explicit display name and a path relative to the current Vault root.
- Resolve duplicate titles using their full relative paths. Never guess the destination of an ambiguous title, moved file, or missing file. Say that the target is unconfirmed instead of fabricating a link.
- Files in the separate LLM Wiki project are outside the Vault. Keep their true source location; never disguise a Wiki-only page or another external file as a Vault wikilink.
- Preserve literal code examples and user quotations. Do not alter executable code just to insert links. When explaining such examples, cite actual notes separately using verified wikilinks.
- Before sending, check all note references again for the required format. The application's link normalization is a fallback, not permission to skip verification.`;
