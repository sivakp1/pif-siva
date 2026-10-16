"""§7 Traceability: fail if any acceptance criterion in specs/*.md has no matching test.

A criterion AC-XX-N is covered when a test name or CI step contains AC_XX_N or AC-XX-N.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC_FILES = [ROOT / "specs" / f for f in ("spec.md", "backend.md", "frontend.md")]
SEARCH = [
    (ROOT / "core" / "tests", "*.py"),
    (ROOT / "backend" / "tests", "*.py"),
    (ROOT / "backend" / "tests", "*.js"),
    (ROOT / "eval" / "tests", "*.py"),
    (ROOT / "frontend", "*.spec.ts"),
    (ROOT / "frontend", "*.test.ts"),
    (ROOT / "frontend", "*.test.tsx"),
    (ROOT / ".github" / "workflows", "*.yml"),
]
AC_RE = re.compile(r"\*\*(AC-[A-Z]+-\d+)\*\*")


def main() -> int:
    acs: list[str] = []
    for f in SPEC_FILES:
        for ac in AC_RE.findall(f.read_text(encoding="utf-8")):
            if ac not in acs:
                acs.append(ac)
    corpus = []
    for base, pattern in SEARCH:
        if base.exists():
            for p in base.rglob(pattern):
                if "node_modules" not in p.parts:
                    corpus.append(p.read_text(encoding="utf-8", errors="ignore"))
    text = "\n".join(corpus)
    missing = [ac for ac in acs if ac not in text and ac.replace("-", "_") not in text]
    print(f"{len(acs) - len(missing)}/{len(acs)} acceptance criteria have tests")
    for ac in missing:
        print(f"MISSING TEST: {ac}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
