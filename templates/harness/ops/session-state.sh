#!/usr/bin/env bash
# SESSION-START state monitor (read-only). Run FIRST by /bootstrap so the orchestrator always
# works against CURRENT state: both repos + tracker + GRACE freshness (+ an optional data heartbeat).
# Safe to run anytime; mutates nothing.
#
# GENERIC / PORTABLE (shipped by `taskctl init-harness`): no hard-coded machine paths or project
# names. ORCH = this sidecar (from script location); TARGET = REPO_PATH / GRACE_REPO_ROOT env
# (per-dev .env) → else taskctl.config.json repoPath. Labels/branches read from config at runtime.
set -uo pipefail
ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # orchestration sidecar root (script lives in ops/)
# load .env (per-dev: REPO_PATH, GRACE_REPO_ROOT, COLLECTOR_DATA_DIR, JIRA_*) — values never printed
set -a; . "$ORCH/.env" 2>/dev/null || true; set +a

# read a dotted key out of taskctl.config.json (empty string on any failure)
cfg() { node -e 'try{const c=require(process.argv[1]);const v=process.argv[2].split(".").reduce((o,k)=>(o==null?o:o[k]),c);process.stdout.write(v==null?"":String(v))}catch(e){}' "$ORCH/taskctl.config.json" "$1" 2>/dev/null; }
TARGET="${REPO_PATH:-${GRACE_REPO_ROOT:-}}"
[ -z "$TARGET" ] && TARGET="$(cfg repoPath)"
INTEG="$(cfg branches.integration)"; INTEG="${INTEG:-main}"
PILOT="$(cfg grace.pilotBranch)"; PILOT="${PILOT:-experiment/grace-pilot}"
GRACE_ON="$(cfg grace.enabled)"

echo "============ SESSION STATE ($(date -u +%FT%TZ)) ============"

# 1) Orchestration sidecar (this repo)
echo "--- orchestration sidecar ($ORCH) ---"
git -C "$ORCH" fetch -q origin 2>/dev/null
echo "branch=$(git -C "$ORCH" rev-parse --abbrev-ref HEAD)  HEAD<->origin/$INTEG (ahead/behind)=$(git -C "$ORCH" rev-list --left-right --count "HEAD...origin/$INTEG" 2>/dev/null)"
echo "uncommitted tracked changes: $(git -C "$ORCH" status --porcelain 2>/dev/null | grep -vcE '^\?\? ')"

# 2) Target repo (READ-ONLY by default; integration branch is the PR base and may be protected).
echo "--- target repo (${TARGET:-<unset>}) ---"
if [ -n "$TARGET" ] && git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$TARGET" fetch -q origin 2>/dev/null
  echo "local branch=$(git -C "$TARGET" rev-parse --abbrev-ref HEAD)  local-$INTEG<->origin/$INTEG=$(git -C "$TARGET" rev-list --left-right --count "$INTEG...origin/$INTEG" 2>/dev/null)"
  echo "origin/$INTEG head: $(git -C "$TARGET" log -1 --oneline "origin/$INTEG" 2>/dev/null)"
  echo "local uncommitted tracked changes: $(git -C "$TARGET" status --porcelain 2>/dev/null | grep -vcE '^\?\? ')"
  # GRACE pilot branch — enforcement runs on it; flag whether it exists yet (only relevant when grace is on).
  if [ "$GRACE_ON" = "true" ]; then
    if git -C "$TARGET" rev-parse -q --verify "origin/$PILOT" >/dev/null 2>&1; then
      echo "GRACE pilot: origin/$PILOT EXISTS  pilot<->$INTEG=$(git -C "$TARGET" rev-list --left-right --count "origin/$PILOT...origin/$INTEG" 2>/dev/null)"
    else
      echo "GRACE pilot: $PILOT NOT YET created in target — gate not enforcing; graph authored in grace/xml/docs/."
    fi
  fi
else
  echo "  target checkout not found — set REPO_PATH in .env (per-dev path to your target checkout)."
fi

# 3) Tracker (taskctl.config.json tracker.type). With no JIRA_PROJECT_KEY the project is local.
PKEY="${JIRA_PROJECT_KEY:-}"
echo "--- tracker: ${PKEY:+Jira $PKEY}${PKEY:-local} ---"
if [ -z "$PKEY" ]; then
  echo "  no JIRA_PROJECT_KEY → tasks are LOCAL: node taskctl/cli.mjs new <slug> (cycle runs to 'review'; PR is manual)."
elif [ -n "${JIRA_API_TOKEN:-}" ] && [ -n "${JIRA_BASE_URL:-}" ] && [ -n "${JIRA_EMAIL:-}" ]; then
  B="${JIRA_BASE_URL%/}"
  curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X POST "$B/rest/api/3/search/jql" -H "Content-Type: application/json" \
    -d "{\"jql\":\"project = $PKEY AND statusCategory != Done ORDER BY updated DESC\",\"maxResults\":25,\"fields\":[\"status\",\"summary\"]}" \
    | python -c "import sys,json
d=json.load(sys.stdin); iss=d.get('issues',[])
print('  (none open)') if not iss else [print('  %-8s [%-14s] %s'%(i['key'], i['fields']['status']['name'], (i['fields'].get('summary') or '')[:55])) for i in iss]" 2>/dev/null || echo "  (jira query failed — check creds/network)"
else
  echo "  Jira key set ($PKEY) but JIRA_API_TOKEN / JIRA_BASE_URL / JIRA_EMAIL not loaded (.env)."
fi

# 4) GRACE / docs freshness (only when grace is enabled + the freshness script is present).
if [ "$GRACE_ON" = "true" ] && [ -f "$ORCH/grace/check-freshness.sh" ]; then
  ( cd "$ORCH" && bash grace/check-freshness.sh )
fi

# 5) OPTIONAL data heartbeat — freshness of forward-only collected data. Dormant unless the project
#    sets COLLECTOR_DATA_DIR in .env (projects without a data-collection layer skip this entirely).
if [ -n "${COLLECTOR_DATA_DIR:-}" ]; then
  echo "--- data heartbeat ($COLLECTOR_DATA_DIR) ---"
  if [ -d "$COLLECTOR_DATA_DIR" ]; then
    # portable newest-file scan (GNU `find -printf` is absent on BSD/macOS) via node
    node -e 'const fs=require("fs"),p=require("path");let n=0,f="";(function w(d){let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return}for(const e of es){const q=p.join(d,e.name);try{if(e.isDirectory())w(q);else{const m=fs.statSync(q).mtimeMs;if(m>n){n=m;f=q}}}catch{}}})(process.argv[1]);if(!n){console.log("  data dir present but empty.");process.exit(0)}const h=Math.floor((Date.now()-n)/3600000);console.log("  newest file: "+f);console.log("  age: ~"+h+"h  "+(h>6?"⚠ STALE — re-sync / check collectors":"(fresh)"))' "$COLLECTOR_DATA_DIR"
  else
    echo "  COLLECTOR_DATA_DIR set but not found — check the path / run your sync."
  fi
fi
echo "============ END SESSION STATE ============"
