"""One-off: move data from service-named "projects" into real projects.

Before projects existed, a "project" was just the app's service.name, and experiment
replays went to a separate "<name>/experiments" project. This script:

  1. creates a project for every existing name (keeping it as the project id, so no
     production span is rewritten) — display names from --name id="Display name";
  2. moves "<name>/experiments" spans into "<name>" with origin='experiment';
  3. fills in the project of experiments created before projects existed (from their
     source runs).

Dry run by default — prints the plan and changes nothing. Pass --apply to run it.
Project API keys are not printed: generate one per project in the UI (Settings) when
you want an app to send with it — until then the app keeps landing in its project by
service name.

    python scripts/migrate_projects.py --name bosun-all="Bosun"            # plan
    python scripts/migrate_projects.py --name bosun-all="Bosun" --apply    # do it
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from imagent_server import db, experiments, projects

SUFFIX = "/experiments"


async def plan(names: dict[str, str]) -> dict:
    await db.ensure_schema()
    rows = await db.query(f"SELECT project, count() AS spans, uniqExact(trace_id) AS traces FROM {db.SPANS} GROUP BY project")
    existing = {r["id"] for r in await db.query(f"SELECT id FROM {projects.PROJECTS} FINAL")}
    base = sorted({r["project"].removesuffix(SUFFIX) for r in rows} - existing)
    moves = [r for r in rows if r["project"].endswith(SUFFIX)]
    exps = await db.query(f"SELECT id, name, config FROM {experiments.EXPERIMENTS} FINAL WHERE project = ''")
    exp_fix = []
    for e in exps:
        srcs = json.loads(e["config"]).get("source_trace_ids", [])
        found = await db.query(f"SELECT DISTINCT project FROM {db.SPANS} WHERE trace_id IN {{ids:Array(String)}}", {"ids": srcs})
        proj = sorted({f["project"].removesuffix(SUFFIX) for f in found})
        exp_fix.append({"id": e["id"], "name": e["name"], "project": proj[0] if len(proj) == 1 else None, "candidates": proj})
    return {"create": [{"id": b, "name": names.get(b, b)} for b in base], "move": moves, "experiments": exp_fix}


async def apply(p: dict) -> None:
    client = await db.get_client()
    for c in p["create"]:
        await projects.create(c["name"], project_id=c["id"])
        print(f"  created project {c['id']!r} ({c['name']})")
    cols = ", ".join(db.COLUMNS)
    sel = ", ".join("{dest:String} AS project" if c == "project" else "'experiment' AS origin" if c == "origin" else c
                    for c in db.COLUMNS)
    for m in p["move"]:
        src, dest = m["project"], m["project"].removesuffix(SUFFIX)
        # `… AS project` would shadow the column in WHERE — qualify the source column.
        await client.command(f"INSERT INTO {db.SPANS} ({cols}) SELECT {sel} FROM {db.SPANS} AS s WHERE s.project = {{src:String}}",
                             parameters={"src": src, "dest": dest}, settings={"prefer_column_name_to_alias": 1})
        moved = (await db.query(f"SELECT count() AS n FROM {db.SPANS} WHERE project = {{d:String}} AND origin = 'experiment'",
                                {"d": dest}))[0]["n"]
        if moved < m["spans"]:
            sys.exit(f"  copy of {src} incomplete ({moved}/{m['spans']}) — old rows left in place")
        await client.command(f"ALTER TABLE {db.SPANS} DELETE WHERE project = {{src:String}} SETTINGS mutations_sync = 2",
                             parameters={"src": src})
        await client.command(f"ALTER TABLE {db.RUNNING} DELETE WHERE project = {{src:String}} SETTINGS mutations_sync = 2",
                             parameters={"src": src})
        print(f"  moved {m['spans']} spans {src!r} → {dest!r} (origin=experiment)")
    for e in p["experiments"]:
        if not e["project"]:
            print(f"  skipped experiment {e['id']} — source runs span {e['candidates'] or 'no'} projects")
            continue
        row = await experiments.get_experiment_row(e["id"])
        await client.insert(experiments.EXPERIMENTS, [[row["id"], e["project"], row["name"], row["agent"], row["status"],
                                                       row["config"], row["created_at"], experiments._version()]],
                            column_names=["id", "project", "name", "agent", "status", "config", "created_at", "updated_at"],
                            settings={"async_insert": 0})
        print(f"  experiment {e['id']} → {e['project']!r}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", action="append", default=[], help='id="Display name" (repeatable)')
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    names = dict(n.split("=", 1) for n in args.name)
    p = await plan(names)
    print("Projects to create (id → display name):")
    for c in p["create"]:
        print(f"  {c['id']:<28} → {c['name']}")
    print("Experiment replays to move:")
    for m in p["move"]:
        print(f"  {m['project']:<28} → {m['project'].removesuffix(SUFFIX):<20} {m['spans']} spans, {m['traces']} traces")
    print("Experiments without a project:")
    for e in p["experiments"]:
        print(f"  {e['id']}  {e['name'][:50]:<50} → {e['project'] or 'UNRESOLVED ' + str(e['candidates'])}")
    if not args.apply:
        print("\nDry run — nothing changed. Re-run with --apply.")
        await db.close()
        return
    print("\nApplying…")
    await apply(p)
    await db.close()
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
