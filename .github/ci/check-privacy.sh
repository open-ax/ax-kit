#!/bin/sh
#
# Privacy guard. Shared by the git hooks and the CI workflow so the two cannot
# drift apart.
#
#   sh .github/ci/check-privacy.sh [staged|tracked]
#
#   staged   inspect the index - what is about to be committed (default)
#   tracked  inspect the working tree - what is already published
#
# Exit 0 = clean. Exit 1 = a violation, with the offending lines listed.
#
# Four independent checks:
#
#   1. local paths    private material must not be tracked at all
#   2. local paths    no local filesystem path may appear in tracked content
#   3. vocabulary     tracked content must not refer to private material in prose
#   4. vocabulary     commit subjects must not either
#
# Check 3 exists because a document once referred to private material eight
# times in ordinary English while passing every path-based check. The leak was
# wording, not a filename. Paths alone do not catch that.
#
# Patterns live in .github/ci/vocab.txt, including the two files that are
# excluded from the vocabulary scan and why.

set -u

mode="${1:-staged}"

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
	echo "not inside a git repository" >&2
	exit 1
}
cd "$root" || exit 1

# `set -e` is deliberately not used: a grep that finds nothing is the normal
# case here, not a failure.
# shellcheck source=/dev/null
. .github/ci/vocab.txt || {
	echo "cannot read .github/ci/vocab.txt" >&2
	exit 1
}

# Turn "a,b" into " :(exclude)a :(exclude)b" for git pathspec syntax.
# No quoting: the result is consumed unquoted so the shell word-splits it, and
# these paths contain no spaces.
csv_pathspecs() {
	_out=""
	_rest="$1"
	while [ -n "$_rest" ]; do
		_item="${_rest%%,*}"
		if [ "$_item" = "$_rest" ]; then
			_rest=""
		else
			_rest="${_rest#*,}"
		fi
		_out="$_out :(exclude)$_item"
	done
	printf '%s' "$_out"
}

if [ "$mode" = "tracked" ]; then
	search_paths() { git grep -InE "$1" -- . ":(exclude)$EXCLUDE_PATHS" 2>/dev/null; }
	search_vocab() { git grep -InE "$1" -- . $(csv_pathspecs "$EXCLUDE_VOCAB") 2>/dev/null; }
else
	search_paths() { git grep --cached -InE "$1" -- . ":(exclude)$EXCLUDE_PATHS" 2>/dev/null; }
	search_vocab() { git grep --cached -InE "$1" -- . $(csv_pathspecs "$EXCLUDE_VOCAB") 2>/dev/null; }
fi

fail=0

report() {
	printf '\n  [privacy] %s\n' "$1"
	shift
	"$@" | sed 's/^/    /'
}

# 1. Local-only paths must not be tracked.
tracked_local=$(git ls-files 2>/dev/null | grep -E "$LOCAL_PATH_PATTERN" || true)
if [ -n "$tracked_local" ]; then
	fail=1
	report "local-only paths are tracked:" printf '%s\n' "$tracked_local"
fi

# 2. No local filesystem paths in tracked content.
if found=$(search_paths "$PATH_PATTERN"); then
	fail=1
	report "a local filesystem path is present:" printf '%s\n' "$found"
fi

# 3. No references to private material in prose, in tracked content.
if found=$(search_vocab "$PATTERN"); then
	fail=1
	report "content refers to private material in prose:" printf '%s\n' "$found"
fi

# 4. No references in commit subjects. Subjects are the least retractable text
#    in a repository: they outlive the file, and they reach every clone.
subjects=$(git log --format=%s -30 2>/dev/null \
	| grep -inE "$PATTERN" || true)
if [ -n "$subjects" ]; then
	fail=1
	report "a commit subject refers to private material:" printf '%s\n' "$subjects"
fi

if [ "$fail" -ne 0 ]; then
	printf '\n  See AGENTS.md for what may and may not be published.\n\n'
	exit 1
fi

exit 0
