#!/usr/bin/env bash
# GRACE / docs freshness check (READ-ONLY). Surfaces drift between the committed module graph and the
# code. Deterministic signals only — actual graph CONTENT updates go through the cross-model sync loop
# (planner extracts -> reviewer verifies), never a blind auto-edit.
#
# GENERIC (shipped by `taskctl init-harness`): reads REPO_PATH/.env + taskctl.config.json at runtime.
# Degrades gracefully before you have a graph. Fill the two PROJECT KNOBS below once the graph exists.
set -uo pipefail
ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # orchestration sidecar root (script in grace/)
set -a; . "$ORCH/.env" 2>/dev/null || true; set +a
cfg() { node -e 'try{const c=require(process.argv[1]);const v=process.argv[2].split(".").reduce((o,k)=>(o==null?o:o[k]),c);process.stdout.write(v==null?"":String(v))}catch(e){}' "$ORCH/taskctl.config.json" "$1" 2>/dev/null; }
TARGET="${REPO_PATH:-${GRACE_REPO_ROOT:-}}"; [ -z "$TARGET" ] && TARGET="$(cfg repoPath)"
INTEG="$(cfg branches.integration)"; INTEG="${INTEG:-main}"
PILOT="$(cfg grace.pilotBranch)"; PILOT="${PILOT:-experiment/grace-pilot}"
cd "$ORCH"   # relative paths below resolve against sidecar root

# --- PROJECT KNOBS (fill once your module graph exists) ---
GRAPH_GEN_DATE="TODO-YYYY-MM-DD"    # date the graph (grace/xml/docs/*.xml) was generated/verified
GOV_PATHS="src/"                    # TODO: governed subsystem dirs covered by the module graph

echo "=== GRACE/doc freshness ($(date -u +%FT%TZ)) ==="
if [ -z "$TARGET" ] || [ ! -d "$TARGET" ]; then
  echo "  ! REPO_PATH not set / not a dir (\$TARGET='$TARGET') — set REPO_PATH in .env. Skipping target-repo checks."
else
  echo "target repo: $TARGET"
  git -C "$TARGET" fetch -q origin 2>/dev/null || echo "  (no origin / offline — using local refs)"
  REF="$(git -C "$TARGET" rev-parse -q --verify "origin/$INTEG" 2>/dev/null || echo HEAD)"

  # 1) code changes since the graph was generated (broad drift signal) — skipped until GRAPH_GEN_DATE is set
  if [ "$GRAPH_GEN_DATE" != "TODO-YYYY-MM-DD" ]; then
    since=$(git -C "$TARGET" rev-list --count --since="$GRAPH_GEN_DATE" "$REF" -- $GOV_PATHS 2>/dev/null || echo "?")
    echo "governed-path commits on $REF since graph gen ($GRAPH_GEN_DATE): $since"
    [ "$since" != "0" ] && [ "$since" != "?" ] && echo "  -> graph may have DRIFTED: re-run the cross-model sync (re-read changed modules, verify STATUS/edges)."
  else
    echo "  (GRAPH_GEN_DATE not set in grace/check-freshness.sh — drift-since-gen check skipped)"
  fi

  # 1b) pilot-vs-integration graph drift — only when the pilot branch exists
  if git -C "$TARGET" rev-parse -q --verify "origin/$PILOT" >/dev/null 2>&1; then
    behind=$(git -C "$TARGET" rev-list --count "origin/$PILOT..origin/$INTEG" 2>/dev/null || echo "?")
    echo "GRACE pilot ($PILOT) behind $INTEG by: $behind commit(s) $([ "$behind" = "0" ] && echo '(graph current)' || echo '-> rebase pilot / re-sync graph')"
  fi
fi

# 2) MODULE-INDEX vs graph (regenerate signal): module count match?
gi=$(grep -cE '^\| \*\*M-' grace/MODULE-INDEX.md 2>/dev/null || echo 0)
GX=""
for c in grace/xml/docs/development-plan.xml grace/xml/docs/knowledge-graph.xml; do
  [ -f "$c" ] && grep -qE '<M-[A-Z0-9-]+>' "$c" 2>/dev/null && { GX="$c"; break; }
done
if [ -n "$GX" ]; then
  gx=$(grep -oE '<M-[A-Z0-9-]+>' "$GX" | sort -u | wc -l | tr -d ' ')
  echo "MODULE-INDEX modules: $gi   graph modules ($GX): $gx $([ "$gi" = "$gx" ] && echo '(in sync)' || echo '(REGENERATE MODULE-INDEX)')"
else
  echo "MODULE-INDEX modules: $gi   (no module-defining graph XML under grace/xml/docs/ yet)"
fi

# 3) XML well-formedness (canonical copies under grace/xml/docs/)
found_xml=0
for f in grace/xml/docs/*.xml; do
  [ -f "$f" ] || continue
  found_xml=1
  python -c 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' "$f" 2>/dev/null \
    && echo "xml OK: $f" || echo "xml PARSE-FAIL: $f  <-- fix before trusting the graph"
done
[ "$found_xml" = 0 ] && echo "  (no graph XML under grace/xml/docs/ yet)"

# 4) doc staleness: the graph snapshot is point-in-time; the target's live-state doc is the SOT
echo "--- doc timestamps (graph snapshot is point-in-time) ---"
ls -la --time-style=+%F CLAUDE.md grace/xml/docs/*.xml 2>/dev/null | awk '{print "  "$6" "$NF}'
echo "=== end ==="
