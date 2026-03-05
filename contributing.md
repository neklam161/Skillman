# Contributing a Skill to Skillman

Anyone can submit a skill to the Skillman community registry. Once merged, it will appear in the extension for all users automatically.

---

## What is a Skill?

A Claude skill is a folder containing a `SKILL.md` file with YAML frontmatter, plus any supporting files the skill needs (scripts, references, assets). It gets packaged as a `.skill` file (a zip archive) for distribution.

### Minimum structure
```
my-skill/
└── SKILL.md
```

### SKILL.md format
```markdown
---
name: my-skill
description: What this skill does and when Claude should use it.
---

# My Skill

Instructions for Claude go here...
```

The `name` and `description` fields in the YAML frontmatter are **required**.

---

## How to Submit

### Step 1 — Build and test your skill
- Create your skill folder with a valid `SKILL.md`
- Test it in Claude by uploading it manually via `claude.ai/customize/skills`
- Make sure it works as expected

### Step 2 — Package it as a .skill file
A `.skill` file is just a zip archive of your skill folder:

```bash
# Mac/Linux
zip -r my-skill.skill my-skill/

# Windows (PowerShell)
Compress-Archive -Path my-skill -DestinationPath my-skill.skill
```

### Step 3 — Fork and add your files
1. Fork this repository
2. Add your `.skill` file to the `skills/` folder
3. Add an entry to `registry/registry.json`:

```json
{
  "name": "my-skill",
  "display_name": "My Skill",
  "description": "A short description shown in the extension (1-2 sentences).",
  "tags": ["tag1", "tag2"],
  "author": "your-github-username",
  "version": "1.0.0",
  "source": "https://raw.githubusercontent.com/neklam161/Skillman/main/skills/my-skill.skill",
  "icon": "🔧"
}
```

### Step 4 — Open a Pull Request
- Title: `Add skill: my-skill`
- Briefly describe what the skill does and why it's useful
- We'll review and merge it typically within a few days

---

## Registry JSON fields

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique identifier, lowercase, hyphens only |
| `display_name` | ✅ | Human-readable name shown in the extension |
| `description` | ✅ | Short description (1-2 sentences) |
| `tags` | ✅ | Array of lowercase tags for filtering |
| `author` | ✅ | Your GitHub username |
| `version` | ✅ | Semantic version string e.g. `1.0.0` |
| `source` | ✅ | Direct raw GitHub URL to the `.skill` file |
| `icon` | optional | A single emoji shown next to the skill name |

---

## Review criteria

Skills are accepted if they:
- Have a clear, useful purpose
- Include a well-written `SKILL.md` with proper YAML frontmatter
- Work correctly when uploaded to claude.ai
- Don't contain malicious code or prompt injections
- Don't duplicate an existing skill without significant improvement

---

## Updating an existing skill

If you're the author of a skill already in the registry:
1. Update the `.skill` file in `skills/`
2. Bump the `version` field in `registry/registry.json`
3. Open a PR with title: `Update skill: my-skill to v1.1.0`

---

## Questions?

Open an issue on this repo and we'll help you out.
