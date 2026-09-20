#!/usr/bin/env python3
"""Convert an fm-vda5050 database/map.ts installation to fleet-manager site JSON.

Usage:
    python3 scripts/convert-fm-map.py <map.ts> <InstallationName> <out.json>

Only generic geometry crosses over: graph nodes/links, parking spots
(with entry nodes resolved from the edges list), station pick/drop
poses with names and zones, and the map image world rectangle. Left
behind on purpose: trolley prefs (pickTurn/dropTurn, is_pickup_for_zones),
autoRandoTasks config, lockGroups, and commented-out entries.

Validate the output with the site schema before committing:
    bun -e 'import { parseSite } from "./packages/core/src/site.ts";
      import { readFileSync } from "node:fs";
      parseSite(readFileSync(process.argv[2], "utf8")); console.log("ok");' <out.json>
"""

import json
import math
import re
import sys

DIRECTION = {"East": 0.0, "West": math.pi, "North": math.pi / 2, "South": -math.pi / 2}


def num(text):
    return float(text)


def pose(text):
    """Extract x/y/theta from a pose literal; theta may be a Direction member."""
    out = {}
    mx = re.search(r"x:\s*(-?[\d.]+)", text)
    my = re.search(r"y:\s*(-?[\d.]+)", text)
    mt = re.search(r"theta:\s*(?:Direction\.(\w+)|(-?[\d.]+))", text)
    if mx:
        out["x"] = num(mx.group(1))
    if my:
        out["y"] = num(my.group(1))
    if mt:
        out["theta"] = DIRECTION[mt.group(1)] if mt.group(1) else num(mt.group(2))
    return out


def split_objects(section):
    """Split a `key: [...]` array body into top-level `{...}` object texts."""
    objs, depth, current = [], 0, ""
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        depth += line.count("{") - line.count("}")
        current += line + "\n"
        if depth == 0 and current.strip():
            if "{" in current:
                objs.append(current)
            current = ""
    return objs


def main():
    map_ts, installation, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(map_ts) as f:
        lines = f.readlines()
    start = next(i for i, l in enumerate(lines) if f"[Installation.{installation}," in l)
    end = next(i for i, l in enumerate(lines) if i > start and re.match(r"\s*\[Installation\.\w+,", l))
    block = "".join(lines[start:end])

    def section(name):
        m = re.search(rf"{name}:\s*\[(.*?)\n\s*\],", block, re.S)
        if not m:
            raise SystemExit(f"section not found: {name}")
        return m.group(1)

    nodes = []
    for obj in split_objects(section("nodes")):
        mid = re.search(r"id:\s*'([^']+)'", obj)
        mx = re.search(r"(?<![\w])x:\s*(-?[\d.]+)", obj)
        my = re.search(r"(?<![\w])y:\s*(-?[\d.]+)", obj)
        mr = re.search(r"radius:\s*([\d.]+)", obj)
        node = {"id": mid.group(1), "x": num(mx.group(1)), "y": num(my.group(1))}
        if mr:
            node["radius"] = num(mr.group(1))
        nodes.append(node)

    links = []
    for obj in split_objects(section("links")):
        ms = re.search(r"source:\s*'([^']+)'", obj)
        md = re.search(r"destination:\s*'([^']+)'", obj)
        mb = re.search(r"bidirectional:\s*(true|false)", obj)
        link = {"source": ms.group(1), "destination": md.group(1)}
        if mb and mb.group(1) == "true":
            link["bidirectional"] = True
        links.append(link)

    # edges pair graph nodes with off-graph locations/parking
    entries = {}
    for m in re.finditer(r"\['([^']+)',\s*'([^']+)'\]", section("edges")):
        entries[m.group(2)] = m.group(1)

    parking = []
    for obj in split_objects(section("parkingLocations")):
        mid = re.search(r"id:\s*'([^']+)'", obj)
        mname = re.search(r"name:\s*'([^']+)'", obj)
        mzone = re.search(r"parkZone:\s*LocationType\.(\w+)", obj)
        mp = re.search(r"pose:\s*\{([^}]*)\}", obj)
        spot = {"id": mid.group(1), **pose(mp.group(1))}
        if mname and mname.group(1) != mid.group(1):
            spot["name"] = mname.group(1)
        if mzone:
            spot["zone"] = mzone.group(1).lower()
        if mid.group(1) in entries:
            spot["entry"] = entries[mid.group(1)]
        parking.append(spot)

    locations = []
    for obj in split_objects(section("locations")):
        mid = re.search(r"id:\s*'([^']+)'", obj)
        mname = re.search(r"name:\s*'([^']+)'", obj)
        mzone = re.search(r"zone:\s*ZoneType\.(\w+)", obj)
        mpick = re.search(r"pickPose:\s*\{(.*?)\},?\s*\n\s*pickTurn", obj, re.S)
        mdrop = re.search(r"dropPose:\s*\{(.*?)\},?\s*\n\s*dropTurn", obj, re.S)
        loc = {"id": mid.group(1)}
        if mname:
            loc["name"] = mname.group(1)
        if mzone:
            loc["zone"] = mzone.group(1)
        if mpick:
            loc["pickPose"] = pose(mpick.group(1))
        if mdrop:
            loc["dropPose"] = pose(mdrop.group(1))
        if mid.group(1) in entries:
            loc["entry"] = entries[mid.group(1)]
        locations.append(loc)

    mimg = re.search(r"imageUri:\s*'([^']+)'", block)
    mh = re.search(r"height:\s*([\d.]+)", block)
    mw = re.search(r"width:\s*([\d.]+)", block)
    mo = re.search(r"origin:\s*\{\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*theta:\s*(-?[\d.]+)", block)
    underlay = None
    if mimg and mh and mw and mo:
        underlay = {
            "uri": "maps/" + mimg.group(1).split("/")[-1],
            "minX": num(mo.group(1)),
            "minY": num(mo.group(2)),
            "maxX": num(mo.group(1)) + num(mw.group(1)),
            "maxY": num(mo.group(2)) + num(mh.group(1)),
        }

    def tidy(value):
        # source mixes 3-decimal surveys with full-precision enum math;
        # millimeter precision is plenty for a fleet map
        if isinstance(value, float):
            return round(value, 3)
        if isinstance(value, list):
            return [tidy(v) for v in value]
        if isinstance(value, dict):
            return {k: tidy(v) for k, v in value.items()}
        return value

    site = {"name": "coalescent", "nodes": nodes, "links": links}
    if parking:
        site["parking"] = parking
    if locations:
        site["locations"] = locations
    if underlay:
        site["underlay"] = underlay
    site = tidy(site)
    with open(out_path, "w") as f:
        json.dump(site, f, indent=2)
        f.write("\n")
    print(f"nodes={len(nodes)} links={len(links)} parking={len(parking)} "
          f"locations={len(locations)} underlay={underlay is not None}")


if __name__ == "__main__":
    main()
